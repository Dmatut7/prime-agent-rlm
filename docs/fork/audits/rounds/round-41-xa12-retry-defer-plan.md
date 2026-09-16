# r41 簇A 方案书 v2：三套「可重试」口径统一（XA-1 + XA-7）· defer 有界性与时钟基（XA-2）· ran/skipped/deferred 三态记账

> v2 增补：纳入 0902 终审 §8 XA-7（P1）——「可重试」实为**三**套互斥口径（typed 字段 / 字符串清单 / instanceof 清单），根因是两个正交命题被压成一个布尔。v1 的轴①②③结论保留，字段命名与消费面按两字段契约重写，并新增轴④（字符串清单降级）。父席 0902 给的最小修复面在 §3 逐条覆盖并给出一处更好替代（D1b）。

- 角色：方案会成员（只出修法，不写代码、不开工作树）。仓 `/Users/a1/Desktop/ai/prime-agent` 只读，零写入。
- 冻结读面：HEAD `887c15b44`（= `eb0825e63` + 两条 docs 提交；终审报告已并入 HEAD）。行号全部按此 HEAD 实读。
- 输入：`final-crossreview.md` §2 XA-1/XA-2、§7.1、§8 XA-7（resid-runs 探针 A + 0902 独立复核）；`punch-fence.md`（A/B/C/D 四组实测，EXIT=0）；`impl-tc.md`（TC 施工在 `/tmp/audit_r/round-41/wt-tc`，提交 `5b19b6c79`，**未进 HEAD**，基线 `15143be42` 早于 r40 K3Q-3）。

### 0. 三套口径与关键代码事实（全部 HEAD 逐字复核）

| 口径 | 位置 | 栅栏态 Suspended | 挂起态 Suspended | Paused / Coalescing |
|---|---|---|---|---|
| ① typed 字段 `retryable` | `prompt-admission.ts:19`（字段声明 `:10/:46/:67`） | false | true | true |
| ② 字符串清单 | `agent-messages.ts:823-843` `isRetryableAgentMessageSendError`（`:827 /queued session input is suspended/i` 裸前缀两种都中） | **true** | **true** | true（`:833/:836`） |
| ③ instanceof 清单 | `prompt-admission.ts:89-93` | false | **false** | true |

- ②的生产消费三处：`agent-messages.ts:1084-1089 rememberFailure`（判 true ⇒ return 不记 uncertain ⇒ messageId 未花掉）、`:1147-1152` 广播 uncertain 判定、`agent-session.ts:13113-13135 _terminalizeRepeatedAgentMessageSendFailure`（M6b 三连击穿计数，`AGENT_MESSAGE_RETRYABLE_FAILURE_LIMIT=3`，`agent-session.ts:1327`；入口 `:4161-4168`）。②的注释 `:815-821` 自认「worth retrying ≡ provably delivered nothing」——**该等价在栅栏态不成立**。
- ③的生产消费三处：`cron-jobs.ts:1312`（queueDispatch catch）、`daemon-mode.ts:2013`、`:2061`（runCronJob 两 catch）。XA-1 打穿实证（punch-fence，纯净树 EXIT=0/4 passed）：A 栅栏 once → `completed/runCount:1`（从未执行）；C recurring+栅栏 → `runCount:1+lastError`；D 挂起档（字段 true）→ 同样烧掉；B Paused 正控 → 正确 defer（`nextRunAt=tick+5s`）。
- 记账单点：`cron-jobs.ts:852-910 recordDispatchResult`（生产唯一记账入口；`recordRunResult/recordSkipResult` 已无生产调用者）。deferred 分支 `:879-896`：once → `now+CRON_DEFERRED_RETRY_MS(5s)`（`:195` 全仓唯一消费点；无计数、无上限、无升级）；默认分支 `:897-905`：runCount+1/lastRunAt/lastError/once→completed。
- 臂卫生：`cron-jobs.ts:1346-1385 scheduleNext` = 墙钟差 + `setTimeout` **无 unref**（TC-2/TC-3 未进 HEAD；wt-tc 版本已有 `schedulerNowMs()` + 醒时 `max(schedulerNow, armedAt+armDelay)` + `this.timer.unref()`）。
- 栅栏语义链：`agent-session.ts:7948-7973`（栅栏优先于 pause lease）；`abortForUpdateRestart()` `:9680-9700` 同时架栅栏+拿 pause lease（**排队路径拿 Paused①=true，直连路径拿 Suspended①=false**——同一窗口两把钥匙）；`requestAbort()` `:9574-9581` 把栅栏降级为普通悬挂（D case 的来源）。
- 「未花掉=可重发」面：`agent-messages.ts:1044-1058 formatUncertainAgentMessageResendError`（id 已花掉才拒重发）、`:846-856 formatAgentMessageRetryExhaustedError`（烧完预算的终局引导）。
- 字符串测试面（改写时命题不弱化的对照面）：`r39-qp.test.ts:190-254`（含 `:227` 栅栏窗口排队路径 Paused 断言 `err.retryable===true`）、`f1-agent-message-wakes-suspended-pump.test.ts:154`、`agent-message-queued-receipt.test.ts:112-124`（含裸前缀 `:116`）、`agent-message-bounded-wait.test.ts:152-166`、`agent-message-duplicate-window.test.ts:93`。
- store 兼容性硬事实：`isAgentCronJob`（`cron-jobs.ts:2311-2350`）**忽略未知字段**（加可选字段=新旧互通）；status 枚举被硬校验（**新增 status 值会被旧读者整条丢弃**——升级态必须用 active+lastError 表达）；`AgentCronJob` 过 daemon wire 无校验直投（`daemon-command.ts:1726-1731`）。
- 消息文本是跨进程序列化面：Suspended 的 message 内嵌 `retryable=${retryable}` 与栅栏说明句（punch-fence A/D 逐字）；Paused/Coalescing 无内嵌标志，靠稳定子串。

