# R3 施工附录 · 确切代码、命令与逐步缺口表

> 主文档：`docs/fork/sync-upstream-r3.md`（v2）。本附录是它的施工材料层，来自三份审查报告的可执行部分。
> 来源：`/tmp/rev_exec.md` §5/§6（rev-exec，qwen3.8-max-0902）、`/tmp/rev_facts.md` 附录（rev-facts，qwen3.8-max-0902）、`/tmp/rev_logic.md`（rev-logic，kimi-k3）。
> 所有命令均为只读或只在施工 worktree 内动作。**行号基准标记**：`[HEAD]`=本地 0c504e475、`[UP]`=upstream/main d74a75fea、`[MT]`=merge-tree 3cd22c1a0 合并树。v1 任务书全程未标基准，是 IM2/I4 指出的缺陷，本附录一律标注。

---

# 第一部分 · 确切代码与命令（rev-exec §5，已实测）

## 5. 补出来的喂饭料（任务书缺的确切代码与命令）

### 5.1 S0.2 之后必须补的三步（依赖引导）

```bash
WT=/Users/a1/Desktop/_wt_prime/sync-r3
# 1) 根 node_modules：跟仓里既有 19 个 worktree 一致的做法（exec-daemon / r2-w1 实测都是符号链接）
ln -s /Users/a1/Desktop/ai/prime-agent/node_modules "$WT/node_modules"
# 2) 两个包级 node_modules 也要（主仓里是真目录，不是链接）：
ln -s /Users/a1/Desktop/ai/prime-agent/packages/ai/node_modules          "$WT/packages/ai/node_modules"
ln -s /Users/a1/Desktop/ai/prime-agent/packages/coding-agent/node_modules "$WT/packages/coding-agent/node_modules"
# 3) 自证：这两条必须有输出，否则 S8 的任何门都跑不了
ls "$WT/node_modules/.bin/tsgo" && ls "$WT/node_modules/vitest/dist/cli.js"
```

**并必须在任务书里写明代价（I1）**：`node_modules/@earendil-works/pi-ai -> ../../packages/ai` 是相对链接，指向**主仓**的 packages/ai。所以施工树里 `import "@earendil-works/pi-ai"` 拿到的是主仓的 `dist`（含别 lane 未提交改动的构建产物）。两个选择，S0 里必须挑一个：
- (i) 在 worktree 里 `npm --prefix packages/ai run build` 后，把 `$WT/node_modules/@earendil-works/pi-ai` 单独换成指向 `$WT/packages/ai` 的链接（会改主仓 node_modules 里的一个链接 → **踩 S0.1 的"不碰"**，不可取），或改用 vitest 的 `resolve.alias`（要改配置文件 → 也是本轮不该动的面）；
- (ii) **接受降级并写进 S8**：本轮 packages/ai 的验收只做只读 diff 复核 + 在主仓（等别 lane 落地后）单独跑 `packages/ai` 的测试；S8 的"已知未覆盖面"里加一条。
建议 (ii)，代价最小、不碰别人。

### 5.2 S5 的可执行命令（哈希公式已验证 + 闸号清单 + 版本校验）

**哈希（我实测三个值全对）**：
```bash
cd /Users/a1/Desktop/ai/prime-agent
cat > /tmp/r3_schema_digest.mjs <<'EOF'   # 施工代理自己落这个文件；本轮审查里我用的是 /tmp/rev_hash.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const source = readFileSync(process.argv[2], "utf8");
const commandSource = source.slice(source.indexOf("export type DaemonCommand ="), source.indexOf("type DaemonCommandName"));
const savedSessionSource = source.slice(source.indexOf("export interface DaemonSavedSessionInfo"), source.indexOf("export type DaemonDeleteSavedSessionResult"));
const outboundSource = source.slice(source.indexOf("export type DaemonOutbound ="), source.indexOf("export const DAEMON_OUTBOUND_COMPATIBILITY"));
const digest = createHash("sha256").update(`${commandSource}\n${savedSessionSource}\n${outboundSource}`).digest("hex").slice(0, 12);
console.log(JSON.stringify({ digest, lens: [commandSource.length, savedSessionSource.length, outboundSource.length] }));
EOF
node /tmp/r3_schema_digest.mjs packages/coding-agent/src/modes/daemon/daemon-protocol.ts
```
基线自证（必须先跑这两条确认公式在自己的手上复现，再谈 27）：
```bash
git show HEAD:packages/coding-agent/src/modes/daemon/daemon-protocol.ts          > /tmp/dp_head.ts
git show upstream/main:packages/coding-agent/src/modes/daemon/daemon-protocol.ts > /tmp/dp_up.ts
node /tmp/r3_schema_digest.mjs /tmp/dp_head.ts   # 期望 {"digest":"31fb64b6f4ee","lens":[12264,347,3258]}
node /tmp/r3_schema_digest.mjs /tmp/dp_up.ts     # 期望 {"digest":"962b8b4c5e35","lens":[11755,377,3326]}
```
（我实跑输出与期望逐字一致。分叉点 `5b6c0e94e` → `{"digest":"649fe649d15e"}`，revision 23。）

**什么时候必须重算**：只有改到三个切片才要（I6 实测）。`minSchemaRevision` 重编号**不影响** digest。

**闸号重编号的完整工作面（我数全了，只有 5 处）**：
```
[MT] daemon-protocol.ts:841  LIST_WITHOUT_STREAMING_MESSAGES_COMMAND = 24   本地独有 → 不动（裁定 6）
[MT] daemon-protocol.ts:844  AGENT_PEER_LIST_COMMAND = 24  (ours)           → 留（I6 已结案）
[MT] daemon-protocol.ts:846  AGENT_PEER_LIST_COMMAND = 23  (theirs)         → 删（冲突块 4 内）
[MT] daemon-protocol.ts:849  DIRECT_PEER_TRANSPORT_COMMAND = 25             → 留原号（裁定 2：官方新增保留原号）
[MT] daemon-protocol.ts:1378 DAEMON_OUTBOUND_COMPATIBILITY.assistant_stream_delta = 25  本地独有 → 不动
其余 13 处 floor（8/11/14/17×2/18/19/20/22）两侧逐字相同 → 无动作
```
"本地新增命令用 27"这条规则本轮**实际不需要用**：合并后本地独有的新命令只有 `declare_client_capabilities`，它走的是 capability 门（`CURRENT_DAEMON_COMMAND`，`[HEAD]:914`），没有 `minSchemaRevision`。

**版本校验门（替代 Z4 里的幻影施工项）**：
```bash
node -e 'const f=["package.json","packages/ai/package.json","packages/agent/package.json","packages/tui/package.json","packages/coding-agent/package.json"];const l=require("./package-lock.json");let bad=[];for(const p of f){const v=require("./"+p).version;if(v!=="0.9.1")bad.push(p+"="+v)}for(const k of ["","packages/ai","packages/agent","packages/tui","packages/coding-agent"]){const v=l.packages[k].version;if(v!=="0.9.1")bad.push("lock:"+k+"="+v)}const d=require("./packages/coding-agent/package.json").dependencies;for(const k of ["@earendil-works/pi-ai","@earendil-works/pi-tui","@earendil-works/pi-agent-core"])if(d[k]!=="^0.9.1")bad.push(k+"="+d[k]);console.log(bad.length?"FAIL "+bad.join(" "):"OK 0.9.1 x5 + lock x5 + ranges x3")'
```
期望输出：`OK 0.9.1 x5 + lock x5 + ranges x3`（我在 `[MT]` 上核过这些值全对）。

**18 个冲突文件 / 43 块的对账命令**（S0.3 缺的）：
```bash
git merge-tree --write-tree HEAD upstream/main > /tmp/r3_mt.txt || true   # exit=1 是正常的（有冲突）
head -1 /tmp/r3_mt.txt                                                    # 期望 3cd22c1a012e811acefd8dbb29d403bdfc3177a8
awk 'NR>1 && $3 ~ /^[123]$/ {print $4}' /tmp/r3_mt.txt | sort -u | tee /tmp/r3_conflicts.txt | wc -l   # 期望 18
```

