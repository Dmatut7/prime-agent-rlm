# 安全簇方案（凭证外发面 / 供应链校验）—— wave-44 重写为拍板形态

- 立项来源：`docs/fork/swarm-loop-plan-20261001.md:31,123-124`、`docs/fork/evolution-ledger.md:86`（Backlog #16，硬约束：先写方案问老板）。
- 历史：wave-29 初稿（现状核验+选项）→ wave-40/43 已落地一批（见第一节）→ wave-44 重写：已落地的销账备案，待批的逐条给「问题/证据/选项/工作量/优先级/推荐」，老板按第二节末尾速勾表一次批完。
- 本文是纯方案，不含代码改动；拍板后由后续波次执行。

## 一、已落地清单（无需拍板，备案销账）

| 件 | 落地 | 证据 |
|---|---|---|
| traces 上传隐私门（原 13a「零脱敏」已修） | 2026-09 月波次 | `9441a8899`+`006476f05`：自动上传与 `/traces upload` 都过 `applyUploadPrivacyGate`（`agent-traces.ts:1169`），URL userinfo 剥离 → 23 种密钥形状检测（`share-secret-detectors.ts:65-93`）→ 本会话配置值精确比对（auth.json/models.json/settings.json/凭证名 env）。opt-in 门 `agentTraces.enabled` + `DO_NOT_TRACK`/`PI_OFFLINE` 否决 |
| auth.json 0600（原 13b 已修） | 同上 | `f905dc8f8`：`auth-store.ts` 走 `writePrivateFileAtomic`（0600+symlink 拒绝+原子替换）；本机实测 `-rw-------`、父目录 `drwx------` |
| update 绝对 URL 哈希+白名单（原 12a） | 同上 | `d3945cb68`+`9574439ea`：可信 origin 白名单 + sha256 pin；`install.sh` 校验 SHA256SUMS |
| fd/rg 钉版+sha256（原 12b） | 同上 | `d3945cb68`：tools-manager 钉 fd v10.5.0/rg 15.2.0，校验后才执行；浮动解析降级 opt-in 仍强制 digest |
| min-release-age CI 门（原 12c） | 同上 | CI pin `npm@11.12.0` + `check-npm-release-cooldown.mjs` |
| 推送前敏感信息扫描器（wave-40 审查第 0 条的预防半） | wave-40 | `scripts/pre-push-secret-scan.mjs`：提交说明+diff 过 23 类密钥/邮箱/语境 UUID，挂 `.husky/pre-push` 与 check 链；全历史 6731 提交回扫只钉出事故提交 `fd1dd4e4c`、零误报；fail-closed；逃逸 `PRIME_AGENT_ALLOW_SECRET_PUSH=1` |
| retention 不误删记忆/图片 | wave-40 | 存储超限只回收内核快照，永不删记忆与图片 |
| bash 守卫包装壳解包 | wave-43 | `8c1da0fd2`：`bash -c`/`sh -c`/`eval` 包裹剥一层再判定，TS+内核 Python 双面；残余绕过面（嵌套、`$(...)`、env/xargs）已写进守卫注释 |
| 扩展钩子 fail-closed 钉 | wave-43 | `2342e519b`：工具调用被扩展拦截出错/超时=阻断（与 CC 2.1.288 同款裁决），测试钉死 |

扫描器已知不覆盖面（登记，建议不立项）：`CREDENTIAL_ASSIGNMENT`/`HIGH_ENTROPY` 两个推断族未进 blocking 门（校准面向警告场景，硬门误拦代价高）；annotated tag message 不扫（v-tag 禁令已挡）；二进制 blob 不扫。

## 二、待批项（逐条：问题 / 证据 / 选项 / 工作量 / 优先级 / 推荐）

### 1. 脱敏 4 变体（wave-42 调研新增，CC 2.1.286 修复族对照）

