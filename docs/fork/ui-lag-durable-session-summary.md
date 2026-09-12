# 进会话 / agents 视图间歇 1–5 秒 · 修法与实测（2026-09-12）

> 适用范围：`merge/repl-kernel`，基线 HEAD `0429806b6`。
> 入口与背景：`FORK_NOTES.md`「2026-09-12 傍晚 · 进视图/进会话卡顿修复」；
> 缺陷定位报告（只读取证，未改代码）：`/tmp/ma_audit/ui_lag_measure.md`；
> 施工与验证全记录：`/tmp/ma_audit/build_ui_lag.md`。

## 一、病根（沿用定位报告的结论，本次已复核）

进 agents 视图 / 进会话时，守护进程要做一次 **O(存活子代理边数 × 转录字节数)** 的串行磁盘扫描：

| 落点 | 规模（本机实测） | 修前冷 |
|---|---|---|
| `rlm-ledger.ts` `withPassiveRlmDescendantInfos()`：每条存活边一次 `await readSessionInfo(child)` | 456 边 / 757 MB | 2078–2484 ms |
| `session-manager.ts` `listSessionsFromDir()`：sessions 目录逐文件串行扫 | 83 文件 / 430 MB | 1156–1312 ms |
| `daemon-mode.ts` `listPassiveRlmSubagents()`：`visit()` 递归里逐条 `await readSessionInfo` | 168 文件 / 305 MB（最大根子树） | 769–784 ms |
| 一次 `list_saved_sessions` 合计（= 开一次 agents 视图的守护进程侧成本） | 539 文件 | **3333–3373 ms** |

缓存只有 **进程内一层**（`sessionInfoCache`，键 `size+mtimeMs+ino`），所以「换进程就全冷」：
新 worker、catalog 子进程、守护进程重启、passivate→hydrate 循环，每一次都重付一遍。
冷热差实测 267×（同一次调用，命中 8 ms / 不命中 2164 ms）——这就是「间歇」的物理来源。
代码不是今天改坏的：数据涨了（存活边从 9/4 的一半涨到 456 条）。

## 二、修了什么

1. **持久层摘要缓存**（新增 `core/session-info-disk-cache.ts`）
   - `<agentDir>/session-info-cache/<sha256(转录绝对路径)>.json`，内容 = 一份 `SessionInfo` + 指纹。
   - **诚实性规则**：只有 `(dev, ino, size, mtimeMs)` 与扫描当时完全一致才发；**内容变了必然重扫**，
     与进程内缓存同一条判据（多一个 `dev`，因为 inode 只在同一卷内唯一）。
   - 只在**全量扫描**后写（增量续扫不写：活跃会话每次追加都会重写，而下个进程也用不上）。
   - 不 fsync（缓存丢了就是一次 miss，不是损坏）；temp+rename 原子落盘；目录 0700 / 文件 0600
     （摘要里含 `firstMessage`、`allMessagesText`，与转录同级私密）。
   - **只缓存代理自己的转录目录**（sessions 与 session-artifacts，含 realpath 拼写），
     其它路径（临时目录 fixture、导入的转录、用户自选路径）行为完全不变、零副作用。
   - 每周一次的后台清理（`prune-marker` 门控）：**只删能证明是垃圾的**——转录已消失、指纹已漂移、
     或内容解析不出来（temp+rename 之下解析失败只可能是真损坏）。
     **读不出来 ≠ 是垃圾**：`readFile`/`stat` 抛瞬时 errno 时保留条目，留给下一轮走查判定
     （否则会因一次 EMFILE 抖动静默删掉仍然新鲜的摘要，违背自己的注释）。
     顺带回收崩溃在 `writeFile` 与 `rename` 之间的 `.tmp` 残渣（按 mtime 超过 1 小时才收，
     年轻的可能是别的进程正在写）。
   - 写失败按 errno 分两类：**永久性**（EROFS/ENOSPC/EACCES/…）连续 3 次即本进程熔断；
     **瞬时性**（EMFILE/ENFILE/EAGAIN/EBUSY/EINTR/ENOMEM/ETIMEDOUT）不熔断，改指数退避
     （250 ms 起、30 s 封顶），退避窗内直接跳过写入（计入 `skipped`），窗口过后自动恢复——
     本模块自己把同进程 fd 压力放大了 8 倍（并发扫描），把一次描述符尖峰读成「这文件系统永远不行」
     会让长跑 daemon/worker 余生所有冷扫照常全量。
   - **摘要时间戳不可序列化时跳过该条目而不是抛**：`Date#toISOString()` 对 Invalid Date 抛 RangeError，
     而转录头部的 `timestamp` 恰恰可能不可解析（手工编辑/截断/第三方导入；加载路径本来就容忍它，
     `scanSessionInfo` 对 `modified` 早就有 `Number.isNaN` 回退）。一致性审查 F1 实证：
     未加守卫时一份坏时间戳转录会让**整个目录**的 `listAll` 在每次冷读时抛 RangeError、返回 0 条，
     直接证伪本节「任何缓存故障都不会让读失败」的声明。
   - 读永远降级为 miss；上述三条（不可序列化 / 超 512 KiB / 写失败）都只是「不缓存」，
     **任何缓存故障都不会让读失败**。
   - **删除即清**：`deleteSessionFile()` 成功后 `forgetSessionInfo()` 同时清进程内条目与持久条目；
     `deleteSessionArtifacts()` 在递归删除**之前**广度优先走一遍该目录（只进真目录、不跟符号链接），
     把被一起删掉的被动后代转录的条目也清掉，否则一个根被删会留下「每子一条」的孤儿等周清。
     删除路径的拼写可能与写入时不同（账本存 realpath、目录扫描存配置拼写），所以按
     「字面 + realpath（文件已删时退回父目录 realpath + basename）」两种拼写各删一次。