---

## 1. 根因复述（一句话）

- **XA-1+XA-7（合并根因）**：三个正交命题—— 单次尝试有没有投递/入队任何东西 (b) 现在重试能不能成功（本进程内，不重启） (c) 这次 tick 算不算跑过——被三套互斥的「retryable」口径各压成一个布尔，且 ②的成文注释自认其 (a)≡(b) 等价在栅栏态不成立 ⇒ 同一次栅栏拒绝让子代理回执账说「未花掉、去重发」（②true）、让 cron 账说「跑过了、once 已完成」（③false）、让 typed 契约说「本进程重试永不成功」（①false）；(c) 在 cron 侧被 ③ 间接回答成 ran。
- **XA-2**：r40 的 defer 修法只有「5s 后再试」一个动作，无次数/时长上限、无升级路径，每次 defer 带锁重写一次 store，臂是未 unref 的墙钟差 ⇒ 任一 pause 泄漏或卡死窗口把「烧一次 run」换成「永久自旋 + 写放大 + 挂住事件循环」。

修法总纲：**(a)(b)(c) 各给唯一权威**—— 唯一 typed 契约（基类+两字段）与唯一字符串兜底（解码同一契约的序列化形）；(b) 是契约上的字段；(c) 是 store 的三态枚举；**禁止第四套口径**（grep 级验收）。

## 2. 候选修法

### 轴① typed 契约：单一权威、两字段显式拆分（0902 最小面）

**候选 A1：谓词补丁（最小面，不推荐）**
`isRetryableSessionInputRefusal` 扩成 `… || (instanceof Suspended && error.retryable)`，另加非投递谓词。改动面最小；但「类清单 vs 字段」双权威仍在，第四个 refusal 类会重演 XA-1（复发模式本身未被关死），且不覆盖 ②。