- **问题**：`/share` 与 traces 上传共用的脱敏层在 4 个编码变体下可绕过，凭证以变形形态出机。
- **证据**（CC 2.1.286 changelog 原文：percent-encoded Bearer 只遮住一半 / 键名含零宽字符的 secret 出现在已脱敏日志 / URL 密码含 `)` `"` `]` `&` 第二 `@` 或跨 `/` 到 `[::1]` bracket host 时部分泄漏）。本仓 HEAD 实测：
  - a. **百分号编码 Bearer**：`Bearer%20<token>` 不命中 `\bBearer\s+`（`share-secret-detectors.ts:74`；pre-push 扫描器复用同表 `scripts/pre-push-secret-scan.mjs:88`，一并漏）。
  - b. **零宽字符键名**：`PASS\u200BWORD=x` 逃逸（`\u200B` 不在 JS `\s` 也不在名类，`CREDENTIAL_NAME` 被拆断，`share-secret-detectors.ts:104-108`）；`API\u200BKEY=x` 恰好尾巴 `KEY` 命中属侥幸。
  - c. **URL 密码含 `/`（ssh URL + bracket IPv6 host）或引号**：userinfo 剥离整体失效——`ssh://user:pa/ss@[::1]/x`、`https://user:pa"ss@host/x` 原样通过（`upload-privacy-gate.ts:46` 的 userinfo 类排除 `/`/`"`，失配即不剥离）。
  - d. **密码含 `)`/`]`**：CREDENTIAL_ASSIGNMENT 值类在 `)`,`]` 处截断到 8 字符地板以下，整个匹配丢弃（实测 null）。第二 `@` 已被贪心 last-@ 覆盖（`upload-privacy-gate.ts:44` 注释+实测），CC 列表里这一项本仓无需修。
- **选项**：A. 四变体全修（Bearer 接受 `%20`/`+`、键名零宽归一化、userinfo 解析改用「最后一个 `@` 前的整段 + 至少允许 `/` 与引号入密码」、值类对 `)`/`]` 放行），先红后绿；B. 只修 a+c（最可能在真实语料出现的两形态），b/d 登记；C. 不修，靠「本会话配置值精确比对」兜底——但那只管自己配置过的值，管不了会话里出现的他人/临时凭证。
- **工作量**：A ≈ 1 lane-波（`share-secret-detectors.ts` + `upload-privacy-gate.ts` 两文件 + 扫描器 drift guard 同步；测试基建 `share-secret-export-scan.test.ts`/`upload-privacy-gate.test.ts` 现成）。
- **优先级**：高（主动外发闸；CC 同版本连修三条说明这些变体在真实日志语料里确实出现）。
- **推荐：A**。理由：这是凭证出机前最后一道形状闸，改动集中在两个文件、测试现成，半修（B）留下的恰是「看起来已脱敏」的假安全感。

### 2. 服务端 revoke（登出只清本地）

- **问题**：`/logout` 只删本地 auth.json，服务端 token 活到自然过期；本机泄露后登出不能止损。
- **证据**：2026-09-14 审计残余登记，当时判 low。
- **选项**：A. 维持现状+文档注明「登出=本地删除」；B. 立项加 revoke 端点调用（OAuth 系有 API、API-key 系多数没有，覆盖不全会造成半 revoke 假安全感）。
- **工作量**：A 零代码（一句文档）；B 动 `packages/ai` oauth 层+各 provider，跨包。
- **优先级**：低。
- **推荐：A**。理由：多数 provider 无 revoke API，B 只能半覆盖；泄露止损的正路是去 provider 控制台轮换 key，文档说清即可。

### 3. at-rest 明文（sessions jsonl / kernel-state.dill）

- **问题**：会话与内核快照落盘明文，靠 0600/0700 文件权限挡。
- **选项**：A. 维持现状（与 SSH 私钥同模型：本机被读=全泄，这正是 traces 隐私门存在的前提）；B. 落盘前 scrub/加密——误伤会话内容、`kernel-state.dill` 二进制序列化难做、有破坏会话可恢复性的风险。
- **工作量**：B 动 session-manager 落盘路径+repl.py 快照路径，两包+Python 侧，大。
- **优先级**：低。
- **推荐：A**。理由：威胁模型与 SSH 私钥一致；B 的成本和可恢复性风险换不到对等收益。

### 4. logger 脱敏兜底

- **问题**：logger 无形状过滤，未来某处误打凭证变量无兜底（现状已扫过：109 处调用无凭证变量）。
- **选项**：A. 维持现状；B. logger 层加形状过滤（复用 `SHARE_SECRET_PATTERNS`）。
- **工作量**：B 小（logger 单文件+复用表），但有误伤调试输出的校准成本。
- **优先级**：低。
- **推荐：随项 1 顺带做 B，不单独立项**。理由：项 1 动同一张 detector 表，顺手接进 logger 的边际成本最低；若项 1 批 N 则本项维持 A。