### 5.3 S2.1 的确切改法（避开 Z1 + Z2）

改 `[MT] packages/coding-agent/src/modes/daemon/daemon-protocol.ts`（冲突块 3 = `:220-266` 解完之后的形状），**不动 `DAEMON_DEFAULT_SERVER_CAPABILITIES`**：

```ts
/**
 * Capabilities only the supervisor process advertises. Workers and standalone
 * daemons must not: only the supervisor issues peer-transport tickets and serves
 * the authoritative roster. Upstream pins the worker half of this in
 * test/daemon-protocol.test.ts ("...as a supervisor-only surface").
 */
export const DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES: readonly DaemonServerCapability[] = [
	"agent_roster",
	"direct_peer_transport",
];

// normalizeDeclaredCapabilities() drops anything outside this set, so a capability
// that is not "known" never reaches missingDeclaredCommandCapability() at all.
const DAEMON_KNOWN_DECLARED_CAPABILITY_SET: ReadonlySet<string> = new Set([
	...DAEMON_DEFAULT_SERVER_CAPABILITIES,
	...DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES,
]);

export function normalizeDeclaredCapabilities(/* 原样不动 */) { /* ... */ }

/** Session-plane first-party clients (TUI/agents view): every server feature except control_plane. */
export const DAEMON_FIRST_PARTY_SESSION_CAPABILITIES: readonly DaemonDeclaredCapability[] = [
	...DAEMON_DEFAULT_SERVER_CAPABILITIES.filter((capability) => capability !== "control_plane"),
	...DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES,
];

/** Control-plane first-party clients (CLI stop/restart/update): session features plus control_plane. */
export const DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES: readonly DaemonDeclaredCapability[] = [
	...DAEMON_DEFAULT_SERVER_CAPABILITIES,
	...DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES,
];
```

可选（防漂移，不改行为）：`[MT] daemon-supervisor.ts` 的 `SUPERVISOR_SERVER_CAPABILITIES` 改成引用同一常量：
```ts
const SUPERVISOR_SERVER_CAPABILITIES: readonly DaemonServerCapability[] = [
	...DAEMON_DEFAULT_SERVER_CAPABILITIES,
	...DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES,
];
```
（注意 `daemon-supervisor.ts` 是 7 块的最难文件，这行在块外 `:182-186`[UP]，改它要排在第 17 步之后，别在解块时顺手改。）

**永久门断言**（加在 `[MT] test/daemon-protocol.test.ts`，就放在官方那条 `not.toContain("direct_peer_transport")` 旁边，两条互相咬住）：
```ts
	it("keeps every command capability declarable by a first-party client", () => {
		const session = new Set<DaemonDeclaredCapability>(DAEMON_FIRST_PARTY_SESSION_CAPABILITIES);
		const control = new Set<DaemonDeclaredCapability>(DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES);
		for (const [command, compatibility] of Object.entries(DAEMON_COMMAND_COMPATIBILITY) as [
			string,
			DaemonCommandCompatibility,
		][]) {
			if (compatibility.capability === undefined) continue;
			const set = DAEMON_CONTROL_PLANE_COMMANDS.has(command) ? control : session;
			expect(set.has(compatibility.capability), `${command} requires ${compatibility.capability}`).toBe(true);
		}
		// getDaemonCommandCompatibilities() adds this one conditionally (list + omitStreamingMessages),
		// so the loop above cannot see it. Drop this line only together with the wire field.
		expect(session.has("list_without_streaming_messages")).toBe(true);
		// A capability outside the known set is silently stripped before the gate ever sees it.
		expect(normalizeDeclaredCapabilities([...session])).toEqual([...session]);
		expect(normalizeDeclaredCapabilities([...control])).toEqual([...control]);
	});
```
最后两行就是 Z2 的钉子：只要有人再往 FIRST_PARTY 集里加能力而忘了放宽已知集，这条立刻红。
"什么算过"应改成：① 这条新断言先红后绿；② 官方那条 `not.toContain("direct_peer_transport")` **仍然绿**（这一条必须显式写，否则 Z1 会重演）；③ `npm run check` 绿。

### 5.4 S2.2 的确切改法（5 处，全在 `session-manager.ts`）

1. **import 块（`[MT] :36-48`，冲突块 1）→ 取并集**：
```ts
import { resolveCompleteToolPairLeaf } from "./session-tool-pair.js";
import {
	addAssistantUsage,
	cloneUsage,
	emptyUsage,
	type SessionUsageSummary,
	sessionUsageSummaryFrom,
	subtractAssistantUsage,
} from "./usage.js";
```
2. **`SessionScanState`（`[MT] :1060-1071`，块外，git 不会提示）→ 加 3 个字段**，并把接口上方那段"Every field either only ever grows / keeps the newest value / is fixed by the first line"的注释一并覆盖到新字段：
```ts
	/** Byte offset just past the last newline-terminated line consumed. */
	offset: number;
	/** Newest-wins per entry id (#2003): a later attribution overwrites the target's usage. */
	assistantUsageById: Map<string, Usage>;
	/** Grow-only: one push per child_usage_attributed entry whose target was already seen. */
	attributedChildUsages: Usage[];
	/** Grow-only: one push per compaction / branch_summary entry that carries usage. */
	summarizationUsages: Usage[];
```
（`Usage` 已在 `[HEAD] session-manager.ts:2` 从 `@earendil-works/pi-ai` import，不用加。）
3. **resume 段（`[MT] :1128-1151`，冲突块 2）→ 两边都不能整取**，融合成：
```ts
	try {
		let header: SessionHeader | undefined = resume?.header;
		let messageCount = resume?.messageCount ?? 0;
		let firstMessage = resume?.firstMessage ?? "";
		let allMessagesText = resume?.allMessagesText ?? "";
		let name: string | undefined = resume?.name;
		let state: SessionState | undefined = resume?.state;
		let agentStatus: AgentStatus | undefined = resume?.agentStatus;
		let lastActivityTime: number | undefined = resume?.lastActivityTime;
		let offset = resume?.offset ?? 0;
		// Fold attribution aggregates like the loader: either disk representation cancels to the same own spend.
		// Copied, not shared: readSessionInfo() reads the cache entry, awaits this scan, then stores a new
		// entry, so two concurrent scans of one live file can both resume from the same object and would
		// otherwise push the same usage twice.
		const assistantUsageById = new Map(resume?.assistantUsageById);
		const attributedChildUsages: Usage[] = resume ? [...resume.attributedChildUsages] : [];
		const summarizationUsages: Usage[] = resume ? [...resume.summarizationUsages] : [];
```
（theirs 侧那 9 行不带 `resume?.` 的裸声明全删；theirs 侧没有 `offset`，整取 theirs 会让下一行 `readFileLines(filePath, offset)` 编译不过。）
4. **`if (!header)` + usageTotal（`[MT] :1245-1259`，冲突块 3）→ 取 ours 的返回形状 + theirs 的算法**：
```ts
		if (!header) return { info: null };
		const usageTotal = emptyUsage();
		for (const usage of assistantUsageById.values()) {
			addAssistantUsage(usageTotal, usage);
		}
		for (const usage of summarizationUsages) {
			addAssistantUsage(usageTotal, usage);
		}
		for (const childUsage of attributedChildUsages) {
			subtractAssistantUsage(usageTotal, childUsage);
		}
```
（theirs 的 `return null` 必须改成 ours 的 `return { info: null }`，因为本地签名是 `Promise<{ info: SessionInfo | null; scan?: SessionScanState }>`。）
5. **返回体（`[MT] :1266-1308`，冲突块 4）→ ours 的 `{ info, scan }` 双段形状，info 里加 `usage`，scan 里加 3 个累加器**：
```ts
		return {
			info: {
				path: filePath, id: header.id, cwd, name, state, parentSessionPath, rlmDepth,
				created: new Date(header.timestamp), modified, messageCount,
				firstMessage: firstMessage || "(no messages)", allMessagesText, agentStatus,
				usage: sessionUsageSummaryFrom(usageTotal),
			},
			scan: {
				header, messageCount, firstMessage, allMessagesText, name, state, agentStatus,
				lastActivityTime, offset,
				assistantUsageById, attributedChildUsages, summarizationUsages,
			},
		};
```
（我保留了原有的逐行写法含义，施工时按仓里 biome 格式一行一个属性写。）