**候选 A2：基类契约 + `deliveredNothing` / `retryNowSucceeds` 两字段【推荐，覆盖并细化 0902 面】**
新增抽象基类 `SessionInputRefusedBeforeDeliveryError`：
- `readonly deliveredNothing: true`——命题：这次尝试没有入队/投递任何东西（基类即此命题的结构权威，新 refusal 类必须 extends）；
- `readonly retryNowSucceeds: boolean`——命题：不重启进程、稍后重试同一动作能否成功。挂起/Paused/Coalescing = true；栅栏 = false。现 `retryable` 字段**更名**迁移到它（语义收窄为「本进程内」，这是 0902 判词的核心修正：栅栏的原注释「retrying cannot succeed until restart」本来就是「now 不行」）。
- 消息文本里的 `retryable=` 串**保留不改**（transcript/测试历史子串契约；文档注明该 token 现在序列化的就是 retryNowSucceeds）——字符串兜底解码它（轴④）。
- Suspended 保留 `suspendedForUpdateRestart` 作诊断位（= !retryNowSucceeds 的具名来源）；Paused/Coalescing 构造语义不变。
- 唯一 typed 谓词 `isSessionInputRefusedBeforeDelivery(error): error is 基类`；**删除** `isRetryableSessionInputRefusal`（3 调用点同提交改齐，grep 清零，仓规不留兼容层）。
- 改动面：prompt-admission.ts 类结构（构造签名不变）、agent-session 3 个 throw 点零改动、cron-jobs/daemon-mode 消费点、~4 个测试文件 import/断言机械改名。
- 取舍：编译期强制新类入契约；两命题显式分离后 ②③ 各自只能读对的字段；(b) 的「本进程内」定义与 0902 一致。风险：纯进程内类型重构，错误对象不过 wire/store，`name`/message 串不变。

**候选 A3：调度器只信 hook 契约（错误即数据）**
hooks.runJob 绝不抛 refusal、只返回 outcome。不推荐单用：把正确性押给「每个 hook 记得吸收」——r40 的兜底 catch 恰为此而生，等于把雷从谓词挪进每个未来 hook。

**子决策 D1（0902 面未覆盖的第四种实例，本方案给出更好替代）：栅栏窗口的排队路径 Paused**
`abortForUpdateRestart` 拿的 pause lease 让排队路径（跨进程子代理回执、late child reply）拿 `SessionInputAdmissionPausedError{retryable:true}`（r39-qp.test.ts:227 断言此值，注释自述「redeliver after the restart」）。按 (b) 的「不重启」定义，这个实例其实是 **false**（会话随 teardown 关闭，lease 永不释放）。
- **D1a（推荐）**：`acquireSessionInputPause({ forUpdateRestart: true })` 式旗标，仅 `abortForUpdateRestart` 的 lease 传入 ⇒ 其 Paused 报 `retryNowSucceeds=false`，消息追加一句「the pause is held for an update-restart teardown; resend after the restart」（**追加句只加在旗标实例上，历史子串不动**）。r39-qp:227 的断言随契约改写（`deliveredNothing===true, retryNowSucceeds===false`），命题「拒绝而非 queue-and-lose + 重启后可重发」保留。
- D1b（更省）：Paused 恒 true，接受栅栏窗口内排队路径烧 ≤3 次重试（M6b 兜底）。代价：0902 点名的「对着本进程永不准入的会话烧重试」在排队路径上仍然成立——只是被 M6b 封顶。若工期紧可作为第一阶段，报告需明示残留。
- 取舍：D1a 多动 1 个构造旗标 + 1 处测试改写，把「烧重试」从「封顶 3 次」变成「引导立即持久化/等重启」；与 0902 判词同构（栅栏态=等重启后重发）。

### 轴② defer 有界性与时钟基

**候选 B1：计数+退避+升级，时钟基复用 TC 的 StepCompensatedClock【推荐】**
- 有界性（与钟基正交，纯计数）：job 新增可选字段 `deferCount`（连续 defer）、`deferredSince`（串起点）、`lastDeferredAt`。cadence=f(tier, deferCount)：
  - `retryNowSucceeds=true`（挂起/Paused/Coalescing，transient 窗）：前 `CRON_DEFER_FAST_ATTEMPTS`(=3) 次保持 5s，之后翻倍退避到 `CRON_DEFER_BACKOFF_CAP_MS`(=300s)；
  - `retryNowSucceeds=false`（栅栏档）：`CRON_FENCE_RETRY_MS`(=30s) 起步、同样退避——restart-aware，不在本进程 5s 空转；
  - 升级：deferCount ≥ `CRON_DEFER_MAX_ATTEMPTS`(=20) 或串龄 ≥ 15min ⇒ 写 `lastError="Deferred N times since …; admission window has not released"`、cadence 切 `CRON_DEFER_ESCALATED_RECHECK_MS`(=1h)；**job 永远 active，once 绝不因 defer 变 completed**（升级是可见性，不是熔断）；
  - 任何非 deferred 记账清零。按默认值，卡死窗口写放大从「每 5s、无限」降到「约 12~20 次后 1 次/小时」。recurring 不做 cadence 干预（其 defer 写频=健康运行写频，无放大；deferCount/升级只作可见性）。