### 5. 12d 残余：默认 12 包 hash pin（prime-agent-runtime venv 引导）

- **问题**：`DEFAULT_RLM_EXTRA_PACKAGES`（requests/pandas/…）只 `==` 钉版本不钉 hash；同版本内容被替换（PyPI 端被攻破/yank 重发）无防御。registry 裸名默认拒绝已落地，残余仅此。
- **选项**：A. `--require-hashes`+按平台多 hash 表（每平台 wheel hash 不同，维护活）；B. 出货路径改用 `uv.lock` 并把锁身份并进 venv 代际哈希；C. 维持版本 pin（PyPI 正常不允许同版本重传，残余窗口仅 PyPI 端事故）。
- **工作量**：A/B 中（`bootstrap.ts`+`kernel-runtime-pinning.test.ts` 基建现成；hash 表是持续维护项）；C 零。
- **优先级**：中低。
- **推荐：C**。理由：版本 pin 已防「静默装新版」，hash 防的是 PyPI 自身事故，对本 fork 单用户场景维护 12 包×多平台 hash 表不成比例；威胁模型变了再升 A/B。

### 6. `prime-agent-runtime` PyPI 占名

- **问题**：PyPI 名未注册，抢注窗口开着；现状靠「默认拒绝 registry 安装」兜底，只有显式 opt-in（`PRIME_AGENT_KERNEL_ALLOW_REGISTRY_RUNTIME=1`）+手工 pin 的用户会踩。
- **选项**：A. 老板手动注册占名（传最小占位包，5 分钟，永久消除）；B. 不占名靠兜底。
- **工作量**：A 仓外 5 分钟，无代码。
- **优先级**：高（零成本消除一个永久窗口）。
- **推荐：A**。理由：5 分钟换永久关窗，没有不占的理由。

### 7. 12e：uv 引导链 pin+校验

- **问题**：`bootstrap.ts:80`（现 `core/kernel/bootstrap.ts`）仍 `curl -LsSf https://astral.sh/uv/install.sh | sh`——无版本 pin、无校验和，astral.sh/GitHub 被攻破即首跑种马（round-36 F7 判 P2/P3）；CI 两处 `pip install --user uv` 无 pin（`ci.yml:333`、`nightly-process-stress.yml:46`）。
- **选项**：A. 产品侧 pin uv 版本+下载后 sha256 校验（直接下 GitHub releases tarball+仓内置 hash 表，复用 tools-manager 的 fd/rg 同款模式），CI 两处 `uv==x.y.z` pin 顺带；B. 只 pin CI 两处，产品侧维持 curl\|sh 但把交互确认提示修到真可达；C. 维持现状（非 TTY 拒绝已存在，`PRIME_AGENT_INSTALL_UV=1` 是显式 opt-in）。
- **工作量**：A 中（`bootstrap.ts`+hash 表+测试；pin 升级是手工活）；B 小。
- **优先级**：中高（供应链面里剩下的最大口子）。
- **推荐：A**。理由：curl\|sh 无校验是「下载即执行」的裸链路，fd/rg 已有同款 pin+sha256 模式可照抄，一次立项把产品侧和 CI 一起收了。

### 8. 12f：package-lock 卫生（216/426 条目缺 resolved+integrity）

- **问题**：HEAD 实测 426 个非 workspace/link 条目中 216 个缺 `resolved`/`integrity`（样本 `@babel/runtime`、`@mistralai/mistralai`），影响可复现性/审计强度；`npm ci` 不报错，正确性无碍。
- **选项**：A. npm 11 重新生成 lock 补齐+CI gate 防回归（diff 巨大，须与在飞 lane 串行、纯净树复验）；B. 只加 CI 检测脚本登记数量基线，只缩不增（test-private-probe-baseline 同款模式）；C. 接受现状。
- **工作量**：A 大（全量依赖重解析+全量测试验证+lane 协调）；B 小。
- **优先级**：低中。
- **推荐：B**。理由：正确性无碍，缺的成因未查明；先基线门止血防恶化，全量重生成（A）留给没有并行 lane 的窗口单独做。

### 9. containment 横向簇（对抗性模型/注入后的权限边界）