**哨兵测试**：`packages/coding-agent/test/session-info-incremental-scan.test.ts` 已经有现成的对账夹具 `expectMatchesFullScan(path)`（它把同字节复制到一条**新路径**做冷读，再 `toEqual` 比对整个 `SessionInfo`，因此 `usage` 自动被覆盖）。只需加一条 it：
```ts
function usageLine(input: number, output: number): Usage { /* input/output/cacheRead/cacheWrite/totalTokens + cost{...} 全填 */ }

	it("reports the same usage totals on a resumed scan as on a full one", async () => {
		const path = join(dir, "session.jsonl");
		writeFileSync(path, headerLine() + messageLine("user", "question", 1000), "utf8");
		await expectMatchesFullScan(path);

		// An assistant turn with usage; the id is what the attribution fold keys on.
		const assistantId = `entry-${++counter}`;
		appendFileSync(path, `${JSON.stringify({
			type: "message", id: assistantId, parentId: null,
			message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2000, usage: usageLine(100, 20) },
		})}\n`);
		let info = await expectMatchesFullScan(path);
		expect(info?.usage).toBeDefined();     // sessionUsageSummaryFrom() returns undefined for zero totals

		// A summarization entry carrying its own usage (grow-only accumulator).
		appendFileSync(path, `${JSON.stringify({
			type: "compaction", id: `entry-${++counter}`, parentId: null,
			summary: "s", firstKeptEntryId: assistantId, tokensBefore: 5000, usage: usageLine(10, 5),
		})}\n`);
		info = await expectMatchesFullScan(path);

		// Attribution arriving in a LATER pass than its target: only a restored
		// assistantUsageById makes has(targetId) true, exactly like a full scan.
		appendFileSync(path, `${JSON.stringify({
			type: "child_usage_attributed", id: `entry-${++counter}`, parentId: null,
			targetId: assistantId, childUsage: usageLine(30, 4), aggregateUsage: usageLine(130, 24),
		})}\n`);
		info = await expectMatchesFullScan(path);
		expect(info?.usage).toBeDefined();
	});
```
关键点（任务书没写、但不写就会做出一条假绿的哨兵）：① 三次 append 必须**分三次**，中间各跑一次 `expectMatchesFullScan`，否则走不到 resume 路径；② `child_usage_attributed` 必须**晚于**它的 target 到达（合并树的折叠条件是 `if (assistantUsageById.has(attribution.targetId))`，`[MT] :1205`）——这正是"不恢复 Map 就静默少算"的那一条；③ fixture 的 usage 必须非零，因为 `sessionUsageSummaryFrom` 对全零返回 `undefined`，两侧都 undefined 时断言会假绿；④ `Usage` 的字段是 `{input,output,cacheRead,cacheWrite,totalTokens,cost:{input,output,cacheRead,cacheWrite,total}}`（`[HEAD] packages/ai/src/types.ts:205-217`），少一个字段 `addAssistantUsage` 会 NaN。
"什么算过"：不修实现时这条 it 红（`usage` 总量小于冷读）、修完绿；另外 4 条既有 it 保持绿。

### 5.5 S2.3 的确切改法

`[MT] daemon-protocol.ts` 的 `DAEMON_COMMAND_PLANE`（官方 `:864` 起、`:971` 的 `satisfies` 收尾）里加一行，位置按字母序或紧跟其他 control 命令：
```ts
	declare_client_capabilities: "control",
```
配套断言（`[MT] test/daemon-protocol.test.ts:462-467` 那条 it 里）：
```ts
		expect(DAEMON_COMMAND_PLANE.declare_client_capabilities).toBe("control");
```
裁定理由见 I7（三条实测）。"什么算过"：`npm run check` 绿（`satisfies Record<DaemonCommandName, ...>` 会强制键集完备）。

### 5.6 S1.2 第 1 步 `repl.py` 的确切融合代码

把 `[MT] prime-agent-runtime/src/rlm/repl.py:721-762` 整块替换为（= theirs 的全部逻辑 + ours 的 4 行硬化，硬化放在所有 dump/redump 之后、仍在 `with fh:` 内）：
```python
            fh, tmp = stage_temp(path, "wb")
            with fh:
                def dump_to_temp(candidate: dict[str, bytes]) -> int | None:
                    writer = _CappedWriter(fh, max_bytes)
                    try:
                        dill.dump(candidate, writer)
                    except _SnapshotSizeLimitExceeded:
                        return None
                    return writer.written

                def redump_to_temp(candidate: dict[str, bytes]) -> int | None:
                    fh.seek(0)
                    fh.truncate()
                    return dump_to_temp(candidate)

                bytes_written = dump_to_temp(payload)
                if bytes_written is None:
                    # Prefix pickle size is monotonic because each prefix only adds a string key and bytes value.
                    items = list(payload.items())
                    if redump_to_temp({}) is None:
                        return {"error": "write failed: snapshot exceeds aggregate snapshot size cap"}
                    low, high = 0, len(items) - 1
                    while low < high:
                        mid = (low + high + 1) // 2
                        if redump_to_temp(dict(items[:mid])) is None:
                            high = mid - 1
                        else:
                            low = mid
                    for name, _ in items[low:]:
                        skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
                    payload = dict(items[:low])
                    # The search's last attempt may have overflowed the temp; rewrite the chosen prefix.
                    bytes_written = redump_to_temp(payload)
                    if bytes_written is None:
                        return {"error": "write failed: snapshot exceeds aggregate snapshot size cap"}
                # fork(#1249): durability + private mode on the staged snapshot payload. Must stay
                # inside `with fh:` and after every dump/redump: redump_to_temp() seeks+truncates,
                # so an earlier fsync would be wasted and fchmod could land on a mid-state.
                fh.flush()
                os.fsync(fh.fileno())
                if hasattr(os, "fchmod"):
                    os.fchmod(fh.fileno(), 0o600)
```
这一步的门（Python 侧没有可跑的测试环境，见 Z5）：
```bash
grep -c -E "^<<<<<<<|^=======|^>>>>>>>" prime-agent-runtime/src/rlm/repl.py     # 期望 0（必须 -E，BRE 的 $ 在 \| 分支里是字面量，旧写法数不到 ======= → 假绿）
grep -c 'serialized_payload\|_SnapshotBuffer' prime-agent-runtime/src/rlm/repl.py  # 期望 0（两个符号在官方架构下都不该存在）
grep -c 'os.fchmod(fh.fileno(), 0o600)' prime-agent-runtime/src/rlm/repl.py      # 期望 2（payload + manifest 各一份）
python3 -c "import ast,sys;ast.parse(open('prime-agent-runtime/src/rlm/repl.py').read())" && echo SYNTAX_OK
```
（若老板批准搭 Python 环境：`cd prime-agent-runtime && uv sync --group dev && uv run --with pytest pytest test/test_repl.py -q`；`uv` 在 `/Users/a1/.local/bin/uv`，dev 组是 `dill`。
**【v2.2 修正 = build-stage-a 实测】原命令 `uv run pytest` 会假红 40 条**：`pyproject.toml` 的 `[dependency-groups] dev = ["dill"]` **不含 pytest** → `.venv/bin` 里没有 pytest → `uv run pytest` **穿透到 `/opt/homebrew/bin/pytest`**，那个 Python 没有 dill → 所有快照用例拿到 `{'error': "dill unavailable: No module named 'dill'"}` → `40 failed, 62 passed`。
**正确命令必须带 `--with pytest`**（ephemeral overlay，不改 uv.lock，实测 sha256 跑前跑后不变）→ `100 passed, 2 subtests passed, EXIT=0`。
**build-stage-a 另给出硬证据**：`git diff --name-only 5b6c0e94e upstream/main -- prime-agent-runtime/` = 只有 `src/rlm/repl.py`，官方从未碰 `test/test_repl.py` → 那 100 个测试是本地 fork 针对 ours 架构写的，在「theirs 架构 + ours 硬化」的融合实现上全绿 = 融合同时满足本地测试面与官方新架构。
**已知缺口（进 S9 audit-findings）**：ours 那 4 行硬化（fsync/fchmod 0600）在 Python 侧**零测试覆盖**（`grep -n '0o600\|st_mode\|S_IRUSR' test/test_repl.py` = 0 命中），翻回把手只能用 `grep -c fchmod`（2↔1）。同类：#1249 的私有模式在 runtime 侧无门。）

