# r42 泛扫 · 子面④：thinking 档位映射表的一致性
只读审计（未写仓、未 commit、未 shutdown）。仓库 `/Users/a1/Desktop/ai/prime-agent` HEAD `a609c6ac5`（工作树仅 3 个无关未跟踪 png/out.txt）。
本机实际生效配置：`~/.prime/agent/models.json`（provider `bailian`，api `openai-completions`）——**本面所有"用户可见"结论以这份配置为准**，`packages/ai/src/models.generated.ts` 只作为第二证据面。
去重：`/tmp/audit_r/round-42/decisions.jsonl` 在本席工作期间**不存在**（0 字节/未生成），无重复条目可比对。
证据工件（可复跑）：`/tmp/audit_r/round-42/{dump_maps.ts,probe_payload.ts,probe_clamp.ts,probe_google.ts,maps.json,payload.json,clamp.json,test-ai.log,test-ca.log}`。

---

## 0. 机制地图（先把链路钉死，后面每条都引用它）

档位链共四处"重新解释"点：

1. **合法性集合** `packages/ai/src/models.ts:67-76 getSupportedThinkingLevels`
```ts
return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;                       // 缺键 ⇒ 视为"支持"
});
```
2. **夹取** `packages/ai/src/models.ts:78-95 clampThinkingLevel`（下文 F4 的根因）
```ts
for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {   // 先向上找
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) return candidate;
}
for (let i = requestedIndex - 1; i >= 0; i--) { ... }                       // 再向下找
```
3. **落线映射** 各 provider 的 `model.thinkingLevelMap?.[effort] ?? effort`（openai-completions.ts:915/923/932、openai-responses.ts:266、azure:274、codex:429、anthropic.ts:884、bedrock:594、mistral:640）。
4. **上层（coding-agent）**：`setThinkingLevel`（agent-session.ts:9901-9922）、`setModel/cycleModel/_getThinkingLevelForModelSwitch`（9762-9996）、SDK 起始（sdk.ts:226）、rlm 子代理 thinking 参数（agent-session.ts:14493/14536-14543）。

**实测 payload 表**（`probe_payload.ts`，用本机 `models.json` 逐字重建的 4 个 bailian 模型，`onPayload` 抓包；apiKey="test"，网络 401 不影响 payload）：

| 选择的档位 | qwen3.8-max-0902 | qwen3.8-flash | deepseek-v4.1-flash | **glm-5.3** | kimi-k3 |
|---|---|---|---|---|---|
| off | `reasoning_effort:"none"` | 同左 | `thinking:{type:"disabled"}` | **`enable_thinking:true`** | `reasoning_effort:"low"` |
| minimal | `"low"` | `"low"` | `"low"` | **`enable_thinking:true`** | `"low"` |
| low | `"low"` | `"low"` | `"low"` | **`enable_thinking:true`** | `"low"` |
| medium | `"medium"` | `"medium"` | `"medium"` | **`enable_thinking:true`** | **`"high"`** |
| high | `"xhigh"` | `"xhigh"` | `"high"` | **`enable_thinking:true`** | `"high"` |
| xhigh | `"xhigh"` | `"xhigh"` | `"max"` | **`enable_thinking:true`** | `"max"` |
| max | `"xhigh"` | `"xhigh"` | `"max"` | **`enable_thinking:true`** | `"max"` |

（`preserve_thinking:true` 随 qwen3.8-* 的非 off 档位一并发；表内省略。）

**注册表侧（models.generated.ts，1244 个模型）**：700 个模型 `thinkingLevelMap` 完全缺失；122 个是 `{"minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null}`；45 个 `{"xhigh":"xhigh","max":"max"}`；40 个 `{"off":null}`。空 map 的模型（如 `opencode-go/qwen3.7-max`、`opencode-go/glm-5.3`、`xiaomi/*`）被 `getSupportedThinkingLevels` 判为支持 `off,minimal,low,medium,high`。

---