- **问题**：RLM 内核 in-process 执行模型生成的 Python，持本进程全部用户权限（无沙箱）；组织记忆/kernel-state 跨会话持久（投毒面）；子代理结果回注父上下文（trust escalation 通道）。两篇外部参照（Anthropic 2026-05-25 容器策略文、Matthew Green 2026-09-30 沙箱充分性文）的落点都指向 egress 控制+文件系统边界。
- **选项**：A. 不立项，登记「已知接受的风险」（本 fork 单用户研究工具，威胁模型不含对抗性模型）；B. 立「设计先行」项（egress/文件系统分级/记忆投毒分类器/子代理信任降级的原语选型设计文档）；C. 只做最便宜三件（记忆分类器评估、子代理结果信任级标注、文档化威胁模型）。
- **工作量**：A 零；B/C 是新设计簇（跨 runtime TS+Python/agent-session/harness），不是修复。
- **优先级**：低（按当前威胁模型）。
- **推荐：A**。理由：单用户研究工具的威胁模型不含对抗性模型，B/C 的工程量与当前风险不匹配；威胁模型变化（多用户、不可信输入源接入）时再启 B。

### 10. 事故提交 `fd1dd4e4c` 历史改写（wave-40 审查第 0 条本体）

- **问题**：该提交说明里嵌了 `claude auth status` 的 JSON 输出（账号邮箱、orgId UUID、orgName、订阅类型），已在 origin 公开。预防半（推送前扫描器）已上线；本体=是否改写公开历史仍是老板挂账。
- **选项**：Y. filter-repo 改写+force push（所有 clone/本地分支要重对齐，并行 lane 纪律下是一次全员协调事件）；N. 不改写，内容视为已公开低敏感信息（邮箱+组织 ID，非可用凭证），登记销账。
- **工作量**：Y 大且有一次性协作成本；N 零。
- **优先级**：低。
- **推荐：N**。理由：泄的是邮箱/组织 ID 不是可用凭证，止损价值低；改写公开历史破坏所有下游副本且全历史回扫已证只此一笔，预防半保证不再发生。

### 11. 销账与文档同步

- **问题**：`evolution-ledger.md` Backlog #16、`swarm-loop-plan-20261001.md` 域 7 两条、`2026-09-14-fixes.md` 仍按旧快照登记「未修」。
- **推荐：Y**。理由：拍板结果落定后由下一波同步三处登记，安全簇挂账关闭。

## 三、拍板速勾表

| # | 项 | 推荐 | 老板批 |
|---|---|---|---|
| 1 | 脱敏 4 变体 | A（全修） | Y/N（N 请圈 B/C） |
| 2 | 服务端 revoke | A（维持+文档） | Y/N |
| 3 | at-rest 明文 | A（维持） | Y/N |
| 4 | logger 脱敏 | 随项 1 顺带 | Y/N |
| 5 | 默认包 hash pin | C（维持版本 pin） | Y/N（Y 请圈 A/B） |
| 6 | PyPI 占名 | A（老板 5 分钟） | Y/N |
| 7 | uv 引导链 pin+校验 | A（产品+CI 一起） | Y/N（只做 CI 请圈 B） |
| 8 | lock 卫生 | B（基线门） | Y/N（全量重生成请圈 A） |
| 9 | containment | A（登记已知风险） | Y/N（Y 请圈 B/C） |
| 10 | 历史改写 | N（不改写） | Y/N |
| 11 | 销账同步 | Y | Y/N |

## 四、执行备注（拍板后给实施波次）

- 全部项均不动 daemon wire 类型；若实施中发现需要，先报主席。
- 项 1 测试基建现成（`share-secret-export-scan.test.ts`、`upload-privacy-gate.test.ts`、`upload-privacy-gate` 单测），按先红后绿；扫描器 drift guard（`check-secret-scan.mjs`）逐条比对 detector 表，表改动会联动，属预期。
- 项 5/7 测试基建现成（`kernel-runtime-pinning.test.ts`、`tools-manager-pinning.test.ts`）。
- 项 8 动 `package-lock.json` 前必须与在飞 lane 串行（共享文件纪律），纯净树复验。
- 项 6 是仓外操作，无代码；完成后回链证据（PyPI 页面截图/包名）进 FORK_NOTES。