### 5.7 `appendCompaction` 的确切融合（Z6 + S1.4 陷阱 1，两半一起解）

`[MT] session-manager.ts:1753-1765` 的签名块 → options 对象（与批 3 决定 4 一致；我已核实 10 个测试调用点全部只传 ≤6 个位置参，不受影响）：
```ts
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		customInstructions?: string,
		options?: { leafId?: string; usage?: Usage },
	): string {
		const targetLeaf = options?.leafId ?? this.leafId;
		const entry: CompactionEntry<T> = {
			/* ...原样... */
			usage: options?.usage,
		};
```
（若不想动签名，最小改法是保留 7 参 `leafId?: string` 再加第 8 参 `usage?: Usage`——lane D §6.2 假设的就是这个形状，`compaction-branch-boundary.test.ts` 两种都能过。二选一，但**必须在解块 9 之前定死**，因为第 10 步的调用点写法取决于它。）

`[MT] agent-session.ts:8103-8123`（块 1）→ **取 theirs（空）**，并把 ours 的 `compactionLeafId` 嫁接到块外那个存活的调用点 `:8082`：
```ts
			this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				customInstructions,
				{ leafId: compactionLeafId ?? undefined, usage },
			);
```
`[MT] agent-session.ts:11103-11110`（块 2）→ **两边都留**（ours 的 `signal?.throwIfAborted();` 与 theirs 的 `const spawnedByRequestId = this.isStreaming ? this._semanticEdges.lastTurnRequestId : undefined;` 互不相干，而 `spawnedByRequestId` 在 `:11217` 被使用 → 只取 ours 会编译不过）。

这一步的门：
```bash
grep -c 'sessionManager.appendCompaction(' packages/coding-agent/src/core/agent-session.ts   # 期望 1（不是 2）
grep -c 'compactionLeafId' packages/coding-agent/src/core/agent-session.ts                  # 期望 2（:7984 定义 + 调用点）
```

`daemon-protocol.ts` 块 5（`[MT] :1110-1148`）另有一个同类小坑，任务书没提：ours 是 `missingDeclaredCommandCapability()`、theirs 是 `meetsDaemonCommandCompatibility()`，**两个不同函数共用块后那一个 `}`**。直接"两边都留"会得到语法错。正确形状：
```ts
export function missingDeclaredCommandCapability(/* ours 原样 */): DaemonServerCapability | undefined {
	/* ... */
	return undefined;
}

export function meetsDaemonCommandCompatibility(/* theirs 原样 */): boolean {
	return (/* ... */);
}
```
即在两段之间补一个 `}` + 空行。

### 5.8 40 提交 → merge 模型的动作映射（替代 Z3 里那份自相矛盾的四批表）

merge 模型下 40 条**全部自动进来**，"批次"只剩两件事：① merge **前**必须定死的裁定；② merge **后**必须逐条核对的附带动作。

**merge 前必须定死（6 条，比任务书的 5 条多 1）**：批 3 的 5 条（`refreshWorkerSummaries` 签名 / `scheduleWorkerSummaryRefresh` 去留 / `agent_roster` 能力集落点（**按 §5.3 改，不要进 DEFAULT**）/ `appendCompaction` 形状（**按 §5.7**）/ schema 27 最后算），再加第 6 条：**`omitStreamingMessages` 协议面字段留不留（I5）**——它决定 wire 形状，从而决定 digest，必须在解 `daemon-protocol.ts`（第 6 步）之前定。

**merge 后 checklist（按 lane A 分级；"附带动作"是 git 不会替你做的那部分）**：

| 分级 | PR（sha） | merge 后必须人工做的附带动作 |
|---|---|---|
| CLEAN 11 | #1893(`c382f0985`) #1910(`c718bf3c3`) #1927(`9f712708b`) #1895(`4e42fab2c`) #1911(`71c010826`) #1631(`083c68dc0`) #1948(`85ac06e9b`) #1993(`3f02aa5d6`) #1992(`cd10724fe`) #2002(`7f21fa343`) #1985(`4f3015271`) | #1948 删了 44 行 `4531-agent-message-ui.test.ts` → 按 AGENTS.md"删功能前先问"确认理由；#1985 必须**连带删本地 test 里 `agentStatusChanged` 的 5 条断言**（官方删了这个符号）；#1895 注意本地 `getQuietDurationLabel` 会拼在新增 workerState 标签之后；#1631 后单独跑 `test/interactive-update-relaunch.test.ts`；#1927 与别 lane 的未提交 `openai-completions.ts` 撞面（S0.1 必须先裁） |
| REBASE 13 | #1920(`cbc0f7d7d`) #1918(`9f5edc192`) #1909(`15ef45668`) #1945(`1b5830f0f`) #1946(`23e551522`) #1944(`6179a608f`) #1951(`0749e0667`) #1954(`3da8c5a1c`) #1956(`c394506e2`) #1960(`c32f27257`) #1961(`81ae3cb34`) #1971(`0ba0423c5`) #1987(`118c1d90d`) | #1945 → **§5.6 的 repl.py 融合**；#1971 → session-lease 块取 theirs（pin 已在官方调用侧，`[MT]:165`），保留 `isReclaimableOwnLease`/`activeLeaseDirectories`（块外已存活）；#1920 → `daemon-session-list.ts` 本地 `summaryWithoutStreamingMessage` 与官方 `isEvictableEmptySessionSummary` 都留；#1918 → `main.ts` 官方 try/catch 三态 vs 本地 `parsed.acpResident` 需缝合；#1909 → `daemon-agent-connection.ts` 的 `attach()` 整块重缩进 vs 本地 `"streaming_deltas"` 一行（lane D 子报告 `sync_d_transport.md` §2.3 有融合后可直接用的代码）；#1944 → 核 `emitChildUpdate` 调用侧是否已被本地间隔节流挡住（lane A §3.2）；#1987 → 本地 `replayCache` 三笔钩子重新落位到 `event-log` **调用侧**（lane D 子报告 `sync_d_eventlog.md` §4.3 有完整可用代码 + 3 处块外必改）；#1956/#1961 → **见 Z4：版本号已自动完成，只做校验** |
| CONFLICT 10 | #1897(`8d5722ee9`) #1900(`1d2e91d3b`) #1926(`173d845a5`) #1929(`74c8d39ee`) #1957(`7941b3182`) #1967(`d72beaf9e`) #1885(`1768ace56`) #1984(`1c07eaad5`) #1986(`616557280`) #2003(`d74a75fea`) | 这 10 条就是 18 个冲突文件 / 43 块的来源，按 S1.2 的 20 步走。**#1957 单独说明**：lane A §1 第 32 行说"本地有 12 处调用 `flushAgentTraceUpload` → 编译断裂，必须手工迁移到 outbox API"，**这条我实测是错的**：`git grep -c flushAgentTraceUpload` 在 `5b6c0e94e`（分叉点）与 `HEAD` 的分布**完全相同**（`agent-session-runtime.ts:3` / `agent-session.ts:2` / `agent-traces.ts:1`(定义) / `test/agent-traces.test.ts:7`），`git diff 5b6c0e94e..HEAD` 里这些调用点**一行都没被本地改过**，合并树里该符号 **0 命中**、`test/agent-traces.test.ts` 合并后 = 官方 1569 行版本（本地是 1053 行）→ 官方删除干净落地，**没有编译断裂、没有需要迁移的本地调用点、没有幻影工作项**。施工代理若照 lane A 去找"12 处调用"会找不到 |
| SKIP 6 | #1899(`a903d4b67`) #1952(`3d639f7ba`) #1955(`48c69d412`) #1965(`e72da0059`) #1966(`408e74904`) #2021(`6950bc88a`) | merge 模型下"SKIP"**不是动作**：这 6 条会随 merge 一起进来。#1952+#1955 净效果为零（任务书 S7.5 三条证据）→ 进来无害；#1899/#1965/#1966 是 `.github` 资产（VOUCHED.td / issue 模板 / linear-ticket.yml）→ 进来后 fork 不跑官方 CI，无害，但 `linear-ticket.yml` 的门禁从 `eng-\d+` 改成 `res-\d+`，若 fork 自己的 workflow 复用了它会失效，S9 记一笔；**#2021 必须进来**（S7.6 已裁：#1885 的必需后续）。若老板真要"不拿"某几条，只能在 merge 后 `git revert <sha>`，任务书要写明 revert 的顺序与代价（S7.6 已经论证过 revert 三条交织提交风险高于收益） |