## F1 [high] bailian/glm-5.3：7 个档位发出**字节完全相同**的 payload，且 "off" 被反转成"开思考"
- **命题**：glm-5.3 上选低档/高档/最大档对请求没有任何影响；请求关闭思考得到 `enable_thinking: true`。
- **file:line** `packages/ai/src/providers/openai-completions.ts:901-902`
- **逐字证据**：
```ts
if (compat.thinkingFormat === "zai" && model.reasoning) {
    (params as any).enable_thinking = !!options?.reasoningEffort;
```
  + `~/.prime/agent/models.json` glm-5.3：`"compat": {"thinkingFormat": "zai", "supportsReasoningEffort": true}`（`supportsReasoningEffort:true` 在同一份配置里是**死配置**，zai 分支先命中且永不读档位）。
  + 抓包：7 档全部 `{"enable_thinking": true}`，其中 `off` 是 `clampThinkingLevel` 把 off 升到 `minimal`（off 在 glm-5.3 的 map 里是 `null`）后 `!!"minimal" === true`。
- **影响**：`/effort` 对 glm-5.3 展示并接受 minimal/low/medium/high/xhigh/max 六档（off 被 map 隐藏），用户以为在调档，实际只有"开"一种状态；想关思考不可能，且不报错。本机 AGENTS.md「glm-5.3 thinking 只能 low/high/max」的经验其实是"档位根本不发"，不是"只支持三档"。
- **复现**：`cd packages/ai && npx tsx /tmp/audit_r/round-42/probe_payload.ts`（读 `~/.prime/agent/models.json` 重建模型后 `onPayload` 抓包），看 `model=="glm-5.3"` 的行；UI 侧 `/model glm` + `/effort low` 与 `/effort max` 各发一轮，抓包/代理对比请求体。
- **confidence**：high（payload 实测 + 代码逐字）。

## F2 [high] 默认档位 "medium" 跨模型语义漂移：在 kimi-k3/glm-5.3 上实为 high
- **命题**：同名的 `medium` 在不同模型上落到不同 wire 值；系统默认档恰恰是 `medium`。
- **file:line** `packages/coding-agent/src/core/defaults.ts:3` + `~/.prime/agent/models.json`
```ts
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
```
  bailian/kimi-k3：`{"off":null,"minimal":"low","low":"low","medium":"high","high":"high","xhigh":"max","max":"max"}`；bailian/glm-5.3 同形；bailian/qwen3.8-*：`medium→"medium"`。
- **影响**：新会话、未指定 `thinking` 的子代理（`agent-session.ts:12857` 用父档 clamp）、`--thinking` 缺省，全部落在 `medium` 上：qwen3.8 家族真实发 `"medium"`，kimi-k3 真实发 `"high"`（成本/延迟上浮），而 session 记录、footer、`appendThinkingLevelChange` 都写 "medium"。跨模型做效果对比时，"medium vs medium" 不是同一个实验条件。
- **复现**：同一 prompt 分别对 bailian/qwen3.8-max-0902 与 bailian/kimi-k3 以默认档跑一轮，比对抓包 `reasoning_effort`（medium vs high）；或直接读上表。
- **confidence**：high。

## F3 [high] bailian/qwen3.8-max-0902：high/xhigh/max 三档塌缩为同一 wire 值 "xhigh"（本机主力模型）
- **命题**：主力模型上"升到 max"与"留在 high"发出的请求完全相同；7 档只有 4 个 wire 值（none/low/medium/xhigh）。
- **file:line** `~/.prime/agent/models.json`（qwen3.8-max-0902 / qwen3.8-flash 均 `"high":"xhigh","xhigh":"xhigh","max":"xhigh"`）+ `openai-completions.ts:932`（map 命中优先）。
- **逐字证据**（上表）：`high→{"reasoning_effort":"xhigh"}`、`xhigh→"xhigh"`、`max→"xhigh"`；`minimal`/`low` 同为 `"low"`。
- **影响**：AGENTS.md 的调度纪律按档位排成本/深度（"深活才给 high"）在主力模型上不可执行；把子代理从 high 提到 max 是零收益操作，会被误判为"已加码"。
- **复现**：payload 表；或 `/effort high` → `/effort max` 抓两次包 diff。
- **confidence**：high。

## F4 [high] `clampThinkingLevel` 是"先向上"的夹取：要便宜档，静默给到最贵档
- **命题**：请求一个模型不支持的档位时，实现优先升档，其次才降档，且没有任何用户可见提示。
- **file:line** `packages/ai/src/models.ts:88-91`（向上循环先执行）
```ts
for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) return candidate;
}
```
- **实测正控**（`probe_clamp.ts`，`deepseek/deepseek-v4-flash`，map=`{"minimal":null,"low":null,"medium":null,"high":"high","xhigh":"max","max":null}`）：
```json
"clamp": {"off":"off","minimal":"high","low":"high","medium":"high","high":"high","xhigh":"xhigh","max":"xhigh"}
"wire":  low -> {"thinking":{"type":"enabled"},"reasoning_effort":"high"}
```
  即 `minimal/low/medium` 三种"更省"的请求全部变成 `high`。