2. **并发化**（新增 `utils/map-concurrent.ts`，保序、限流、可按序流式回调）
   - `withPassiveRlmDescendantInfos`、`listSessionsFromDir`、`family()` 的 row 循环、
     `listPassiveRlmSubagents` 的 `visit()`（拆成「取元数据 → 串行准入判定 → 取摘要 → 按序发射+下钻」四段，
     准入判定仍串行按边序，`visited` 语义与深度优先前序输出都不变）。
   - `liveEdges()`：探测改成 in-flight 去重 + 并发；**并且把 `canonicalSessionPath()` 结果记忆化**
     —— 它是阻塞的 `realpathSync`，同一条边原先被规范化 3 次。
     坑：**只加并发不加记忆化反而更慢**（实测 repeat 24.6 ms → 44 ms），因为 realpath 在主线程串行。
3. **客户端两处**（`agents-view/`）
   - 250 ms 动画定时器不再 `rebuildRows()`（重建 = 重过滤+重汇总+重嵌套+重排序，536 条记录实测 24–28 ms），
     改为 `refreshAgentsViewRowTimeLabels()` 就地重算时间派生的 `statusLabel`；合成行（subagent-summary /
     subagent-code 挂的是父行 summary、标签恒为空）跳过，避免凭空造文案。
   - `resolveMissingSelectionAnchor()` 对「目录刷新在飞」的一票否决改成**停滞即放行**：
     死线 `SELECTION_ANCHOR_REFRESH_GRACE_MS = 2000` 从「锚点最近一次被重新武装」起算，
     动画 tick 与 `openSelected()` 都会踩它。
     **如实说明边界**：流式期间每次 reconcile（节流 50 ms）都经 `restoreSelection()` 重新武装 pending
     并刷新起点，所以目录**在持续到货**时 Enter 仍会等完整轮刷新（上限 = `list_saved_sessions`
     自己的 30 s RPC 超时），2 s 兜底只在刷新**停住不动**（RPC 卡死 / 长时间无数据）时才放行。
     这**不是回归**（原逻辑是无条件等到刷新对象活着的最后一刻），改的是「永久死路」→「停滞即放行」；
     真正让这条路径变短的是 §2.1/§2.2：目录到货时间从 2.2 s 降到 0.13 s，等待窗本身缩了 17 倍。
     该重新武装语义有测试钉住（`re-arms the wait on every reconcile that still cannot find the anchor`）。

**总闸遵守**：没有少显示任何子代理、没有少读任何转录、没有降低搜索/用量/拓扑能力；
E2E 落定行数修前 82（被动后代那条腿还没到就被判「落定」）→ 修后 97（全量到齐）。

## 三、实测数字

