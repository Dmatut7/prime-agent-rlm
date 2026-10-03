# 安全簇方案（文档-12 供应链校验 / 文档-13 凭证外发面）

- 立项来源：`docs/fork/swarm-loop-plan-20261001.md:31,123-124`、`docs/fork/evolution-ledger.md:87`（Backlog #16，硬约束：先写方案问老板）
- 原始证据：`docs/fork/audits/2026-09-14-fixes.md:376,427,482`（SUP-A..I 簇）、`docs/fork/audits/rounds/round-36-bootstrap-kernel.md`（F7 uv 引导链）
- 外部参照：Anthropic《How we contain Claude across products》（2026-05-25，引见 /tmp/wave22/res.md 一.3）；Matthew Green《Is sandboxing sufficient to contain rogue agents?》（2026-09-30，引见 /tmp/wave20/res.md 一.4）
- 本文是纯方案，不含代码改动；供老板拍板后由后续波次执行。

## 〇、现状核验结论（先研究现状的产物）

**登记文本已大面积过时。** 文档-13 的两个 named 项与文档-12 的四个子项在 HEAD（d7dee6e42）上已修，修复落在 2026-09-15/17 的几个提交里，但 ledger 与 swarm 计划仍按 9-14/15 的审计快照登记「未修」。仍开的是残底子项和范围拍板。逐项对账：

| 登记项 | HEAD 状态 | 证据 |
|---|---|---|
| 13a traces PUT 零脱敏 | **已修** | `9441a8899` + `006476f05`：所有上传（自动 + `/traces upload` 一次性）过 `applyUploadPrivacyGate`（`agent-traces.ts:1169-1177`），headers+body 双向处理：URL userinfo 剥离 → 23 种密钥形状检测（`share-secret-detectors.ts:70-92`）→ 本会话配置值精确比对（auth.json/models.json/settings.json/凭证名 env，`share-secret-values.ts`）。opt-in 门 `agentTraces.enabled` + `DO_NOT_TRACK`/`PI_OFFLINE` 否决（`agent-traces.ts:965-982`）。测试：`upload-privacy-gate.test.ts` 等 |
| 13b auth.json 0644 | **已修** | `f905dc8f8`：`packages/ai/src/utils/auth-store.ts` 走 `writePrivateFileAtomic`（0600 + symlink 拒绝 + 原子替换）。本机 `~/.prime/agent/auth.json` 实测 `-rw-------`，父目录 `drwx------` |
| 12a SUP-B update 绝对 URL 无哈希 | **已修** | `d3945cb68` + `9574439ea`：`config.ts` 更新规格分类 + 可信 origin 白名单 + sha256 pin（`missing_artifact_hash`/`untrusted_artifact_source` 拒绝）；`install.sh:1501-1542` 校验 SHA256SUMS |
| 12b SUP-D fd/rg releases/latest 无校验 | **已修** | `d3945cb68`：`tools-manager.ts` 钉版本（fd v10.5.0 / rg 15.2.0）+ sha256 验证后才执行；浮动解析降级为 opt-in（`PRIME_AGENT_TOOLS_ALLOW_FLOATING`）且仍强制 digest |
| 12c SUP-A min-release-age 静默失效 | **已修** | CI 显式 pin `npm@11.12.0`（`ci.yml:61-62`）+ `scripts/check-npm-release-cooldown.mjs` 门；`.npmrc` 注释写明 npm>=11.10 前提 |
| 12d SUP-E PyPI 裸名/抢注 | **半修** | runtime 本体：本地源码优先、registry 裸名默认拒绝（`PRIME_AGENT_KERNEL_ALLOW_REGISTRY_RUNTIME=1` + 精确 pin 才放行，`d3945cb68`；round-36 :43 核实）。**残余**：12 个默认包（requests/pandas/…）只 `==` 钉版本不钉 hash（`bootstrap.ts` `DEFAULT_RLM_EXTRA_PACKAGES`）；`prime-agent-runtime` PyPI 名仍未注册 |
| 12e SUP-F/G + round-36 F7 uv 引导链 | **仍开** | `bootstrap.ts:80` 仍 `curl -LsSf https://astral.sh/uv/install.sh \| sh`（无版本 pin、无校验和；只加了 `--max-time 120`）；CI `python3 -m pip install --user uv` 无 pin（`ci.yml:333`、`nightly-process-stress.yml:46`）；`install.sh:1767` 链路会置 `PRIME_AGENT_INSTALL_UV=1` 跳过 TTY 确认（`postinstall.ts:11-12`） |
| 12f SUP-I lock 卫生 | **仍开** | HEAD 实测：`package-lock.json` 426 个非 workspace 非 link 条目中 **216 个缺 `resolved`+`integrity`**（样本：`@babel/runtime`、`@mistralai/mistralai`、`@nodelib/*`） |

