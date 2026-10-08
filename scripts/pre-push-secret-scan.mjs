#!/usr/bin/env node
/**
 * Pre-push sensitive-info scan: refuse to publish commits whose messages or added diff
 * lines carry account identifiers or credential-shaped secrets.
 *
 * Provenance: fd1dd4e4c (2026-10-02) pasted a `claude auth status` JSON blob into a commit
 * message and pushed it to the public fork - account email, org UUID and subscription type
 * included. The guards ahead of this one in .husky/pre-push never saw it: nothing about
 * the ref list was wrong. This stage looks at content instead of refs.
 *
 * What is scanned: the commits this push would newly publish - reachable from the pushed
 * tips but from no remote-tracking ref and from none of the remote oids git reports on
 * stdin - so already-public history (including fd1dd4e4c itself) is never rescanned. For
 * each such commit: the full message (%B) and the added lines of its patch. Merge-commit
 * messages are scanned; `git log -p` prints no patch for merges, which is fine because
 * their content arrives via the merged parents. Binary blobs are never scanned.
 *
 * Pattern provenance: the literal-shape table below is copied verbatim from
 * packages/coding-agent/src/core/share-secret-detectors.ts (SHARE_SECRET_PATTERNS) - one
 * calibration, kept honest by the drift guard in scripts/check-secret-scan.mjs, which
 * compares label, regex source, flags and valueGroup of every entry. Two shapes are added
 * on top:
 *
 *   - Email addresses, the fd1dd4e4c leak class. Exempted: attribution trailer lines
 *     (Co-Authored-By: and friends - this history carries hundreds), scp-style git URLs
 *     (git@host:org/repo - the colon must open a path, not prose), URL userinfo
 *     (https://user@host/... - only when the email is the URL's user, not merely a line
 *     that also contains a URL), the git@ local part, and placeholder domains
 *     (example.com/org/net, the reserved TLDs .example/.test/.invalid/.internal/.localhost/
 *     .localdomain, users.noreply.github.com).
 *   - UUIDs with an account-context word (org, account, tenant, workspace, subscription,
 *     customer, member, profile, owner, user) glued to a `:`/`=` in front of them - the
 *     "orgId": "<uuid>" shape. Bare UUIDs pass: 791ce355f cites a session id in its
 *     message and the test trees are full of UUID fixtures.
 *
 * Known tripwires (pre-existing lines that match by design if a future commit re-adds
 * them; the inline marker or the escape hatch covers those edits): the realistic sk-ant
 * fixtures in packages/ai/test (secret-redaction, anthropic-oauth-*), the AIza fixture in
 * google-vertex-api-key-resolution.test.ts, one-fixture-per-shape in packages/coding-agent/
 * test/share-secret-export-scan.test.ts, the sk-ant-* placeholders in docs/fork/audits/
 * rounds/round-42-*.md, the git-identity fixture in packages/coding-agent/test/git-
 * context.test.ts and session-manager-git-state.test.ts, and the SECURITY.md contact
 * address. Deliberate, and the refusal message says how to proceed: a value that is
 * indistinguishable from a real key is treated as a real key.
 *
 * Inline marker: a diff line carrying `secret-scan: allow` is skipped - the way to
 * document a key shape in tracked content. The marker is not honored in commit messages;
 * a message that would need it should use the escape hatch instead.
 *
 * Escape hatch for one push (warns): PRIME_AGENT_ALLOW_SECRET_PUSH=1 git push <remote> ...
 *
 * Failure policy: git errors fail closed, with one exception - a pushed local oid that
 * does not resolve locally is noted on stderr and skipped, because synthetic callers feed
 * this hook oids that do not exist (a real push always has its objects). Malformed stdin
 * fails closed. A patch stream larger than 256 MB fails closed; use the hatch for
 * history-scale pushes.
 *
 * Usage:
 *   (hook, no args)        reads pre-push stdin ("<local ref> <local oid> <remote ref>
 *                          <remote oid>" per line), scans, exits 1 on findings
 *   --self-test            pattern and patch-walker unit cases; no git, no disk, no network
 *   --scan-range <args…>   dev tool: scan an arbitrary rev-list range, e.g.
 *                          --scan-range origin/main..HEAD
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ZERO_SHA = "0".repeat(40);
const ALLOW_ENV = "PRIME_AGENT_ALLOW_SECRET_PUSH";
const ALLOW_MARKER = "secret-scan: allow";
const EMAIL_TYPE = "Email address";
const UUID_TYPE = "Org/account UUID";
const MAX_BUFFER = 256 * 1024 * 1024;
const MAX_REPORTED = 50;
const UUID_CONTEXT_WINDOW = 80;

// Literal shapes, copied verbatim from SHARE_SECRET_PATTERNS in
// packages/coding-agent/src/core/share-secret-detectors.ts; the drift guard in
// scripts/check-secret-scan.mjs fails when the two tables diverge. The floors are the
// share preflight's, so short placeholder strings (for example the sk-ant-* stand-ins in
// the round-42 audit docs) match by design - see "Known tripwires" above.
const SECRET_PATTERNS = [
	// One class for every `sk-` provider this repo talks to (OpenAI, DeepSeek, Moonshot,
	// OpenRouter, Anthropic, DashScope/bailian); the dots are load-bearing - the live
	// bailian key contains them.
	{ type: "API key (sk-)", pattern: /\bsk-[A-Za-z0-9_.-]{8,}/g },
	{ type: "AWS access key (AKIA)", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ type: "GitHub token (ghp_)", pattern: /\bghp_[A-Za-z0-9_]{20,}/g },
	{ type: "GitHub token (github_pat_)", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
	{ type: "Bearer token", pattern: /\bBearer\s+([A-Za-z0-9._\-+/=]{8,})/gi, valueGroup: 1 },
	{ type: "PEM private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
	{ type: "AWS temporary key (ASIA)", pattern: /\bASIA[0-9A-Z]{16}\b/g },
	{ type: "GitHub token (gho_/ghu_/ghs_/ghr_)", pattern: /\bgh[ousr]_[A-Za-z0-9]{20,}/g },
	{ type: "GitLab token (glpat-)", pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g },
	{ type: "Google API key (AIza)", pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
	{ type: "Google OAuth token (ya29.)", pattern: /\bya29\.[A-Za-z0-9_-]{20,}/g },
	{ type: "Hugging Face token (hf_)", pattern: /\bhf_[A-Za-z0-9]{20,}/g },
	{ type: "Groq key (gsk_)", pattern: /\bgsk_[A-Za-z0-9]{20,}/g },
	{ type: "xAI key (xai-)", pattern: /\bxai-[A-Za-z0-9]{20,}/g },
	{ type: "Slack token (xox)", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
	{ type: "Stripe key (sk_live_/rk_live_)", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
	{ type: "SendGrid key (SG.)", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
	{ type: "Databricks token (dapi)", pattern: /\bdapi[0-9a-f]{28,}/g },
	{ type: "npm token (npm_)", pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
	{ type: "PyPI token (pypi-)", pattern: /\bpypi-[A-Za-z0-9_-]{40,}/g },
	{ type: "JWT (three base64url segments)", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
	{ type: "Basic auth header", pattern: /\bBasic\s+([A-Za-z0-9+/=]{16,})/g, valueGroup: 1 },
	{ type: "SSH/OpenSSH private key", pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/g }, // secret-scan: allow
];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_ALLOW_DOMAIN = /^(?:example\.(?:com|org|net)|users\.noreply\.github\.com)$/i;
const EMAIL_ALLOW_TLD = /\.(?:example|test|invalid|internal|localhost|localdomain)$/i;
// The email sits in a URL's userinfo only when everything between the scheme's `://`
// and the match is userinfo-shaped (letters, digits, `.-_~%+:@` - no separators), so
// "docs at https://host/guide, contact ops@corp.io" is still scanned: the email merely // secret-scan: allow
// shares the line with a URL, it is not the URL's user.
const URL_USERINFO_BEFORE = /(?:^|[^A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9._%~+:@-]*$/;
// scp-style user@host:path - the colon must open a path, not prose ("ops@corp.io: note"). // secret-scan: allow
const SCP_PATH_START = /^[A-Za-z0-9.~/_-]/;
// Attribution trailers are how this history records authorship; they are exempt from the
// email rule in commit messages (and only there).
const TRAILER_LINE = /^\s*(?:co-authored-by|signed-off-by|authored-by|reviewed-by|acked-by|reported-by|helped-by|suggested-by|cc)\s*:/i;

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// An account word (not inside a longer word, so "remember:" stays clean), optional glued
// id/uuid suffix, then quoting/separator noise ending in `:` or `=` at the window's end.
const UUID_CONTEXT =
	/(?:^|[^a-z])(?:org(?:ani[sz]ation)?|account|tenant|workspace|subscription|customer|member|profile|owner|user)[\w-]{0,16}["'\s_\]-]*[:=]["'\s_[\]-]*$/i;

function execAll(pattern, text) {
	const matches = [];
	pattern.lastIndex = 0;
	let match = pattern.exec(text);
	while (match !== null) {
		if (match[0].length === 0) {
			pattern.lastIndex += 1;
		} else {
			matches.push(match);
		}
		match = pattern.exec(text);
	}
	return matches;
}

// Front/back mask, mirroring maskSecretValue in share-secret-detectors.ts: enough to
// recognise which value tripped the gate, never enough to use it.
function maskValue(value) {
	if (value.length < 12) return `…(${value.length} characters hidden)`;
	const keep = value.length >= 24 ? 4 : 2;
	return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function maskEmail(value) {
	const at = value.lastIndexOf("@");
	return `${value.slice(0, 1)}***@${value.slice(at + 1)}`;
}

/**
 * Scan one line of message body or added diff content. In message mode attribution
 * trailers are exempt from the email rule and the inline marker is not honored.
 */
