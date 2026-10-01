import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "../../core/agent-session.js";
import { EVOLUTION_LEDGER_RELATIVE_PATH } from "./resume-briefing.js";

/**
 * W14-B (C4, /tmp/wave10/model-cases.md): the chair re-initiated a review
 * wave without checking the errata ledger and burned a whole wave of
 * subagents on an already-settled question. Every review-class RLM spawn now
 * carries this gate into the child's first turn (deliverAs next-turn, ahead
 * of the parent's task prompt): read the evolution ledger and the errata it
 * references before initiating (立项) anything, and cite what you checked.
 *
 * The gate fires only where the ledger exists - a repo without docs/fork has
 * no org memory to consult, and naming a missing file would teach children to
 * ignore the gate.
 */

export const SPAWN_ERRATA_GATE_CUSTOM_TYPE = "spawn_errata_gate";

/**
 * Review-class markers: the C4 wave tasks are Chinese (复审/审查/复核/评审/立项),
 * English markers use word boundaries so "preview" does not read as "review".
 */
const REVIEW_CLASS_PATTERN = /复审|审查|复核|评审|稽核|立项|\b(?:re-?)?review(?:ing|ed)?\b|\baudit(?:s|ing|or|ors)?\b/i;

/** Whether a spawn prompt assigns a review/audit-class task. */
export function isReviewClassSpawnPrompt(prompt: string): boolean {
	return REVIEW_CLASS_PATTERN.test(prompt);
}

/** The mandatory gate line(s) a review-class child reads before its task. */
export function buildSpawnErrataGateText(): string {
	return [
		"[组织记忆硬门 / org-memory gate] 这是一个审查/复审类任务。先读 docs/fork/evolution-ledger.md 与相关勘误再立项：",
		`1. 打开 ${EVOLUTION_LEDGER_RELATIVE_PATH}，检索本任务主题是否已有勘误或结论（Backlog、波次日志、销账记录），并按台账指向读相关勘误/决策文档。`,
		"2. 已有结论的，引用台账条目作答，不得二次立项；确无相关条目的，报告开头写明「已查 evolution-ledger.md，无相关勘误」。",
		"3. 报告必须列出实际查过的台账小节/条目作为证据。",
	].join("\n");
}

/** The public surface of the child AgentSession the gate writes to. */
export type SpawnErrataGateSession = Pick<AgentSession, "sendCustomMessage">;

/**
 * Inject the errata gate into a freshly admitted child session when the spawn
 * prompt is review-class and the repo keeps a ledger. Returns true when the
 * gate landed. The daemon calls this from RLM subagent admission, before the
 * parent's task prompt starts the child's first turn.
 */
export async function injectSpawnErrataGate(
	session: SpawnErrataGateSession,
	prompt: string,
	cwd: string,
): Promise<boolean> {
	if (!isReviewClassSpawnPrompt(prompt)) return false;
	if (!existsSync(join(cwd, ...EVOLUTION_LEDGER_RELATIVE_PATH.split("/")))) return false;
	await session.sendCustomMessage(
		{
			customType: SPAWN_ERRATA_GATE_CUSTOM_TYPE,
			content: buildSpawnErrataGateText(),
			display: false,
			details: { ledger: EVOLUTION_LEDGER_RELATIVE_PATH },
		},
		{ deliverAs: "nextTurn" },
	);
	return true;
}