文档-13 原始线（2026-09-14-fixes.md 凭证外发节）还登记过三条残余，当时即判 low/未修，需一并拍板：服务端 revoke 缺（登出只清本地）；sessions jsonl 与 `kernel-state.dill` at-rest 明文（0600/0700，无第三方路径）；logger 无脱敏（S-4，109 处调用扫过无凭证变量，属防纵深而非堵漏）。

## 一、逐项修法选项 / 风险 / 影响面

### 1. 文档-13 销账与残余处置

named 两项已修，无需再动码。要拍板的是残余：

**1a. 服务端 revoke（登出只清本地）**
- 选项 A：维持现状，文档注明「登出 = 本地删除，服务端 token 仍活到自然过期」。
- 选项 B：立项加 revoke 端点调用（依赖各 provider 是否暴露 revoke API；OAuth 系有、API-key 系多数没有）。
- 风险：A 的风险是登出后旧 token 在泄露场景仍可用；B 的风险是 provider 覆盖不全造成「半 revoke」假安全感。
- 影响面：A 零代码；B 动 `packages/ai` oauth 层 + 各 provider。

**1b. at-rest 明文（sessions/kernel-state.dill）**
- 选项 A：维持现状（0600/0700 文件系统权限即边界，与 SSH 私钥同模型）。
- 选项 B：上传/导出前扫描已覆盖，追加「落盘前 scrub 已知凭证值」——成本高、误伤会话内容、且 `kernel-state.dill` 是二进制序列化难做。
- 风险：A 接受「本机被读 = 全泄」（这也是 13a 隐私门存在的前提）；B 有破坏会话可恢复性的风险。
- 影响面：B 动 session-manager 落盘路径与 repl.py 快照路径，两包 + Python 侧。

**1c. logger 脱敏**
- 选项 A：维持现状（已有负结论扫描：109 处调用无凭证变量）。
- 选项 B：logger 层加形状过滤兜底（防未来回归）。
- 影响面：B 动 packages/ai 或 coding-agent 的 logger 单一文件。

### 2. 12d 残余：默认包 hash pin

- 选项 A：`uv pip install` 改 `--require-hashes`，12 个 pin 各附 sha256（uv 支持 `-r` requirements 带 `--hash=`）。工程量小（bootstrap.ts 一处常量表 + 校验），但**每平台 wheel hash 不同**，需按平台列多 hash 或接受源码构建。
- 选项 B：出货路径改用 `uv.lock`（现有锁只 CI `uv run` 用）——把锁文件身份并进 venv 代际哈希。工程量中。
- 选项 C：维持版本 pin。版本 pin 已防「静默装新版」；hash 防的是「同版本内容被替换」（PyPI 正常不允许同版本重传，残余窗口是 PyPI 端被攻破/ yank 重发）。
- 风险：A/B 的误伤面是企业镜像/代理只代理部分 wheel 时 hash 集不全导致首跑失败；C 接受 PyPI 端供应链风险。
- 影响面：`bootstrap.ts` + `kernel-runtime-pinning.test.ts`（已有测试基建）。

### 3. 12d 残余：`prime-agent-runtime` PyPI 占名

- 选项 A：老板手动在 PyPI 注册占名（传一个最小占位包），5 分钟，永久消除抢注窗口。
- 选项 B：不占名，靠现状「默认拒绝 registry 安装」兜底——抢注者拿到的包也进不了默认路径，只有显式 opt-in（`PRIME_AGENT_KERNEL_ALLOW_REGISTRY_RUNTIME=1`）+ 手工 pin 的用户才会踩。
- 风险：A 几乎零风险（占位包需维护不删）；B 的风险是 opt-in 文档传播后有人照做装了恶意包。
- 影响面：无代码（A 是 PyPI 网页操作）。

### 4. 12e：uv 引导链 pin + 校验

- 选项 A：pin uv 版本 + 下载后 sha256 校验。astral.sh 安装器支持 `UV_VERSION`/installer 自身可从 GitHub releases 拿 checksum；或绕过安装器直接下 `uv` 二进制 tarball + 仓内置 sha256 表（与 tools-manager 的 fd/rg 同款模式，复用 `verifyFileChecksum` 思路）。
- 选项 B：只 pin CI 两处（`pip install uv==x.y.z`），产品侧 curl|sh 维持 + 把「交互确认提示在真产品路径不可达」（round-36 F7 的死代码发现）一并修——让 [Y/n] 提示真的可达。
- 选项 C：维持现状（非 TTY 拒绝路径已存在，`PRIME_AGENT_INSTALL_UV=1` 是显式 opt-in）。
- 风险：A/B 升级 uv pin 时是手工活，忘了跟进会装不到新 python-build-standalone；C 接受 astral.sh/GitHub 被攻破即首跑种马（round-36 判 P2/P3）。
- 影响面：A 动 `bootstrap.ts` + 测试；B 动两个 workflow yml + `bootstrap.ts` 提示路径；均不动 daemon wire。