function scanLine(line, { message = false } = {}) {
	if (!message && line.includes(ALLOW_MARKER)) return [];
	const findings = [];
	for (const entry of SECRET_PATTERNS) {
		for (const match of execAll(entry.pattern, line)) {
			const group = entry.valueGroup ?? 0;
			const value = match[group] ?? match[0];
			findings.push({ type: entry.type, masked: maskValue(value) });
		}
	}
	for (const match of execAll(EMAIL_PATTERN, line)) {
		const value = match[0];
		const at = value.lastIndexOf("@");
		const local = value.slice(0, at).toLowerCase();
		const domain = value.slice(at + 1);
		if (local === "git") continue; // scp/ssh git user, never a mailbox
		if (URL_USERINFO_BEFORE.test(line.slice(0, match.index))) continue; // URL userinfo
		if (line[match.index + value.length] === ":" && SCP_PATH_START.test(line.slice(match.index + value.length + 1))) {
			continue; // scp-style git@host:path
		}
		if (EMAIL_ALLOW_DOMAIN.test(domain) || EMAIL_ALLOW_TLD.test(domain)) continue;
		if (message && TRAILER_LINE.test(line)) continue;
		findings.push({ type: EMAIL_TYPE, masked: maskEmail(value) });
	}
	for (const match of execAll(UUID_PATTERN, line)) {
		const window = line.slice(Math.max(0, match.index - UUID_CONTEXT_WINDOW), match.index);
		if (!UUID_CONTEXT.test(window)) continue;
		findings.push({ type: UUID_TYPE, masked: maskValue(match[0]) });
	}
	return findings;
}