### 5.9 本地独有测试的枚举与跑法（补 I3）

```bash
cd /Users/a1/Desktop/ai/prime-agent
git ls-tree -r --name-only HEAD | grep -E '\.test\.ts$|^prime-agent-runtime/test/test_.*\.py$' | sort > /tmp/r3_head_tests.txt
git ls-tree -r --name-only upstream/main | grep -E '\.test\.ts$|^prime-agent-runtime/test/test_.*\.py$' | sort > /tmp/r3_up_tests.txt
comm -23 /tmp/r3_head_tests.txt /tmp/r3_up_tests.txt > /tmp/r3_local_only_tests.txt
wc -l < /tmp/r3_local_only_tests.txt        # 期望 54（其中 packages/coding-agent 49 = lane D 的 orphan_all.txt）
grep -v '^packages/coding-agent/' /tmp/r3_local_only_tests.txt   # 这 5 个是 S8.2 漏掉的
```
跑法（两条，runner 不同）：
```bash
# vitest 侧（在施工 worktree 内，按 AGENTS.md 用 npx tsx 而不是 npm test）
cd <wt>/packages/coding-agent && env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_MAX_DEPTH -u FORCE_COLOR -u PRIME_AGENT_INTERNAL_DAEMON_WORKER \
  npx tsx ../../node_modules/vitest/dist/cli.js --run $(sed -n 's|^packages/coding-agent/||p' /tmp/r3_local_only_tests.txt | tr '\n' ' ')
# node:test 侧（packages/tui 的 3 个本地独有文件 + 官方改过的 markdown.ts 相关两个）
cd <wt>/packages/tui && node --test --import tsx test/keybindings-override.test.ts test/kill-ring.test.ts test/undo-stack.test.ts test/markdown.test.ts test/markdown-latex.test.ts
```
（这两条我**没有执行**——铁律禁止我跑测试。命令形状按仓里 `packages/tui/package.json` 的 `test` 脚本与 AGENTS.md 的 vitest 调用方式拼出，施工前先在 worktree 里用 1 个文件试跑确认 runner 可用。）

### 5.10 回滚 / 放弃路径（补 I9，全部只在施工 worktree 内动作）

```bash
WT=/Users/a1/Desktop/_wt_prime/sync-r3
# A. merge 解到一半要退（S1 是一个 merge commit，中途没有提交点，只能整体退）
git -C "$WT" merge --abort
git -C "$WT" status --short            # 期望空
git -C "$WT" log --oneline -1          # 期望 0c504e475
# B. 整个工单作废、连分支一起丢
git -C "$WT" merge --abort 2>/dev/null || true
git worktree remove --force "$WT"      # 有未提交改动时必须 --force
git branch -D sync/upstream-r3
git worktree list | grep -c sync-r3    # 期望 0
# C. 自证主仓与其它 19 个 worktree 未受影响（这是选 S0.1(c) 的全部意义）
git -C /Users/a1/Desktop/ai/prime-agent status --porcelain   # 期望与 S0.1 清单逐字一致（+ M10 那条 ?? 文档）
git -C /Users/a1/Desktop/ai/prime-agent log --oneline -1     # 期望 0c504e475
git worktree list | wc -l                                    # 期望回到开工前的数字
```
**【v2.1 补：中间态保全与恢复流程】（rev2-flow I8 —— v2 只有 `cp` 存盘，没写恢复流程）**

存盘（每阶段结束做一次，不是每步）：
```bash
WT=/Users/a1/Desktop/_wt_prime/sync-r3
STAGE=stage-B   # 按 lane D 的阶段 A-E 命名
mkdir -p /tmp/r3_wip/$STAGE
# 把本阶段已解的文件按原路径结构存进去
cd "$WT" && git diff --name-only --diff-filter=U > /tmp/r3_wip/$STAGE/_still_unresolved.txt
cd "$WT" && git diff --cached --name-only | while read f; do mkdir -p "/tmp/r3_wip/$STAGE/$(dirname "$f")"; cp "$f" "/tmp/r3_wip/$STAGE/$f"; done
echo "$STAGE 存盘 $(date -u +%FT%TZ)，已解 $(cd "$WT" && git diff --cached --name-only | wc -l) 个文件" >> /tmp/r3_wip/PROGRESS.md
```

恢复（`merge --abort` 或断电之后）：
```bash
cd "$WT"
git merge --abort 2>/dev/null || true
git status --short                      # 期望空
git merge upstream/main                 # 重新触发同一批冲突（freeze-sha 未变 → 冲突集必然相同）
# 把存盘的已解文件 cp 回来
cd /tmp/r3_wip/$STAGE && find . -type f ! -name '_still_unresolved.txt' ! -name 'PROGRESS.md' \
  | sed 's|^\./||' | while read f; do cp "$f" "$WT/$f"; git -C "$WT" add "$f"; done
git -C "$WT" diff --name-only --diff-filter=U   # 剩下的就是未解的，从那里继续
```

**硬要求（配合主文档铁律 2 新增条）**：
1. **每步解完即 `git -C "$WT" add <该文件>`** —— merge 过程中 `add` 是合法的进度固化（标记该文件冲突已解），不加则 `merge --abort`/断电时前 N 步成果一视同仁全丢。
2. **每阶段（lane D 的 A-E）结束 cp 一次快照 + `PROGRESS.md` 记一行**。
3. **取舍理由写在哪**：S1 只有**一个** merge commit，所以 43 块的回执不能靠提交信息承载 → 全部落 `/tmp/r3_conflict_receipts.md`（铁律 15），merge commit 的 message 里只写「回执见 /tmp/r3_conflict_receipts.md（或合回时随 S9 归档进 docs/fork/）」+ 阶段小结。

**【明示】「攻坚到一半保住已解部分并落地」在结构上不存在**：merge 是原子的，第 17 步卡住时没有合法的部分提交状态。只有「整体退」或「存盘续做」两条路（主文档 S8.5 第 6 点）。

### 5.11 三个核查脚本的最小可实现规格（补 Z7；原脚本不存在）

**【v2.1 修正首句矛盾 = rev2-flow I3，K3 B-2 的病在附录里残留】**
**基线只在 archive 树跑一次**：`git archive 3cd22c1a0 | tar -x -C /tmp/mt_r3`（根代理已导出，1376 文件），期望 `0 / 0 / 1`（第 3 条的 1 就是 H1）。
**之后每一轮都必须在当前工作树（或 `git write-tree` 出的新树）上跑**，期望逐步收敛到 `0 / 0 / 0`。
⚠ 若两轮都跑在 archive 固定树上，第二轮恒得 `0/0/1` → 门永远过不了 → 施工代理会开始糊弄（这正是主文档铁律 10 要防的）。archive 树是**只读基准**，不是核查对象。