- **影响**：AGENTS.md 派活纪律「机械活显式 thinking="off"/"low"」在任何缺 `low` 的模型上都会变成 `high`（成本反向）；`/effort low`、`--thinking low`、`rlm.run(thinking="low")` 三条入口行为一致——都不报错。
- **复现**：同上脚本；或 `--thinking low` 起一个 deepseek/deepseek-v4-flash 会话抓包。
- **confidence**：high（表 + 代码）。
- **注**：文档 `packages/coding-agent/docs/models.md:216` 只写 `null` = "hidden/skipped/**clamped away**"，未定义夹取方向；实现取"向上优先"，文档与实现之间没有约束。

## F5 [high] "off" 不可达且被**反转**：请求关思考 → 得到 max/high
- **命题**：off 不被支持时，夹取给出的是"最贵档"，而不是报错或降级到最接近的"省"档。
- **file:line** `packages/ai/src/models.ts:82-91` + `packages/ai/src/providers/openai-completions.ts:768-770`
```ts
const clampedReasoning = reasoningSpecified ? clampThinkingLevel(model, requestedReasoning) : undefined;
const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
```
- **实测正控**：
  - `opencode-go/kimi-k3`（map `{"off":null,...,"max":"max"}`）`supported:["max"]`，clamp 表 `{"off":"max","minimal":"max",...,"max":"max"}`，wire：**7 档全部 `reasoning_effort:"max"`**。
  - `openrouter/deepseek/deepseek-r1`（`supported:["high"]`）：`off → reasoning {"enabled": true}`。
  - bailian/kimi-k3（同上表）：`off → reasoning_effort:"low"`（不是关，而是低档思考）。
- **影响**：这是"用户以为关了、实际最强思考"的静默反转，token/费用最坏方向；且 `agent-session.ts:9911-9913` 会把 `max` 写进 session 与 settings 默认值（见 F7），用户不再有机会看到自己请求过 off。
- **复现**：`probe_clamp.ts` 输出；或对 opencode-go/kimi-k3 起会话 `/effort`（只会显示 max）后直接 `agent.state.thinkingLevel="off"` 走 streamSimple。
- **confidence**：high。

## F6 [medium] 同一用户输入在两条链上"一个报错、一个静默改档"
- **命题**：rlm 子代理 `thinking` 参数不支持时硬抛错；`setThinkingLevel`/`/effort`/`--thinking`/SDK 起始静默夹取。而 rlm 的合法性判据本身与"缺 map 即支持"的合成规则一致，所以它放行的档位在落线处仍会被 provider 二次改档（F4/F5）。
- **file:line**：
  - 抛错：`packages/coding-agent/src/core/agent-session.ts:14536-14543`
```ts
if (requestedThinkingLevel !== undefined) {
    const supported = getSupportedThinkingLevels(modelSelection.model) as ThinkingLevel[];
    if (!supported.includes(requestedThinkingLevel)) {
        throw new Error(
            `Requested thinking level "${requestedThinkingLevel}" is not supported by model "${modelSelection.model.provider}/${modelSelection.model.id}"; supported levels: ${supported.join(", ")}`,
        );
```
  - 静默：`agent-session.ts:9901-9903`（`const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(...)`）、`packages/coding-agent/src/core/sdk.ts:226`（`thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;`）。
- **影响**：编排者若用"rlm 没报错"当作"档位被尊重"的证据，会误判（bailian 家族非主力模型上 medium/low 都会被改写）；反过来，把 kimi-k3 的 `thinking="off"` 派成硬错误（而 `/effort` 路径却"成功"了），同一意图两条入口行为相反。
- **复现**：`rlm.run(..., model="opencode-go/kimi-k3", thinking="off")` → 抛错；同一模型对 `/effort`/`setThinkingLevel("off")` → 静默 max。
- **confidence**：high。

## F7 [medium] 夹取结果**不可逆写回**配置：切模型后原档位永久丢失
- **命题**：静默夹取的产物被当作新的默认档持久化，切回原模型也不会恢复。
- **file:line** `packages/coding-agent/src/core/agent-session.ts:9910-9913`
```ts
if (isChanging) {
    this.sessionManager.appendThinkingLevelChange(effectiveLevel);
    if (this.supportsThinking() || effectiveLevel !== "off") {
        this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
```
  + 切模型路径 `agent-session.ts:9771/9777`、`9837/9844`、`9877/9883`（`const thinkingLevel = this._getThinkingLevelForModelSwitch(); ... this.setThinkingLevel(thinkingLevel);`）。