// `git log --format=%H%x00%B%x00` output: records are "sha\0body\0" with a trailing
// newline per record, so odd split slots hold bodies and even slots hold shas (modulo a
// leading newline).
function scanMessagesText(text, findings) {
	const parts = text.split("\0");
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const sha = parts[i].trim();
		if (!/^[0-9a-f]{40,64}$/i.test(sha)) continue;
		const lines = (parts[i + 1] ?? "").split("\n");
		for (let n = 0; n < lines.length; n++) {
			for (const hit of scanLine(lines[n], { message: true })) {
				findings.push({ ...hit, location: `commit ${sha.slice(0, 12)} message line ${n + 1}` });
			}
		}
	}
}

// Walk `git log -p --format=commit %H` output, tracking the current commit, file and
// new-side line number so a finding can be reported as file:line. Only added lines are
// scanned; a deleted key is history's problem, not this push's.
function scanPatchText(text, findings) {
	let commit = "unknown";
	let file = null;
	let lineNo = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("commit ")) {
			commit = line.slice(7).trim().slice(0, 12);
			file = null;
			continue;
		}
		if (line.startsWith("diff --git ")) {
			file = null;
			continue;
		}
		if (line.startsWith("+++ ")) {
			const path = line.slice(4);
			file = path === "/dev/null" ? null : path.replace(/^b\//, "");
			continue;
		}
		if (file === null) continue;
		if (line.startsWith("@@ ")) {
			const hunk = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			lineNo = hunk ? Number(hunk[1]) : 0;
			continue;
		}
		if (line.startsWith("+")) {
			for (const hit of scanLine(line.slice(1))) {
				findings.push({ ...hit, location: `${file}:${lineNo} (commit ${commit})` });
			}
			lineNo += 1;
			continue;
		}
		if (line.startsWith(" ")) lineNo += 1;
	}
}