**【实现状态】第 3 条已由根代理实现并三重验证：`/tmp/r3_check_tables.mjs`**
- 合并树基线实测：`DAEMON_COMMAND_COMPATIBILITY` 键=107 成员=107 ✓；`DAEMON_COMMAND_PLANE` 键=106 成员=107 ✗ **缺=[declare_client_capabilities]** → 破口 1，与 lane D 的 `0/0/1` 一致
- 两侧干净树交叉验证：`[HEAD]` 104/104 ✓、`[UP]` 106/106 ✓（两张表）
- 反向验证：构造「官方文件 + 联合加一成员 + COMPATIBILITY 补键 + PLANE 故意不补」→ 输出与真合并树**逐字相同**
- **重写时会踩的两个坑（已修，务必注意）**：① 联合成员内部含分号（`{ id?: string; type: "x" }`），**终止符不能用 `;`**，必须扫到下一个顶层声明，否则在干净树上也 100% 解析失败；② `list_saved_sessions` 定义在独立类型 `DaemonSavedSessionListCommand`（`[HEAD] daemon-protocol.ts:433`）由 `DaemonCommand` 联合引用，**不递归展开子联合会漏成员，把合法键误报成「多」**
- **`KEYBINDINGS`（`[HEAD] keybindings.ts:299`）是 `satisfies Record<string, Keybinding>`，键类型 `string` 无有限约束 → 跳过不检查**（58 键）。所以「全仓 3 张表」里实际只有 **2 张**受总量约束
- **fail-closed 纪律**：解析不出键类型一律**计为破口**，绝不静默跳过（第一版静默跳过 → 在合并树上报「破口 0」的假绿）
- 用法：`node /tmp/r3_check_tables.mjs <tree-root>`，EXIT=1 表示有破口

第 1、2 条仍需实现，规格如下：

1. **悬空 import**（lane D 的方法：解析每个 `import {…} from "./x.js"`，递归展开 `export * from` / `export type {…} from`，逐符号确认目标模块真的导出了它）。最小实现：只处理**相对路径 + 命名导入**，跳过 `import type`、跳过 `packages/ai/scripts/generate-models.ts`（构建期生成物）与模板字符串里的伪 import（lane D 记录的 2 个既有假阳性）。判据：真阳性 0。
2. **重复顶层声明**：扫 `^(export )?(async )?(function|class|interface|type|enum|const|let) <name>` 的顶层声明，同文件同名计数 > 1 即命中。判据：0。
3. **总量映射表完备性**（最便宜、收益最高，H1 就是它抓到的）：找所有 `as const satisfies Record<K, V>`，把 `K` 的联合类型成员枚举出来与映射表键集做差。本轮全仓只有 3 张表（`DAEMON_COMMAND_PLANE`、`DAEMON_COMMAND_COMPATIBILITY`、`DAEMON_OUTBOUND_COMPATIBILITY`），后两张我实测完备（107 键 / outbound 全键）。判据：差集为空。
若来不及实现 1 和 2，**至少实现 3**，并把 S8 第 4 道门改写成"总量映射表完备性 = 0 破口"+ 一条替代门：`cd <wt> && npx tsgo --noEmit`（它抓 1/2 的大部分实例，代价是慢）。

---



### 5.12 【新】S7 摘取操作序列（补 rev2-flow I6 —— v2 只写「TAKE」，没写怎么摘，开工后 S7 必卡）

三个 TAKE 都是**官方仓的 open PR**，merge 不会带进来，必须单独摘。落点：**S5 之后、S8 之前**（schema 27 已定型，避免摘完又改 wire）。

**摘取前必过铁律 13（摘取守门）**：
```bash
WT=/Users/a1/Desktop/_wt_prime/sync-r3
cd "$WT"
# 本地 54 个独有测试清单（S4 / §5.9 生成）应已在 /tmp/r3_local_tests.txt
for N in 2027 1947 1896; do
  echo "=== PR #$N 的改动面 ∩ 本地独有测试 ==="
  gh pr diff $N --repo PrimeIntellect-ai/prime-agent --name-only > /tmp/r3_pr${N}_files.txt
  comm -12 <(sort /tmp/r3_pr${N}_files.txt) <(sort /tmp/r3_local_tests.txt) | tee /tmp/r3_pr${N}_guard.txt
  # 交集非空 = 这次摘取会连守门测试一起覆盖 → 必须先把这些测试单独保住（另存 + 摘完后还原）
done
```

**摘取（两条路，优先 A）**：
```bash
# 路 A：cherry-pick -x（保留来源可追溯）
git fetch upstream pull/2027/head:r3-pr-2027
git cherry-pick -x r3-pr-2027            # 冲突则逐 hunk 解，解完落回执（铁律 15）
# 路 B：PR 的 base 不是 upstream/main 时（本轮三个都是 main，理论不需要）
gh pr diff 2027 --repo PrimeIntellect-ai/prime-agent > /tmp/r3_pr2027.patch
git apply --3way /tmp/r3_pr2027.patch
```
**禁止 `patch -f` 兜底**（lane B 附录的坑：它会把反向补丁静默跳过并返回 0，lane B 第一版因此把 #525 的 6 个 STALE 全报成 CLEAN）。

**每个 PR 的冲突预期与退路**：
| PR | 改动面 | 冲突预期 | 退路 |
|---|---|---|---|
| **#2027** | `agent-session.ts` 为主（3f, +167-92） | **高**：`agent-session.ts` 刚在 S1 第 10 步经历大改（449KB / 双方各 24-30 hunk 区） | 若冲突超过 5 块 → 改为**手工移植语义**（照着 PR diff 在合并后的文件上重写），不要硬 cherry-pick |
| **#1947** | kernel stderr 落盘（5f, +140-17） | 中：可能撞本地 F27 内存修复面 | 先确认与本地 `_CappedWriter`/环形缓冲是否互斥（已知不确定项 3）；互斥则**只拿落盘、不拿封顶** |
| **#1896** | 空回合重试（6f, +220-12） | 中 | **必须同时落 fork 侧适配**（幽灵气泡，见主文档 S7.1）；不愿承担则整条降级为观察 |

**摘完的验收**：每个 PR 一个提交（`cherry-pick -x` 自动带 `(cherry picked from commit ...)`），提交后跑该 PR 自带的回归测试 + 受影响面测试；三个都摘完后跑一次全量（对账门口径见主文档 S8 门 6）。

---

# 第二部分 · S1.2 二十步逐步信息缺口表（rev-exec §6）

## 6. S1.2 二十步：每步缺什么信息才能真正动手

`[MT]` 的块位置我都量过了，一并给出（任务书一个块号都没给）。"缺"列是**任务书里找不到、施工代理必须去别处翻或自己推**的信息。