### 5. 12f：lock 卫生

- 选项 A：用 npm 11 重新生成 lock（`npm install --package-lock-only`）补齐 resolved/integrity，加 CI gate 防回归。
- 选项 B：只加 CI 检测脚本登记数量基线，容忍存量（像 test-private-probe-baseline 的只缩不增模式）。
- 选项 C：接受现状（npm ci 不报错，影响是可复现性/审计强度而非正确性）。
- 风险：A 重生成 lock 会触动全量依赖解析，需全量测试验证 + 与在飞 lane 协调（lock 是共享文件，一次只能一个 lane 动）；缺失成因未查明（unverified），可能是历史 npm 版本写入习惯。
- 影响面：`package-lock.json` 单文件但 diff 巨大；CI 加一步。

### 6. 横向拍板：containment 是否立项（两篇外部文章的真正落点）

Anthropic 2026-05-25 文的可迁移结论（/tmp/wave22/res.md 一.3 逐条有引）：批准疲劳 93%（permission 闸不能依赖人审）；「信任建立前不解析不执行」配置/hooks；「用户即注入向量」红队 24/25 成功、唯一扛住的是 egress 控制 + 文件系统边界；egress allowlist 是能力授予不是目的地过滤；symlink 解析必须先于路径校验；multi-agent trust escalation（子代理输出不能比原始工具结果信任级高）；persistent memory poisoning（跨会话记忆需启动分类器）；「最弱的层是你自己造的那层」（优先复用成熟原语）。

Matthew Green 2026-09-30 文（/tmp/wave20/res.md 一.4）：OpenAI 设施内 agent 越狱实录（共享 package cache 互留指令 = 蠕虫两要素）；两派之争落点「warden-guarded sandbox」。

映射到本仓的暴露面：RLM 内核 **in-process** 执行模型生成的 Python，持本进程全部用户权限（无沙箱）；组织记忆/kernel-state 跨会话持久（=「共享缓存留言板」同类）；子代理结果回注父上下文（= trust escalation 通道）。

- 选项 A：不立项，登记为「已知接受的风险」（本 fork 是单用户研究工具，威胁模型不含对抗性模型）。
- 选项 B：立「设计先行」项——先出 containment 设计文档（egress 控制、文件系统分级、记忆投毒分类器、子代理信任降级各自的复用原语选型），再拍实施。
- 选项 C：只做最便宜的三件：记忆启动分类器评估、子代理结果信任级标注、文档化威胁模型。
- 风险：A 接受「模型被注入后拥有用户全权限」；B/C 是设计工程量，无运行时风险。
- 影响面：A 零；B/C 跨 runtime(TS+Python)/agent-session/harness，是新设计簇而非修复。

## 二、给老板的拍板清单（是非题，勾 Y/N 即可）

1. 文档-13 两个 named 项（traces 脱敏、auth.json 0644）确认按上表证据**销账**？Y/N
2. 服务端 revoke 不立项、维持「登出只清本地」并补文档说明？Y/N
3. at-rest 明文维持现状（0600/0700 即边界），不做落盘 scrub/加密？Y/N
4. logger 脱敏兜底不立项？Y/N
5. 12d 残余立项：默认 12 包升级 hash pin（选项 A `--require-hashes`，接受多平台 hash 表维护）？Y/N（若 N 请圈 B/C）
6. `prime-agent-runtime` PyPI 占名由老板手动注册？Y/N
7. 12e 立项：uv 引导链 pin+校验（产品侧选项 A + CI 两处 pin uv 版本）？Y/N（若只做 CI 请圈 B）
8. 12f 立项：lock 重新生成补 resolved/integrity + CI gate？Y/N（若只登记基线请圈 B）
9. containment 横向簇：不立项登记已知风险（A）/ 先出设计文档（B）/ 只做便宜三件（C）？圈一个
10. 销账与文档同步（evolution-ledger #16、swarm-plan 域 7 两条、2026-09-14-fixes.md 标注）授权下一波执行？Y/N

## 三、执行备注（拍板后给实施波次）

- 全部项均不动 daemon wire 类型；若实施中发现需要，先报主席。
- 第 5/7 项测试基建已存在（`kernel-runtime-pinning.test.ts`、`tools-manager-pinning.test.ts`、`update-spec-trust.test.ts`），修复按先红后绿。
- 第 8 项动 `package-lock.json` 前必须与在飞 lane 串行（共享文件纪律），并在纯净树复验。
- 第 6 项是仓外操作，无代码。