方法同定位报告：① 组件级 = 每场景一个全新进程（进程内缓存冷、OS page cache 热），
只读真实数据的 APFS clone（`/tmp/uilag_home`，83 根会话 430 MB + 456 存活边 757 MB，账本路径重写）；
② 端到端 = tmux 200x50 驱动 `agents` 视图，`capture-pane` 每 28 ms 打点。
两套 build（基线树 / 修后树，均 `git archive 0429806b6` + node_modules 符号链接后各自 `npm run build`）
在同一台机、同一负载窗内背靠背跑。

### 3.1 组件级（3 次重复，取全部值）

| 指标 | 修前 | 修后 | 倍数 |
|---|---|---|---|
| 一次 `list_saved_sessions`（全新进程，539 文件） | 3349 / 3333 / 3373 ms | **173 / 138 / 129 ms** | **25×** |
| 同上，进程内热重复 | 40.6 / 42.1 / 41.0 ms | **26.0 / 26.8 / 27.4 ms** | 1.5× |
| `withPassiveRlmDescendantInfos`（456 边 / 757 MB） | 2484 / 2078 / 2108 ms | **46.0 / 48.9 / 45.9 ms** | **46×** |
| sessions 目录扫描（83 文件 / 430 MB） | 1312 / 1180 / 1156 ms | **19.4 / 19.8 / 19.4 ms** | **60×** |
| 最大根子树（168 文件 / 305 MB） | 784 / 778 / 769 ms | **17.6 / 20.4 / 18.4 ms** | **42×** |
| `liveEdges()` 首次（含 1 MB 账本重放） | 87.2 ms | 78.6 ms | 1.1× |
| `liveEdges()` 重复（纯探测） | 24.6 / 23.9 ms | **15.1 / 15.8 ms** | 1.6× |
| 修后·持久缓存**空**时的首次（539 次全量扫描 + 建缓存） | — | 3515 ms | ≈ 修前 |

修后冷读的层构成：`diskHits=539, fullScans=0`（一次都不重扫）。
持久缓存体积：708 条 / 8.4 MB（对应 1.5 GB 转录，约 0.55%）。

**验收口径**：冷进视图（守护进程侧目录成本）**129–173 ms < 500 ms** ✅；
热（进程内重复）**26–28 ms < 100 ms** ✅。

### 3.2 端到端（tmux + 各自 build 的 bundle）

| 指标 | 修前 | 修后（持久缓存已建） | 修后（缓存空，首次） |
|---|---|---|---|
| 守护进程冷：Enter→聊天界面 | **5253 / 5243 ms** | **233 / 221 / 223 / 221 ms** | 5259 / 5261 ms |
| 守护进程冷：视图出现→行数落定 | 1707 / 1748 ms | 869 / 858 / 627 / 621 ms | 812 / 816 ms |
| 守护进程冷：落定时行数 | 82（**不全**） | 97（全） | 13（流中途假落定） |
| 守护进程热：Enter→聊天界面 | 201 / 208 / 190 ms | 206 / 208 / 203 / 192 ms | 207 ms |
| 守护进程热：视图出现→行数落定 | 449 / 486 / 582 ms | 641 / 556 / 517 / 561 ms | 449 ms |

- 冷启动行数轨迹：修前 `7→8→10→11→13→14→37→38→48→51→55→58→59→66…`（1707 ms 内还在爬，最终只到 82）；
  修后 `20→48→52→68→82→97`（**279 ms 内到齐**）。
- 同机同 harness 的**受控 A/B**：修后 build 把持久缓存目录删掉再冷跑 = 5259/5261 ms，
  与基线 5253/5243 ms 一致 ⇒ 那 5 秒确实是「摘要没落盘 ⇒ 每次换进程全量重扫」造成的，
  缓存建好之后同一条路径 221–233 ms（**23.7×**）。
- 守护进程**热**的 Enter→聊天 两边都是 ~200 ms，没有变化：这一档的地板是**转录本体水合**
  （被打开的是最大的那个根会话，81 MB / 8.5 万条，`loadEntriesFromFileAsync` 实测 248 ms，无缓存），
  即定位报告排第 4 的「常数项」。不靠少读转录就压不下去，故本次不动，留作后续（见下）。