| 步 | 文件（应写成仓根全路径，见 M4） | 块数 / `[MT]` 块行号 | 任务书给了什么 | 缺什么才能动手 |
|---|---|---|---|---|
| 1 | `prime-agent-runtime/src/rlm/repl.py` | 1 / 721-762 | 只有文件名 | **两侧各改了什么**（ours = #1249 的 flush/fsync/fchmod 4 行；theirs = #1945 的 `_CappedWriter` 直写 + 二分）、**两侧都不能整取**（`serialized_payload` 定义已被自动删除）、融合代码（§5.6）、**门跑不起来**（无 Python 环境）。lane A §3.4 有方案，任务书没引用 |
| 2 | `packages/coding-agent/src/core/session-lease.ts` | 1 / 129-136 | S3 说了 #1971 官方更全、删本地一半、留 `isReclaimableOwnLease` | 块的确切内容、"整块取 theirs"的许可（在 lane D §9 不在任务书）、以及**取 theirs 后 pin 去哪了**（答：官方调用侧 `[MT]:165`，pin 得更全）。我核过 `isReclaimableOwnLease`/`activeLeaseDirectories` 在块外存活 → 无矛盾 |
| 3 | `.../src/modes/daemon/daemon-worker-client.ts` | 1 / 1L ours 0L theirs | S2.4 说必须同步改 `attachedClients` → `attachedClientCount()` | 块内容、"整块取 theirs"的许可、**`attachedClients` 要改几处/在哪**（任务书只说"施工到 `daemon-agent-connection.ts` / `daemon-mode.ts` 时必查"，没给命中数）。R4 的原始论证在 lane A §8，任务书没抄 |
| 4 | `.../src/modes/agent-connection/types.ts` | 1 / 1L ours 2L theirs | 无 | 只缺一句"纯 import/类型并集"（lane D §3.8 有）。机械 |
| 5 | `.../test/daemon-mode.test.ts` | 1 / 1L 1L | 无 | 缺结论：并集成 `import { basename, dirname, join, resolve } from "node:path";`；文件里 `DAEMON_SCHEMA_ID` 的断言用常量不用字面量 → **升 27 时无需改**（lane D §6.1）。这条"无需改"很重要，否则施工代理会去动 9530 行的文件 |
| 6 | `.../src/modes/daemon/daemon-protocol.ts` | **5** / 78-98, 150-161, 220-266, 836-852, 1110-1148 | S2.1 / S2.3 / S5 / 裁定 1、2、6 | **5 个块各是什么**（任务书一个都没描述）：**块1(`:78-98`) = revision 注释史 + `DAEMON_SCHEMA_REVISION` + `DAEMON_SCHEMA_ID`，两侧各一份**（ours `:89/:90` = 26-`31fb64b6f4ee`，theirs `:96/:97` = 26-`962b8b4c5e35`）→ 必须合成一份，且撞上 I13 的两遍走问题；**块2(`:150-161`) = `DaemonServerCapability` 联合尾部**（ours 多 `list_without_streaming_messages`+`control_plane`，theirs 多 `direct_peer_transport`；`agent_roster` 已在块外 `:140` 自动进来）→ 取并集；**块3(`:220-266`)** = ours 的 `DAEMON_KNOWN_DECLARED_CAPABILITY_SET` + `normalizeDeclaredCapabilities` + 两个 FIRST_PARTY 集 + `DAEMON_CONTROL_PLANE_COMMANDS` vs theirs 的 `DaemonPeerTransportTicket` 接口 → 两边都留 + **§5.3 的改法落在这里**（注意 `DAEMON_DEFAULT_SERVER_CAPABILITIES` 本身在**块外** `:199-218`，已自动合并成含本地两个额外能力、不含官方两个 supervisor-only 能力，正好是 §5.3 想要的形状）；**块4(`:836-852`)** = `AGENT_PEER_LIST_COMMAND` 24/23 + `DIRECT_PEER_TRANSPORT_COMMAND`（I6 已裁）；**块5(`:1110-1148`)** = 两个不同函数共用一个 `}`（§5.7 末尾） |
| 7 | `.../src/main.ts` | 1 / 6L 2L | 无 | 缺 H10（`main.ts:83` 的 `import { deserializeDaemonError }` 合并后无使用点 → 删）与 #1918 的缝合点（lane A 批1：官方 try/catch 三态 vs 本地 `parsed.acpResident`） |
| 8 | `.../src/cli/daemon-launch.ts` | 1 / 5L 4L | S5.3 提到 `daemon-launch.ts:95` 用 `DAEMON_SCHEMA_ID` 拒连接 | 缺块内容与"官方新逻辑 + 本地 declaredCapabilities 重施加"这条取舍（lane D §8 序 8） |
| 9 | `.../src/core/session-manager.ts` | **5** / 36-48, 1128-1151, 1245-1259, 1266-1308, 1760-1764 | S2.2 给了 P0-B 的方向 + 3 个累加器代码原文 | 缺：① 5 个块的确切形状与"块2/3/4 都不能整取"；② `SessionScanState` 在**块外**（`:1060`）；③ 块 5 = `appendCompaction` 签名（Z6）；④ 确切代码（§5.4 + §5.7）。**这一步是全部 20 步里信息缺口最大的**（lane D 估 3.5h） |
| 10 | `.../src/core/agent-session.ts` | 2 / 8103-8123, 11103-11110 | S1.4 陷阱 1（双 `appendCompaction`）+ 批 3 决定 4 | 缺块 2 的内容与"两边都留"的结论（§5.7）；缺"块 1 取 theirs + 把 `compactionLeafId` 嫁接到 `:8082`"的确切写法；缺 H4（`compactionLeafId` 声明在块外 `:7984`）；另 S7.1 的 #2027 也落在这个文件（`cancelRunningRlmDescendants` 5 处）→ **同一文件要改两轮**，任务书没说顺序关系 |
| 11 | `.../test/agent-session-recursion.test.ts` | 2 / 63L 39L | 无 | 缺结论：两块都是"两侧各加各的测试，全留"；依赖检查（本地两个测试依赖 `ReplKernelManager`/`_createKernelHostHandlers`，官方那个依赖 `_rlmChildSessions`）在 lane D §6.1 |
| 12 | `.../src/modes/agent-connection/daemon-agent-connection.ts` | 3 / 32L 53L | S2.1 后果链 2 的 `:492 .catch(()=>undefined)`、S2.4 | 缺"三参 `requestData` + `streaming_deltas` + `rosterStore` 并存"的融合方案。**lane D 子报告 `sync_d_transport.md` §2.3 有融合后 `attach()` 的可直接用代码**，任务书提了子报告存在但没指向这一节 |
| 13 | `.../src/modes/agents-view/agents-view-state.ts` | 2 / 20L 1L | S1.4 陷阱 3（`propagateHeartbeatStateToAncestors` 调用点被删、定义活在块里） | 缺块 2 "整取 theirs"的许可（lane D §9）；**缺 H8**：`getQuietDurationLabel`(`:1052`) 的两个调用点都在块内（`:725`/`:832` ours）→ 两块都取 theirs 会让本地"(no activity Xm)"功能静默丢失。任务书只写了 H7 没写 H8，而这两条的取舍方向相反（H7 的函数该不该留要判断，H8 的调用点必须留） |
| 14 | `.../src/modes/agents-view/agents-view-mode.ts` | 4 / 50L 17L | S2.1 后果链 3（`:2429`[UP] = `[MT]:2500`）、裁定 4 | 缺"块 1 的 declaredCapabilities 不能丢"（lane D §8 序 14）；缺 `createAgentsViewListCommand` 退回 0 参 + 3 处调用点（`:1908`/`:2164`/`:2495`，lane D §7.1）——**而这条与 I5 的裁定绑定** |
| 15 | `.../src/modes/daemon/daemon-mode.ts` | 1 / 2L 1L | S1.2 注"含 #1229 存活确认"、S2.4、S2.6 | 缺 H9（`:3561` 用 `isSessionPlaneDaemonCommand`，import 在块 theirs 侧 → 块取 ours 会未定义）；缺"解完要复核 4 条块外存活资产"（lane D §3.11）；缺 #1229 要确认的**具体点位**（S3 表里有 `:1403`/`:4016`/`:6760`/`:7189` + `active-session-state.ts:61`，但没标那是 `[MT]` 行号，见 I4） |
| 16 | `.../src/modes/daemon/rlm-ledger.ts` | 2 / 726-804, 824-866 | S1.4 陷阱 2（两边都编译不过）、S3 的 replayCache 下沉裁定、S7.6 的 `event-log` 事实 | **【v2.2 修正 = p6 实测 + build-stage-a 独立复核：附录原「5 处修补」过度计数】** 按 S7.6 定案实际只需：import 补 **1 个** `statSync`（删掉 `readAllSync`/`truncateTornTailSync` 后其余 4 个符号变 0 使用者，补进去会被 biome/tsgo 报未使用）、`:897-898` **一字不改**（块内声明回 `stats`/`size` 就原样可用，重写反而破坏 `cloneLedgerEdges` 的 cache 隔离）、replayCache **4 个操作点 + 1 处随删除消失**（第 5 处是 `truncateTornTailSync` 里那次失效，其唯一调用者就是 appendRecord，语义被 `:730` 完全覆盖）。p6 已按此落地；**缺"完整可用代码"的位置**——lane D 子报告 `sync_d_eventlog.md` §4.3 明说有，任务书没指路。我独立复核了 H5/H6 成立（C11） |
| 17 | `.../src/modes/daemon/daemon-supervisor.ts` | **7** / 116L 54L | 批 3 决定 1、2；S3 的"名单/摘要刷新轴取官方" | 缺 7 个块的位置与内容；缺 H2 的 12 处 `refreshWorkerSummaries` 调用点分类（**3 处本地形必须改签名：`:3380`/`:3572`/`:3984`；9 处官方形取 theirs 后自动正确：`:1159`/`:1186`/`:1198`/`:1257`/`:1276`/`:4282`/`:4578`/`:4909`/`:5030`**）；缺 H11 的两个孤儿声明（`:227 SUMMARY_REFRESH_MIN_INTERVAL_MS`、`:393 interface CoalescedSummaryRefresh`）；缺 §7.1 的 omit 尾参改造（`refreshWorkerSummaries(worker, recovery=false, fillGaps=recovery, retried=false, omitStreamingMessages=false)`）；缺 #1929 那块"HEAD 侧 67 行 / 官方侧 0 行"（`:3604-3673`）的处置——它正是决定 2 的落点。**这一步 lane D 估 5h，我判断 8-12h（见 §7）** |
| 18 | `.../test/daemon-protocol.test.ts` | 3 / 8L 6L（`[MT]` 标记在 12, 30, 417） | 裁定 3（`wait_for_headless_completion` 断言跟实现） | 缺块 1/2 是 import 并集（`DAEMON_CONTROL_PLANE_COMMANDS` + `DAEMON_COMMAND_PLANE` 都留、三个函数都留）；缺 lane D 要求**新增的两条断言**（PLANE.declare_client_capabilities、capability ⊆ FIRST_PARTY 门，§5.3/§5.5 已给代码）；缺一条任务书和 lane D 都没提的：**官方那条 `not.toContain("direct_peer_transport")`（`[MT]:458`）必须继续绿**（Z1） |
| 19 | 孤儿测试处置（S4） | — | S4 表 8 行 | 缺路径（I10）、缺 4 vs 6 的口径、缺 `daemon-supervisor-streaming-list.test.ts` **重写成什么**（lane D 给的目标"legacy-worker shim 路径 + omit 尾参"依赖 I5 的裁定）、缺 w7 要改的确切行（I11 = `:165`）、缺 `f1-*`/`fixq3-*` 的新判据（I10） |
| 20 | 自动合并文件复核 | — | S1.5 说"27 无需干预 / 6 需复核"、`interactive-mode.ts` 记为已知未深审 | 缺**那 6 个的名字**（lane D §8 序 20：`compaction.ts`(H12 文档注释错位 + `capKeepRecentTokens` 后缺空行 biome 可能报)、`interactive-mode.ts`、`agent-session-runtime.ts`、`test/agent-connection-daemon.test.ts`（fake 是否同时满足本地 `declaredCapabilities` 与官方三参 `request`）、`daemon-socket.ts`、`markdown.ts`）；**【v2.2 定案 = rev2-facts R7】口径统一为「31 个自动合并文件，其中 5 个需深复核」**（主文档 S1.5 已同步）。v1 的 35、rev-exec 的 6、lane D 的 27/30 都复现不出：实测两侧都改 = 49 = 18 冲突 + **31 自动合并**，这 31 个的 `[MT]` blob 既不等于 `[HEAD]` 也不等于 `[UP]`（逐个 `git rev-parse` 核过）→ 都是真三方融合。深复核 **5 个** = `compaction.ts` / `interactive-mode.ts` / `agent-session-runtime.ts` / `test/agent-connection-daemon.test.ts` / `daemon-socket.ts`；**`markdown.ts` 不在这 31 个里**（官方单侧改动，`local_changed=0`），另列。估时按 31/5 重算 |