- 时钟基：**复用 TC**（`clock-step.ts` + `schedulerNowMs()` + 醒时跳变侦测 + `timer.unref()`，wt-tc 已绿+pristine 复验）。defer 的 `nextRunAt` 落盘仍诚实墙钟（TC 立场）；臂与醒时走 step 补偿，墙钟回拨不拉长 5s/30s 节奏（升级串龄判定用墙钟，回拨只延迟升级，方向保守）。
- 落地顺序硬约束：TC 分支 `5b19b6c79` 基线早于 K3Q-3，与 HEAD 在 `AgentCronScheduler` 同类内三处必冲突（`runDue` 默认参/`claimDue`+`results.filter(!=="deferred")` 必须保留、`queueDispatch` 记账行、`scheduleNext`）。⇒ **先 rebase TC 到 HEAD 再做 XA-2，或同车道一体推**；cron-jobs.ts 共享文件，禁止两车道并行持有未提交 hunk。
- 取舍：升级后 1h 才重试=对真实 transient 泄漏的自愈延迟；栅栏档 30s=重启后最多 ~30s pickup 延迟——都是可调常量，远好于现状（无限或消失）。

**候选 B2：只加 unref + 硬熔断（N 次后 lastError+once completed）**——不可接受：把 XA-1 的静默消失换理由重演；且不解决回拨。仅可作过渡，须明示残缺。
**候选 B3：defer 写去重（中间 defer 不落盘）**——不可行：每次 defer 必须清 dispatch 记录（`recordDispatchResult:863`），不写则重启时 `recoverInterruptedDispatches`（`:2160-2187`）把 once 判 completed+"Interrupted…"，又一次静默消失。写是记账正确性，只能限频不能省。

### 轴③ ran/skipped/deferred 三态记账（栅栏支路 vs cron 支路）

**候选 C1：deferred 复用 lastSkippedAt，只加 deferCount**——最小面但盘上两态不可分，三态统一名存实亡。
**候选 C2：三态在盘上可区分【推荐】**
- `deferred` → `lastDeferredAt`+`deferCount`（不再写 `lastSkippedAt`）；`skipped` → 维持 `lastSkippedAt`（G5「已消费」不动）；`ran` → 维持 `runCount/lastRunAt/lastError`。
- 分类单点化：**删 daemon-mode `runCronJob` 两处 refusal catch**（`:2012-2017`、`:2061-2066`；`unrunnableAtAdmission`→skipped 保留），refusal 上抛到 `queueDispatch` catch——全仓 `"deferred"` 生产产出点唯一，tier 同处读 `error.retryNowSucceeds`，随 `recordDispatchResult({outcome:"deferred", deferredKind})` 交 store。**分类一处、记账一处**，r40 的「hook 层与调度层各判」分裂不再可能。
- 显示面：`formatAgentCronJob`（`cron-jobs.ts:1555-1563`）追加 ` deferred=<ts> defers=<n>`，升级态走既有 `error=` 通道可见（补 XA-2「无 lastError、无告警」面）。
- 取舍：r40 测试 3 处 `lastSkippedAt` 断言改写为 `lastDeferredAt`（命题不变；属跟随规格变更，提交说明披露）；daemon-supervisor-process.test.ts 断言的是 busy-skip 路径，不受影响。

### 轴④（新，XA-7）：字符串清单降级为只答 的兜底