- 冷启动的 `启动→视图出现` 两边都是 4.4–4.5 s，**与本修无关**：harness 用 `kill -9` 杀守护进程，
  日志里是 `supervisor probe failed (attempt 1..3/3)` → `launched replacement supervisor` →
  `Daemon supervisor startup failed: Error: Lock file is already being held` 的锁恢复循环，
  两个 build 同样付这份钱，故冷档只看「视图出现之后」的窗口与 Enter→聊天。

## 四、验证

- **先红后绿**：首交的 6 个测试文件在基线树 `0429806b6`（`git archive` + node_modules 符号链接）上
  **6 文件全红、9 条断言失败**；同批文件在修后树上全绿（首交 33 条 → 随访 37 条 → 一致性审查这轮 **7 文件 46 条**）。
  本轮（一致性审查 F1/F4/F5）同样是先红后绿：F1 用审查车道自己的复现脚本
  `/tmp/ma_audit/repro_invalid_ts.mts` 先证「`readSessionInfo` 抛 RangeError、`listAll` 返回 0 of 3」，
  修后同一脚本输出「direct read returned / listAll returned **3 of 3** / writes=2 skipped=1」；
  F4 退避与 F5 prune 各有一条断言级红（`writeErrors` 2≠1、`pruned` 1≠0）。
  其中最有信息量的两条红是断言级而非导入级：
  `expect(probe.peak()).toBeGreaterThanOrEqual(2)` 收到 `1`（串行扫描）、
  `expect(existsSync(cacheDir())).toBe(true)` 收到 `false`（摘要不落盘）。
- **变异 19 处：18 杀 + 1 判定为等价变异**（改一处 → 目标测试必红 → 还原）：
  M1 不读持久层 / M2 去掉指纹校验 / M3 被动合并限流改 1（退回串行）/ M4 回调不按序发射 /
  M5 合成行也重算标签 / M6 恢复「刷新一票否决」/ M7 任意路径都缓存 / M8 从不落盘 /
  M9 删除后不清条目（3 条红）/ M10 删根时不清后代条目（1 条红）/ M11 anchor 死线不再重新武装（1 条红）/
  **M12a 整体回退 F1 修法**（wire 构造挪回 try 之外 + 裸 `toISOString()`，毒列表那条红）/ **M13 瞬时 errno 也走永久熔断** /
  **M14 退避窗内照写不误** / **M15 prune 把读不出来当垃圾删** / **M16 去掉 512 KiB 上限** /
  **M17 去掉 prune-marker 周门控** / **M18 不回收 `.tmp` 残渣**（各 1 条红）。
  M2、M7、M9、M10、M12a、M15 是**正确性/卫生方向**而非性能方向的变异。还原后同一批 46 条重新全绿。
  **M12b（只摘 `toIsoString` 守卫、wire 仍留在 try 内）存活 —— 判定为等价变异，不计杀**：
  RangeError 被同一个 `catch { stats.skipped++; return; }` 接住，可观测结果（不落盘 + `skipped` 加一 + 读照常返回）
  与有守卫时逐字相同。守卫与 try 是两层防护，任一层单独成立；保留守卫是为了不拿异常当控制流、意图写在脸上。
- **回归**：`test/session-manager/` 全目录 + session-info + rlm-ledger + agents-view + daemon-catalog +
  saved-session-catalog + daemon-session-list + session-lease + session-artifacts-delete = **39 文件 467 条全过**；
  `daemon-mode` + 全部 `daemon-supervisor-*`（不含 process 版与 4603）= **18 文件 429 条全过**。
  合计 **57 文件 896 条**（随访两条落地后复跑）。env 已净化（`env -u RLM_* -u PRIME_AGENT_INTERNAL_* …`，
  且 `PRIME_AGENT_CODING_AGENT_DIR` 指向 /tmp，测试不写真实 `~/.prime`）。
- `npm run check`（biome 全仓 + tsgo + installer + browser-smoke）、`npm run check:test-hygiene`（无新增私探）、
  纯净树 `git archive HEAD | tar -x` + `npx tsgo --noEmit` 均 EXIT=0。
- 未跑 `test/suite/regressions/4603-worker-recovery.test.ts`（按指令禁跑）。

## 五、残留与后续（本次未动，均有据）

1. **转录本体水合 248 ms / 81 MB**（报告 #4）：热档 ~200 ms 的地板。要压只能改 attach 的传输/水合策略
   （`slim_attach` 已有能力门），属于「少传」而不是「少读」，需要单独一轮。