function failClosed(reason) {
	console.error(`pre-push secret scan: ${reason}`);
	console.error(`Refusing to fail open; to lift the scan for this one push: ${ALLOW_ENV}=1 git push <remote> ...`);
	process.exit(1);
}

function gitOut(args) {
	const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: 120000 });
	if (result.error || result.status !== 0) {
		const why =
			result.error?.code === "ENOBUFS"
				? `output exceeded ${MAX_BUFFER} bytes (history-scale push; use the escape hatch)`
				: (result.stderr ?? String(result.error)).trim();
		failClosed(`git ${args[0]} failed while scanning: ${why}`);
	}
	return result.stdout;
}

function commitExists(sha) {
	return spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { timeout: 15000 }).status === 0;
}

// Parse git's pre-push stdin into the rev-list arguments for "what this push would newly
// publish": pushed tips as positives, the remote's current oids plus every
// remote-tracking ref as negatives. Structurally malformed lines fail closed. A local oid
// that is not hex or does not resolve locally is noted on stderr and skipped rather than
// fatal - synthetic callers feed this hook oids that do not exist; a real push always
// sends hex oids for objects it has. An unusable remote oid is dropped quietly: the
// --remotes negative still bounds the scan, so the failure mode is scanning more, never
// less.
function parsePushStdin(text) {
	const positives = [];
	const negatives = [];
	const notes = [];
	const seenPositive = new Set();
	const seenNegative = new Set();
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "") continue;
		const fields = line.split(/\s+/);
		if (fields.length !== 4) {
			failClosed(`malformed ref line (expected: <local ref> <local oid> <remote ref> <remote oid>): ${rawLine}`);
		}
		const [localRef, localSha, remoteRef, remoteSha] = fields;
		if (localRef === "(delete)" || localSha === ZERO_SHA) continue;
		if (!localRef.startsWith("refs/")) failClosed(`malformed ref line (local ref is outside refs/*): ${rawLine}`);
		if (!remoteRef.startsWith("refs/")) failClosed(`malformed ref line (remote ref is outside refs/*): ${rawLine}`);
		if (!/^[0-9a-f]{40,64}$/i.test(localSha) || !commitExists(localSha)) {
			notes.push(`skipping ${localRef}: ${localSha.slice(0, 12)} is not a locally resolvable commit`);
			continue;
		}
		if (!seenPositive.has(localSha)) {
			seenPositive.add(localSha);
			positives.push(localSha);
		}
		if (remoteSha === ZERO_SHA || !/^[0-9a-f]{40,64}$/i.test(remoteSha) || !commitExists(remoteSha)) continue;
		if (!seenNegative.has(remoteSha)) {
			seenNegative.add(remoteSha);
			negatives.push(remoteSha);
		}
	}
	return { positives, negatives, notes };
}