**候选 E1：保留函数名，仅改语义注释**——不推荐：名字 `isRetryable…` 本身就是 错位，留名=留雷。
**候选 E2：换成一个两答分类器【推荐】**
`agent-messages.ts` 以 `classifyAgentMessageSendFailureByMessage(message): { deliveredNothing: boolean; retryNowSucceeds: boolean | undefined }` 取代 `isRetryableAgentMessageSendError`（删除，grep 清零）：
- **只答**：沿用现清单七式（`queued session input is suspended` 裸前缀、`session input admission is paused`、`equivalent follow-up…committing`、too many pending / rate limit / not accepted / wait timed out）——历史真集不变；
- **解码 序列化形**：Suspended 消息内嵌的 `retryable=` token 与栅栏句 ⇒ 栅栏=true/false、挂起=true/true；D1a 落地后 teardown Paused 的追加句 ⇒ true/false；普通 Paused/Coalescing ⇒ true/true；其余形状 ⇒ `undefined`（答不了就不答，绝不猜）。这不是第四套口径——是同一 typed 契约过 wire 后的解码器（typed 对象不过 `controller.sendAgentMessage` 的跨进程边界，字符串兜底因而在）。
- 消费点改造（三处）：
  - `rememberFailure`（`:1084-1089`）：`(a)` 决定 id 花没花——`deliveredNothing===true` 才 return（现状对三种 refusal 都对，改后语义显式）；`(b)` 不在此消费。
  - 广播 uncertain（`:1147-1152`）：同样只读 `(a)`。
  - `_terminalizeRepeatedAgentMessageSendFailure`（`agent-session.ts:13113-13135`）：计数读 `(a)`（封顶不变——栅栏烧重试最多 3 次的 M6b 兜底保留）；**终局引导读 `(b)`**：`retryNowSucceeds===false` 时 `formatAgentMessageRetryExhaustedError` 换栅栏专用文案（「the target is fenced for an update-restart; nothing was delivered; persist your result (file/end-turn) and resend after the restart, do not retry in this turn」——0902 的「等重启后重发」）。中间失败的引导随 D1a 的消息追加句自答。
- 取舍：6 个测试文件的 `isRetryableAgentMessageSendError` 断言机械迁移到 `deliveredNothing`（命题保真：老真集 ⊆ 新 集合）+ 新增 分档断言；消息文本除 D1a 追加句外零改动。

**候选 E3：删字符串兜底、只认 typed**——不可行：跨进程 send 的错误只剩 message 串（XA-3 已证 wire 不带类型），删兜底=跨进程栅栏拒绝被当 uncertain 花掉 id ⇒ 重发被拒，消息更丢。

## 3. 推荐与理由

**推荐组合：A2（两字段基类契约，含 D1a）+ B1 + C2 + E2，落地四步、同车道（或串行两车道）。**

1. **先合 TC**（`5b19b6c79` rebase 到 HEAD，解三处冲突；独立可验——wt-tc 15 新测+181 既有测绿+pristine tsgo EXIT=0）。不先合则 XA-2 自带 unref+单调臂 ~30 行重复，留合并债。
2. **XA-1/XA-7 typed 契约**（A2+D1a）：基类两字段、`retryable` 更名 `retryNowSucceeds`、teardown pause 旗标；punch-fence 四 case 提升为仓内正式回归（`test/r41-xa-cron-refusal-accounting.test.ts`），红测先行。
3. **字符串兜底降级**（E2）：分类器替换+三消费点分工+栅栏终局文案；6 测试文件机械迁移。
4. **XA-2 有界性**（B1+C2）：deferCount/退避/升级、`isAgentCronJob` 对新可选字段加存在时类型校验（坏 store 按缺省处理，保 corrupt-store 韧性）、`formatAgentCronJob` 显示。

对 0902 最小面的逐条覆盖：typed 拆 `deliveredNothing`/`retryNowSucceeds` ✓（A2，且给出字段级定义「不重启」）；`rememberFailure` 用 决定 id、 决定引导 ✓（E2+M6b 文案分工：id 记账在 rememberFailure，引导在 exhausted 文案与 D1a 消息句——比 0902 原文「rememberFailure 用后者决定引导语」更贴现结构：rememberFailure 无文案职责，引导真正产生在三连终局与错误消息本身）；cron/daemon 三调用点 决定不记 run、 决定节奏（栅栏档 restart-aware 非 5s）✓（C2+B1）；字符串清单降级只答 ✓（E2）；禁止第四套 ✓（验收 grep 不变量）。

理由：病根是双正交命题×三口径；A2 把 (a)(b) 变成编译期强制的两字段，E2 把 唯一化并显式声明「答不了=undefined」，C2 把 变成 store 唯一三态枚举——每个命题恰一个权威。B1 的界放在计数上（与钟基正交、可单测、可显示），钟基交 TC。D1a 是对 0902 面的补强：0902 只处理直连路径（Suspended），排队路径（Paused-in-teardown，r39-qp:227 实证）同窗口同物理，不补则烧重试面只关一半。