---



---

# 第三部分 · 事实核查用过的可复现命令（rev-facts 附录）

## 附：本轮用过的可复现命令（全部只读）

```
git rev-parse HEAD / --abbrev-ref HEAD ; git merge-base HEAD upstream/main
git log --oneline 5b6c0e94e..upstream/main | wc -l          → 40
git log --oneline 5b6c0e94e..HEAD | wc -l                   → 172
git merge-tree --write-tree HEAD upstream/main              → 3cd22c1a0…（rc=1，18 冲突文件）
git merge-tree --merge-base=c394506e2^ HEAD c394506e2       → rc=0，零冲突
git merge-tree --merge-base=81ae3cb34^ HEAD 81ae3cb34       → rc=1，14 冲突
git cat-file -p 3cd22c1a0…:<path>                           → 读合并树（行号含冲突标记）
git rev-list --topo-order --reverse 5b6c0e94e..upstream/main
git show <sha> -- <path> / --numstat / -s --format=…
git grep -n|-c <pat> {HEAD,5b6c0e94e,upstream/main,3cd22c1a0…} -- <path>
git ls-tree -r --name-only {HEAD,upstream/main,3cd22c1a0…} ; git worktree list
python3: 按 test/daemon-protocol.test.ts:82-101 的公式重算 sha256 摘要与三段切片长度
python3: 逐块解析 18 个冲突文件的 <<< / === / >>> 计数（43 块 / 562 / 312）
```


---



---

# 第四部分 · K3 的流程修法（rev-logic，主文档已采纳，此处留证据）

## 验收门必须换树（B-2）
原文缺陷：S8 门 4 写「在 `git archive <merge-tree-oid>` 导出的临时树上重跑三脚本，应保持 0/0/0」。
但 `<merge-tree-oid>` = S0.3 固定的 `3cd22c1a0...`，是**解冲突之前**的自动合并树。
→ 在这棵固定树上重跑，结果恒为 lane D 已测的 `0/0/1`；手工解冲突引入的新破坏一个也检不出；「应保持 0/0/0」永远无法达成（H1 破口在那棵树里恒为 1）。
修法：改为在当前工作树（或 `git write-tree` 出的新树）上跑；施工期基线写「破口 ≤1 且等于已知 H1」，S2.3 落地后归 0。
（rev-exec Z7 补充：那三个脚本**本身不存在**，规格见第一部分 §5.11。）

## 红窗期与依赖倒置根治（B-3）


## 缺合回工单（I-2）
## I-2 全程没有「合回 merge/repl-kernel」的工单；R9 的口径已随 S0.1(c) 过期
证据：S0–S9 十个工单没有一个说 sync/upstream-r3 如何合回。别 lane 的脏文件里 `models.generated.ts` 是 **staged** 状态（我实测 `git status` 第一列 M）。若采纳推荐的 (c)，施工树里没有别 lane 的改动，S2.5 R9「#1927 撞别 lane 未提交文件」在施工树内不成立——真正的撞点在**合回时**：本轮 merge 面里 packages/ai 只碰 `openai-completions.ts`(+5) 与 `anthropic.ts`（我实测 `git diff --stat 5b6c0e94e upstream/main -- packages/ai/`），与别 lane 的 openai-completions.ts 未提交改动必撞。修法：补 S8.5 合回工单（含与别 lane 的交接顺序：谁先落地谁后 rebase），并把 R9 改写为合回风险而非批 0 排序约束。



## 碎片静默删除 33 个（I-3）
## I-3 merge 会静默自动删除 33 个 .changes 碎片，S6.6 的「可删 30」不覆盖
证据：官方在 release 时删了 33 个碎片，本地自分叉点起全没碰过 → merge **无冲突自动删除**（我实测 `git diff --diff-filter=D 5b6c0e94e upstream/main` = 33 条全是 .changes，与本地改动面交集为空）。lane A §5.4 的批准清单只有 30 个。清单外 3 个：`daemon-agent-message-admission.md`、`refresh-model-catalog.md`、`remove-overflow-pattern.md`——我已逐一核实其 bullet 已逐字进官方 [0.9.0] CHANGELOG（含 ai 包的），**删除安全**。但：①S6.6 必须把口径改成「merge 自动删 33，3 个清单外已核实」；②S6.6 说「顺手修 `daemon-agent-message-admission.md` 的格式」与该文件将被删除**直接矛盾**（我核实分叉点内容就缺 `- ` 前缀，本地没碰过 → 是静默删不是 modify/delete 冲突，merge-tree 输出 0 命中）——修一个不存在了的文件。