function scanRevs(revArgs) {
	const findings = [];
	scanMessagesText(gitOut(["log", "--format=%H%x00%B%x00", ...revArgs]), findings);
	scanPatchText(gitOut(["log", "-p", "--no-ext-diff", "--no-textconv", "--format=commit %H", ...revArgs]), findings);
	return findings;
}

function report(findings) {
	const lines = [
		`pre-push secret scan: refusing to publish ${findings.length} finding(s) in commits not on any remote:`,
	];
	for (const finding of findings.slice(0, MAX_REPORTED)) {
		lines.push(`  [${finding.type}] ${finding.location}: ${finding.masked}`);
	}
	if (findings.length > MAX_REPORTED) lines.push(`  …and ${findings.length - MAX_REPORTED} more`);
	lines.push("These look like account identifiers or credentials. A diff line that documents a key shape on");
	lines.push(`purpose can carry \`${ALLOW_MARKER}\`; to lift the scan for this one push:`);
	lines.push(`  ${ALLOW_ENV}=1 git push <remote> ...`);
	console.error(lines.join("\n"));
}

function selfTest() {
	// Poison literals carry the inline marker so a future push of this file (whose added
	// lines are scanned like anyone's) does not trip on them; scanLine is called with the
	// bare values below, so detection is still exercised.
	const SK_POISON = "sk-ant-api03-W4vE40ScanPoisonKey0123456789abcd"; // secret-scan: allow
	const AWS_POISON = "AKIAIOSFODNN7EXAMPLE"; // AWS's documented example key pair id; secret-scan: allow
	const UUID_POISON = "123e4567-e89b-12d3-a456-426614174000";
	const shapes = [
		["API key (sk-)", SK_POISON],
		["API key (sk-)", "sk-proj-W4vE40ScanPoisonKey0123456789abcdefgh"], // secret-scan: allow
		["AWS access key (AKIA)", AWS_POISON],
		["AWS temporary key (ASIA)", "ASIAIOSFODNN7EXAMPLE"], // secret-scan: allow
		["GitHub token (ghp_)", "ghp_abcdefghij1234567890ABCD"], // secret-scan: allow
		["GitHub token (github_pat_)", "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123"], // secret-scan: allow
		["GitHub token (gho_/ghu_/ghs_/ghr_)", "gho_abcdefghij1234567890AB"], // secret-scan: allow
		["GitLab token (glpat-)", "glpat-abcdefghij1234567890"], // secret-scan: allow
		["Google API key (AIza)", "AIzaSyD4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0"], // secret-scan: allow
		["Google OAuth token (ya29.)", "ya29.a0AfH6SMBx7Yz9Ab1Cd2Ef3Gh4"], // secret-scan: allow
		["Hugging Face token (hf_)", "hf_ABCDEFGHIJ1234567890abcd"], // secret-scan: allow
		["Groq key (gsk_)", "gsk_ABCDEFGHIJ1234567890abcd"], // secret-scan: allow
		["xAI key (xai-)", "xai-ABCDEFGHIJ1234567890abcd"], // secret-scan: allow
		["Slack token (xox)", "xoxb-123456789012-abcdefghijkl"], // secret-scan: allow
		// GitHub push protection reads the raw text, not our inline marker: these two
		// literals are built from fragments so no detector-shaped string exists in source.
		["Stripe key (sk_live_/rk_live_)", ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_")], // Stripe's documented example
		["SendGrid key (SG.)", "SG.abc123def456ghi7.jkl890mno123pqr4"], // secret-scan: allow
		["Databricks token (dapi)", ["da", "pi", "0123456789abcdef0123456789abcdef"].join("")],
		["npm token (npm_)", "npm_abcdefghijklmnopqrstuvwxyz0123456789"], // secret-scan: allow
		["PyPI token (pypi-)", "pypi-AgEIcHlwaS5vcmcCJDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg"], // secret-scan: allow
		["JWT (three base64url segments)", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c"], // jwt.io's documented example; secret-scan: allow
		["Bearer token", "Authorization: Bearer eyJraWQiOiJIUzI1NiJ9abcd"], // secret-scan: allow
		["Basic auth header", "Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ="], // user:password, base64; secret-scan: allow
		["PEM private key", "-----BEGIN RSA PRIVATE KEY-----"], // secret-scan: allow
		// The PEM class is a superset of the OpenSSH one in the share table, so an OpenSSH
		// header honestly matches both entries.
		["SSH/OpenSSH private key", "-----BEGIN OPENSSH PRIVATE KEY-----", ["PEM private key", "SSH/OpenSSH private key"]], // secret-scan: allow
		["Email address", "account: wave40-scan-qa@gmail.com"], // secret-scan: allow
		["Org/account UUID", `"orgId": "${UUID_POISON}"`], // secret-scan: allow
		["Org/account UUID", `org_id=${UUID_POISON}`], // secret-scan: allow
	];
	const clean = [
		["docs-style sk-ant placeholder", "export ANTHROPIC_API_KEY=sk-ant-..."],
		["scp-style git URL", "git@github.com:PrimeIntellect-ai/prime-agent.git"],
		["URL userinfo", "https://token@github.com/o/r.git"],
		["URL userinfo with user:password", "https://user:p@ssw0rd@github.com/o/r.git"],
		["URL userinfo after prose", "git clone https://token@github.com/o/r.git"],
		["URL userinfo inside markdown link syntax", "[clone](https://token@github.com/o/r.git)"],
		["placeholder email domains", "user@example.com and dev@example.org"],
		["github noreply email", "12345+someone@users.noreply.github.com"],
		["reserved-TLD email", "preflight@example.test"],
		["bare UUID citation", `session ${UUID_POISON}, 2026-09-12T20:59Z..2026-09-13T03:34Z`],
		["UUID without an account word", `id: ${UUID_POISON}`],
	];
	let passes = 0;
	let failures = 0;
	const check = (name, found, expected) => {
		const actual = found.map((finding) => (typeof finding === "string" ? finding : finding.type)).sort();
		const want = [...expected].sort();
		if (actual.join("") === want.join("") && actual.length === want.length) {
			passes += 1;
			console.log(`  ok   ${name}`);
			return;
		}
		failures += 1;
		console.log(`  FAIL ${name}: got [${actual.join(", ")}], expected [${want.join(", ")}]`);
	};

	console.log("pre-push secret scan self-test");
	for (const [label, sample, expected] of shapes) check(`flags ${label}`, scanLine(sample), expected ?? [label]);
	for (const [name, sample] of clean) check(`passes ${name}`, scanLine(sample), []);
	check(
		"passes an attribution trailer email in a message",
		scanLine("Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>", { message: true }), // secret-scan: allow
		[],
	);
	check(
		"still flags a key on a trailer line in a message",
		scanLine(`Co-Authored-By: Dev <d@real.io> ${SK_POISON}`, { message: true }), // secret-scan: allow
		["API key (sk-)"],
	);
	check("honors the inline marker in a diff line", scanLine(`const k = "${SK_POISON}"; // ${ALLOW_MARKER}`), []);
	check(
		"ignores the inline marker in a message",
		scanLine(`see ${SK_POISON} // ${ALLOW_MARKER}`, { message: true }),
		["API key (sk-)"],
	);
	// Floor lock-in: the table shares the share preflight's 8-character floor, so a
	// placeholder-shaped stand-in that clears the floor is a tripwire by design.
	check("flags a stand-in that clears the sk- floor", scanLine("getApiKey=sk-ant-live-key"), ["API key (sk-)"]); // secret-scan: allow

	// Mixed-line judgments: the exemptions are positional, so an email that merely
	// shares a line with a URL, or whose colon opens prose instead of an scp path,
	// is still a finding.
	check(
		"flags an email that only shares a line with a URL",
		scanLine("docs at https://internal.corp.io/guide, contact ops@corp.io"), // secret-scan: allow
		["Email address"],
	); // secret-scan: allow
	check(
		"flags a trailing email after an unrelated http URL",
		scanLine("see http://x for the setup, contact ops@corp.io"), // secret-scan: allow
		["Email address"],
	); // secret-scan: allow
	check(
		"flags an email whose colon opens prose, not an scp path",
		scanLine("contact ops@corp.io: the rotation schedule changed"), // secret-scan: allow
		["Email address"],
	); // secret-scan: allow

	// Redaction: the serialized findings must carry the mask, never the raw value.
	const redaction = JSON.stringify(scanLine(`key: ${SK_POISON}`));
	check("masks the raw value in findings", [redaction.includes(SK_POISON) ? "leak" : "masked"], ["masked"]);
	check("mask keeps a recognizable prefix", [redaction.includes("sk-a…") ? "prefix" : "no-prefix"], ["prefix"]);

	// Patch walker: file and new-side line tracking, deletions ignored, /dev/null handled.
	const patch = [
		"commit 1111111111111111111111111111111111111111",
		"",
		"diff --git a/f.ts b/f.ts",
		"new file mode 100644",
		"index 0000000..1111111",
		"--- /dev/null",
		"+++ b/f.ts",
		"@@ -0,0 +1,3 @@",
		"+line one",
		`+const k = "${SK_POISON}";`,
		"+line three",
		"diff --git a/old.txt b/old.txt",
		"deleted file mode 100644",
		"index 1111111..0000000",
		"--- a/old.txt",
		"+++ /dev/null",
		"@@ -1,1 +0,0 @@",
		`-id ${AWS_POISON}`,
	].join("\n");
	const patchFindings = [];
	scanPatchText(patch, patchFindings);
	check(
		"patch walk finds the added key at f.ts:2 only",
		patchFindings.map((finding) => `${finding.type} @ ${finding.location}`),
		["API key (sk-) @ f.ts:2 (commit 111111111111)"],
	);

	const total = passes + failures;
	console.log(`pre-push secret scan self-test: ${passes}/${total} control cases passed`);
	return failures === 0;
}

const args = process.argv.slice(2);
if (args[0] === "--self-test") {
	process.exit(selfTest() ? 0 : 1);
}

let findings;
if (args[0] === "--scan-range") {
	const revArgs = args.slice(1);
	if (revArgs.length === 0) {
		console.error("usage: pre-push-secret-scan.mjs [--self-test | --scan-range <git rev-list args…>]");
		process.exit(2);
	}
	findings = scanRevs(revArgs);
} else if (args.length === 0) {
	const { positives, negatives, notes } = parsePushStdin(readFileSync(0, "utf8"));
	for (const note of notes) console.error(`pre-push secret scan: ${note}`);
	findings = positives.length === 0 ? [] : scanRevs([...positives, "--not", ...negatives, "--remotes"]);
} else {
	console.error("usage: pre-push-secret-scan.mjs [--self-test | --scan-range <git rev-list args…>]");
	process.exit(2);
}

if (findings.length === 0) process.exit(0);
if (process.env[ALLOW_ENV] === "1") {
	console.error(`warning: ${ALLOW_ENV}=1 given; pushing despite ${findings.length} secret-scan finding(s).`);
	process.exit(0);
}
report(findings);
process.exit(1);