兼容性：类重构零 wire 零 store 破坏；`retryable` 字段更名属进程内公开成员改名（4 个测试断言机械跟改）；新 job 字段全部可选且 parser 忽略未知字段（旧写新读=缺省、新写旧读=忽略）；**不新增 status 枚举值**（旧读者整条丢弃 job——硬约束）；daemon wire 上 `AgentCronJob` 加可选字段按仓规分类 **backward-compatible**（无新命令、旧客户端零行为变化），无需 capability gate / revision bump（对照 XA-3 教训，此处成文分类）。

## 4. 风险面清单（会动到谁）

| 面 | 触及 | 说明 |
|---|---|---|
| `prompt-admission.ts` | 类结构重排 + 字段更名 | 三类 extends 基类；`name`/message 历史子串不动（`retryable=` token 保留）；构造签名不变 |
| `agent-session.ts` | `acquireSessionInputPause` 加旗标（D1a）、M6b 终局文案分档、3 个 throw 点零改动 | teardown lease 旗标只影响 `abortForUpdateRestart` 的 lease |
| `agent-messages.ts` | E2 分类器替换 + `rememberFailure`/广播分工 + exhausted 栅栏文案 | 消息文本除 D1a 追加句零改动 |
| `cron-jobs.ts`（**共享文件，独占车道**） | queueDispatch 分类、recordDispatchResult、常量、isAgentCronJob 可选校验、formatAgentCronJob | 与 TC 合并冲突集中在 `AgentCronScheduler`；先 TC 后 XA 压到最小 |
| `daemon-mode.ts` | runCronJob 删两处 refusal catch | refusal 改上抛，行为等价（queueDispatch 兜底分类）；`unrunnableAtAdmission`→skipped 保留 |
| 测试 | r40-k3q3（3 处 lastDeferredAt）、r39-qp（:227 契约改写 + 机械改名）、f1/queued-receipt/bounded-wait/duplicate-window（断言迁移）、punch-fence 提升 | 全部披露；命题不弱化，新增 分档断言 |
| 用户可感知 | once 撞栅栏/卡窗后**存活**；recurring 拒绝 tick 不再计 runCount；`/cron` 列表新增 defers=/升级 error=；子代理撞栅栏的终局引导从「别再试、写文件」变为「等重启后重发」 | 均为纠偏，推送说明写明 |
| daemon 协议 | AgentCronJob 响应加可选字段 | backward-compatible，无 bump |
| 混版 store 写 | 旧进程 last-write-wins 赢时 deferCount 被抹 | 后果=退避重头数（升级延迟），非正确性；记录接受 |
| 相邻缺口（**不在本方案面内**） | ① `skipped` 分支把 once 置 completed（G5 设计意图，含 session-closing 窗口 tick→skipped→once 被消费的更新窗口变体）；② claim 后进程死亡 → `recoverInterruptedDispatches` 把 once 置 completed+"Interrupted"（先在语义，fence 窗口是高概率死亡窗，窄竞态）；③ `promptResult.admitted:false` 的 coalesce 路径走 skipped 非 deferred（r37 语义）；④ XA-3 wire 信任闸（独立方案线） | 本方案只统一「抛出型 refusal」记账；登记下轮 |

## 5. 验收护栏（红测设计 + 等价证明）

红测纪律按终审 §7.4：每条「已闭合」必须有**改动前实现必然红**的负例。

**A. cron 记账（骨架照 punch-fence 模板，`test/r41-xa-cron-refusal-accounting.test.ts`）**
1. **A（红）** once+Suspended{fence} → `active/runCount:0`、无 lastRunAt/lastError、`lastDeferredAt` 写入、`nextRunAt=tick+CRON_FENCE_RETRY_MS`。HEAD=completed/runCount:1。
2. **D（红，最强负例）** once+Suspended{挂起}（字段 true）→ deferred@5s。证明判定读字段不读清单。
3. **C（红）** recurring+栅栏 → runCount:0、无 lastRunAt/lastError、next slot。HEAD=runCount:1。
4. **B（正控，改前后都绿）** once+Paused → deferred@5s、once 存活（仅 lastSkippedAt→lastDeferredAt 改断言）。「修 XA-1 没修坏 r40」的等价锚。
5. **过宽反控（两侧绿）** 普通 Error → ran+runCount+1+lastError。谓词没吞任意错误。
6. **有界性（红）** 伪时钟连打 defer：cadence 序列 [5s×3,10,20,40,80,160,320,300…]、deferCount 递增、达限后 lastError+`nextRunAt=+1h`+status 仍 active；写次数≤N+1（公共 API 子类化 `AgentCronJobStore` 包 `recordDispatchResult` 计数——不触 private，合规）。HEAD 无计数恒 5s，必红。
7. **栅栏档 cadence（红）** 首 defer=30s 非 5s。
8. **清零** defer→释放→ran→再 defer 从 0 重来。
9. **时钟（随 TC 带入并补一条）** TC-2 回拨臂测 + 新增「defer 写入与重臂之间墙钟回拨 30min，真实 5s 后照跑」；unref 用 TC-3 子进程 fixture。