2. **账本重放 ~65 ms/进程首次**：`replaySync()` 每次账本变化都整份重读重解析（1 MB / 3199 行）。
   可做「按字节偏移增量重放 + 截断即全量」，但账本是拓扑权威，风险单独评估。
3. **`liveEdges()` 的 536 次 stat ≈ 15 ms**：libuv 线程池默认 4，并发再高也压不下去；
   要再降需改成「按目录一次 `readdir` 批量判在」，但子代理转录是一子一目录，收益有限。
4. **客户端全量 reconcile 35 ms/次**：本次没改节流窗（50 ms）。因为守护进程侧从 3.3 s 降到 0.13 s，
   流式窗内的 reconcile 次数从约 40 次掉到约 3 次，1.4 s 的同步阻塞自然消失（E2E 窗口 1707→627 ms 已含此效应）。
5. **运维侧仍可再降绝对值**（不改代码）：归档 `session-artifacts`（4.9 GB / 1996 份子代理转录）与账本死边。

## 六、一致性审查（sweep_meta）随访这一轮

审查车道 `/tmp/ma_audit/sweep_meta.md` 在本模块面上开了 5 条（F1–F5）+ 2 条观察级（F7），逐条处置：

| 编号 | 判定 | 处置 |
|---|---|---|
| **F1**（必修） | 成立，已用审查方脚本活体复现 | `writeCachedSessionInfo` 把 wire 构造整体挪进 try，并新增 `toIsoString()`：Invalid Date → 跳过该条目（计 `skipped`），**不抛**。回归测试「坏时间戳转录在场时 `listAll` 仍返回全部 3 条」先红（`RangeError: Invalid time value` @ disk-cache:260）后绿。**没有**顺手改 `scanSessionInfo` 里 `created` 的语义：坏头部返回 Invalid Date 是加载路径的既有行为（`modified` 早有 `Number.isNaN` 回退、`created` 一直没有），改它会影响排序与显示，属另一件事，登记在 §五 残留 |
| **F2** | 成立 | 删掉 `packages/coding-agent/.changes/ma-batch4-pending-delivery-queue.md` 里与 `ma-batch4-send-drain-exemption.md` 重复的那条 bullet（保留信息更全的独立文件）；复核四个包的 fragment：263/24/18/5 条 bullet，**精确重复 0、70 字归一化前缀近重复 0** |
| **F3** | 成立 | 给 `packages/tui/.changes/` 补两条一行 fragment：`stdin-paste-linear-sequence-scan.md`（f6cf52f58 的 stdin-buffer 二次方）、`truncated-text-render-cache.md`（781d91985 的叶子组件 render-cache）；逐字核过对应 diff 才写的措辞 |
| **F4** | 成立 | ① 熔断按 errno 分类：永久性连续 3 次才熔断，瞬时性（EMFILE/ENFILE/EAGAIN/EBUSY/EINTR/ENOMEM/ETIMEDOUT/EWOULDBLOCK）改指数退避 250 ms→30 s 且**自动恢复**（半开）；② 三条自证声明补断言：熔断（永久 3 次即停 + 之后不复活）、512 KiB 跳过、prune-marker 周门控 |
| **F5** | 成立 | prune 把「读不出来」与「内容损坏」分成两个判决：`readFile` 抛错 → 保留（下轮再判）；`stat` 源文件抛**瞬时** errno → 保留；只有解析失败/源已消失（ENOENT）/指纹漂移才删。附带回收 `.tmp` 残渣（>1 h） |
| **F6** | 不属本车道（是别的提交穿错标签） | 未动，转告父代理 |
| **F7** | 观察级，顺手做了 | ① 孤儿 JSDoc 归位到 `isSessionInfoDiskCacheable` 头上；② `.tmp` 残渣纳入 prune（见 F5）；③ 内存键用原始拼写 / 磁盘键用 `resolve()` 拼写：维持设计内不变 |

新增测试 9 条（`session-info-disk-cache.test.ts` 13→16、新文件 `session-info-disk-cache-faults.test.ts` 6 条，
后者用 `vi.mock("node:fs/promises")` 注入指定 errno，配 fake timers 走退避窗）。
新增变异 7 处（M12–M18），全部被杀。