- **影响**：在 qwen3.8 上设定 max → 切到 `opencode-go/qwen3.7-max`（无 max）→ clamp 成 high 并写进 settings；切回 qwen3.8 仍是 high。档位偏好随模型切换单向衰减。
- **复现**：`/effort max`（qwen3.8）→ `/model` 切到无 xhigh/max 的模型 → 切回 → footer/settings 均为 high。
- **confidence**：high（代码路径）；用户可见影响 medium。

## F8 [medium] 缺 map 的模型"凭空获得"4 档支持，并把 pi 内部档位名**逐字**透传给 provider
- **命题**：map 缺省时 `getSupportedThinkingLevels` 判 off/minimal/low/medium/high 全支持（`models.ts:74 return true`），provider 侧 `?? options.reasoningEffort` 把 pi 档位名原样发出，不保证是 provider 词表里的值。
- **file:line** `packages/ai/src/models.ts:71-74` + `packages/ai/src/providers/openai-completions.ts:915 / 923 / 932`（`model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort`）
- **实测正控**（`opencode-go/qwen3.7-max`，map `null`，`supported:["off","minimal","low","medium","high"]`）：
```json
"wire": {"minimal":{"reasoning_effort":"minimal"},"low":{"reasoning_effort":"low"},
         "medium":{"reasoning_effort":"medium"},"high":{"reasoning_effort":"high"},
         "xhigh":{"reasoning_effort":"high"},"max":{"reasoning_effort":"high"}}
```
- **影响**：1244 个注册模型里 700 个属于这一类（含 `xiaomi/*`、`opencode-go/qwen3.7-max`、`opencode-go/glm-5.3` 等本机可能选到的模型）。`docs/models.md:214` 把"omitted"描述为 "Level is supported and uses the **provider's default mapping**"，实现是"把 pi 的档位名当 provider 值发出去"——文档与实现不同一；若 provider 不认 `minimal` 就是 400（本席无可用 key，未能把这一支实测成失败，故只作机制陈述）。
- **复现**：`probe_clamp.ts` 的 `opencode-go/qwen3.7-max` 行。
- **confidence**：medium（透传是实测；"provider 会拒绝"未实测）。

## F9 [low/medium] 预算型 provider 上 xhigh/max 会把 `thinkingBudget` 整键抹掉（退化为 provider 默认）
- **命题**：token 预算类 provider（Google/Vertex/Anthropic 非自适应/Bedrock）用"档位→预算"的第二张表；该表只有 minimal/low/medium/high，xhigh/max 在 `clampReasoning` 里折成 high，但 Google 分支拿到的 `effort` 可能是 `xhigh`/`max`（`clampThinkingLevel` 原样返回），查表得 `undefined` → payload 里没有 `thinkingBudget`。
- **file:line** `packages/ai/src/providers/simple-options.ts:31-32`
```ts
export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
    return effort === "xhigh" || effort === "max" ? "high" : effort;
}
```
  `packages/ai/src/providers/google.ts:314-315`
```ts
const clampedReasoning = clampThinkingLevel(model, options.reasoning);
const effort = (clampedReasoning === "off" ? "high" : clampedReasoning) as ClampedThinkingLevel;
```
  `packages/ai/src/providers/google-shared.ts:24-41`（`getGoogleThinkingBudget` 的表只有 minimal/low/medium/high，未命中 `return -1`）
- **实测正控**（`probe_google.ts`：取 `google/gemini-2.5-flash` 并临时把 `xhigh:"xhigh"` 加进其 map）：
```
high  {"config":{"maxOutputTokens":32000,"thinkingConfig":{"includeThoughts":true,"thinkingBudget":24576}}}
xhigh {"config":{"maxOutputTokens":32000,"thinkingConfig":{"includeThoughts":true}}}
```
- **影响**：任何把档位映到 xhigh/max 的预算型模型（自定义 models.json 即可触发）会拿到"未指定预算"= provider 默认，可能**低于** high 档的 24576，即"升档反而减预算"。
- **负结论 + 正控**：现役 `models.generated.ts` 的 google/google-vertex 30 个 reasoning 模型中**没有**任何 `supported` 含 xhigh/max（脚本筛完 `[]`），所以只影响自定义模型；正控是上面"临时加 xhigh 立刻复现"。
- **confidence**：high（机制实测）；触发概率 low。