**B. 字符串兜底与子代理回执账（XA-7，`test/r41-xa-message-failure-classifier.test.ts` 或并入既有文件）**
10. **（红）** 分类器对栅栏消息 → `deliveredNothing=true, retryNowSucceeds=false`（HEAD 的老函数对同一消息答 true—— 命题被答错即为红）；挂起消息 → true/true；裸前缀+`retryable=false` token 组合即栅栏。
11. **（正控）** 老真集（queued-receipt:113-118 的四条 + r39-qp/f1 各断言）在新分类器上 `deliveredNothing` 全 true——等价证明的核心（(a) 真集不缩水）。
12. **（红）** M6b：栅栏消息连打 3 次 → 终局文案含 restart/fence 引导（HEAD 是通用「terminal, not retryable」文案，不含）；且 3 次计数本身两侧都发生（封顶不回归）。
13. **（红，D1a）** teardown pause 的 Paused → `deliveredNothing=true, retryNowSucceeds=false`、消息含 restart 追加句（HEAD 恒 true）；r39-qp:227 断言按新契约改写且命题保留（拒绝非 queue-and-lose、重启后可重发）。
14. **id 账等价（正控）** 栅栏/挂起/Paused 三种失败后同 id 重发都到达 delivery leg（r39-qp:194-206 模式推广）—— 未花掉语义不回归。

**C. grep 级「禁止第四套口径」验收**
15. `git grep isRetryableSessionInputRefusal` = 0；`git grep isRetryableAgentMessageSendError` = 0； 答者恰两个：`isSessionInputRefusedBeforeDelivery`（typed）与 `classifyAgentMessageSendFailureByMessage`（字符串兜底，文档注明「只答 ， 为 undefined 时不可猜」）； 答者恰一个：基类字段 `retryNowSucceeds`。

**D. 既有面回归与提交纪律**
16. `cron-jobs.test.ts`、`cron-jobs-corrupt-store.test.ts`、r40-k3q3（改写后）、4527/4657、daemon-mode、agent-message 全家、r39-qp、f1、TC 的 clock-rollback 全绿；`npm run check` EXIT=0；store 兼容：带新字段 fixture 过 `isAgentCronJob`、缺字段按缺省、`deferCount:"x"` 坏记录按缺省（corrupt 韧性正控）；提交后 pristine-tree（`git archive HEAD`+symlink node_modules）tsgo EXIT=0。

**等价证明（改了什么/没改什么）**
- 逐字不变：三类 `name`/message（除 D1a 追加句）、`_assertSessionActionAdmissionAvailable` 顺序与 throw 条件、ran/skipped 分支语义、claimDue/recoverInterrupted、G5「skipped=已消费」、M6b 三连封顶、id-gate「未花掉才可重发」。
- 行为变化（全部红测钉住，方向=终审判词）：Suspended 两档入 deferred（1-3）；deferred 盘上改 lastDeferredAt+deferCount（4）；cadence 分档+退避+升级（6-8）；臂 unref+step 补偿（9）；字符串兜底 显式化+栅栏 分档+终局引导分档（10/12/13）；teardown Paused 的 收窄（13）。
- 结构不变量：`"deferred"` 生产产出点全仓唯一；refusal 分类点全仓唯一；两旧谓词名从仓内消失（15）。

**收口判据**：A1-A5、B10-B14、C15 全绿且 B4/A4 在改前后都绿；A6-A8、B12-13 绿；既有回归零新红；三个 grep 不变量成立。