## F10 [low] `thinkingLevelMap` 的值不校验 provider 词表
- **file:line** `packages/coding-agent/src/core/model-registry.ts:87`
```ts
const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
```
- **影响**：`{"low":"LOWX"}` 之类的 typo 会被 schema 接受并逐字发到 provider（400 而非本地诊断）；同一份 schema 也允许 `{"low":"LOW"}`/`{"high":"HIGH"}` 这类大小写不同的值（注册表里有这种模型，如 `{"high":"HIGH","low":"LOW"}`），落线语义依赖 provider 的大小写宽容度。
- **复现**：往任意自定义模型的 map 写一个不存在的值，起会话抓包看 `reasoning_effort` 原样透传。
- **confidence**：high（schema 逐字 + F8 的透传实测）。

## F11 [low] 交互层用**请求值**覆盖显示，而不是夹取后的生效值
- **file:line** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:8355-8362`
```ts
.setThinkingLevel(level)
.then(() => {
    this.patchConnectionState({ thinkingLevel: level });
    ...
    this.showStatus(`Thinking level: ${level}`);
```
  + 事件侧用的是生效值：`interactive-mode.ts:2769-2770` `case "thinking_level_changed": this.patchConnectionState({ thinkingLevel: event.level });`（`agent-session.ts:9915` 发的是 `effectiveLevel`）；daemon 的 `set_thinking_level` 也**不回传**生效值（`modes/daemon/daemon-mode.ts:5138-5142` `return success(command.id, "set_thinking_level")`），客户端只能显示请求值。
- **影响**：`/effort` 先按 `availableThinkingLevels` 校验，所以在模型/状态不漂移时两者一致；一旦客户端档位集合过期（另一客户端或会话切换了模型、daemon 会话状态比客户端新）就会出现"footer 写 X、会话在 Y"，且没有任何提示。
- **confidence**：medium（代码级确定；触发需要状态漂移，未构造端到端 demo）。

---

## 可跑的测试（unset 泄露 env；在各自 package 目录下）
1) `packages/ai`（`env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_MAX_DEPTH -u PRIME_AGENT_SESSION -u PI_SESSION node ../../node_modules/vitest/dist/cli.js --run test/supports-xhigh.test.ts test/openrouter-reasoning.test.ts test/prime-inference-models.test.ts`）
   → `Test Files 3 passed / Tests 35 passed`，**EXIT=0**（日志 `/tmp/audit_r/round-42/test-ai.log`）。
2) `packages/coding-agent`（同 env 形式，跑 `test/interactive-mode-effort-command.test.ts test/models-legacy-compat-key-diagnostic.test.ts test/model-resolver.test.ts`）
   → `Test Files 3 passed / Tests 46 passed`，**EXIT=0**（日志 `/tmp/audit_r/round-42/test-ca.log`）。
**测试覆盖缺口（重要）**：现有测试只断言 `getSupportedThinkingLevels` 的集合与个别 synth 模型的 payload（如 `openai-completions-tool-choice.test.ts:1133-1195` 用临时构造的 map），**没有任何测试断言本机/仓库注册表中实际模型 map 的"档位→wire 值"**，因此 F1/F2/F3/F4/F5 这一族漂移全部无守卫：改 `models.json` 或 `models.generated.ts` 的 map 值不会让任何测试变红。

## 判定摘要
- critical：0 条（无静默数据错乱/越权；本族是"档位语义丢失/反转"，属行为与告知层）。
- high：F1（glm-5.3 档位完全无效 + off 反转）、F2（默认 medium 跨模型漂移）、F3（主力模型 high/max 同 payload）、F4（向上夹取：要省反而给最贵）、F5（off 反转成 max/high）。
- medium：F6（两条链一个报错一个静默）、F7（夹取不可逆写回）、F8（缺 map 凭空支持 + 逐字透传）。
- low：F9（预算表无 xhigh/max；现役不可触发）、F10（值不校验词表）、F11（显示请求值）。
- 最强两条：**F1**（glm-5.3 上 7 档同 payload、`supportsReasoningEffort:true` 是死配置、"off"发 `enable_thinking:true`）与 **F4/F5**（`clampThinkingLevel` 向上优先，把"要便宜/要关"的请求静默换成"最贵/最强"，且写回 settings 不可逆）。
