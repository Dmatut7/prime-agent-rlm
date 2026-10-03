import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import hostedGitInfo from "hosted-git-info";

/**
 * Parsed git URL information.
 */
export type GitSource = {
	/** Always "git" for git sources */
	type: "git";
	/** Clone URL (always valid for git clone, without ref suffix) */
	repo: string;
	/** Git host domain (e.g., "github.com") */
	host: string;
	/** Repository path (e.g., "user/repo") */
	path: string;
	/** Git ref (branch, tag, commit) if specified */
	ref?: string;
	/** True if ref was specified (package won't be auto-updated) */
	pinned: boolean;
};

function splitRef(url: string): { repo: string; ref?: string } {
	const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		const pathWithMaybeRef = scpLikeMatch[2] ?? "";
		const refSeparator = pathWithMaybeRef.indexOf("@");
		if (refSeparator < 0) return { repo: url };
		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		if (!repoPath || !ref) return { repo: url };
		return {
			repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
			ref,
		};
	}

	if (url.includes("://")) {
		try {
			const parsed = new URL(url);
			const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
			const refSeparator = pathWithMaybeRef.indexOf("@");
			if (refSeparator < 0) return { repo: url };
			const repoPath = pathWithMaybeRef.slice(0, refSeparator);
			const ref = pathWithMaybeRef.slice(refSeparator + 1);
			if (!repoPath || !ref) return { repo: url };
			parsed.pathname = `/${repoPath}`;
			return {
				repo: parsed.toString().replace(/\/$/, ""),
				ref,
			};
		} catch {
			return { repo: url };
		}
	}

	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) {
		return { repo: url };
	}
	const host = url.slice(0, slashIndex);
	const pathWithMaybeRef = url.slice(slashIndex + 1);
	const refSeparator = pathWithMaybeRef.indexOf("@");
	if (refSeparator < 0) {
		return { repo: url };
	}
	const repoPath = pathWithMaybeRef.slice(0, refSeparator);
	const ref = pathWithMaybeRef.slice(refSeparator + 1);
	if (!repoPath || !ref) {
		return { repo: url };
	}
	return {
		repo: `${host}/${repoPath}`,
		ref,
	};
}

function parseGenericGitUrl(url: string): GitSource | null {
	const { repo: repoWithoutRef, ref } = splitRef(url);
	let repo = repoWithoutRef;
	let host = "";
	let path = "";

	const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		host = scpLikeMatch[1] ?? "";
		path = scpLikeMatch[2] ?? "";
	} else if (
		repoWithoutRef.startsWith("https://") ||
		repoWithoutRef.startsWith("http://") ||
		repoWithoutRef.startsWith("ssh://") ||
		repoWithoutRef.startsWith("git://")
	) {
		try {
			const parsed = new URL(repoWithoutRef);
			host = parsed.hostname;
			path = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return null;
		}
	} else {
		const slashIndex = repoWithoutRef.indexOf("/");
		if (slashIndex < 0) {
			return null;
		}
		host = repoWithoutRef.slice(0, slashIndex);
		path = repoWithoutRef.slice(slashIndex + 1);
		if (!host.includes(".") && host !== "localhost") {
			return null;
		}
		repo = `https://${repoWithoutRef}`;
	}

	const normalizedPath = path.replace(/\.git$/, "").replace(/^\/+/, "");
	if (!host || !normalizedPath || normalizedPath.split("/").length < 2) {
		return null;
	}

	return {
		type: "git",
		repo,
		host,
		path: normalizedPath,
		ref,
		pinned: Boolean(ref),
	};
}

/**
 * Parse git source into a GitSource.
 *
 * Rules:
 * - With git: prefix, accept all historical shorthand forms.
 * - Without git: prefix, only accept explicit protocol URLs.
 */
export function parseGitUrl(source: string): GitSource | null {
	const trimmed = source.trim();
	const hasGitPrefix = trimmed.startsWith("git:");
	const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;

	if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
		return null;
	}

	const split = splitRef(url);

	const hostedCandidates = [split.ref ? `${split.repo}#${split.ref}` : undefined, url].filter(
		(value): value is string => Boolean(value),
	);
	for (const candidate of hostedCandidates) {
		const info = hostedGitInfo.fromUrl(candidate);
		if (info) {
			if (split.ref && info.project?.includes("@")) {
				continue;
			}
			const useHttpsPrefix =
				!split.repo.startsWith("http://") &&
				!split.repo.startsWith("https://") &&
				!split.repo.startsWith("ssh://") &&
				!split.repo.startsWith("git://") &&
				!split.repo.startsWith("git@");
			return {
				type: "git",
				repo: useHttpsPrefix ? `https://${split.repo}` : split.repo,
				host: info.domain || "",
				path: `${info.user}/${info.project}`.replace(/\.git$/, ""),
				ref: info.committish || split.ref || undefined,
				pinned: Boolean(info.committish || split.ref),
			};
		}
	}

	const httpsCandidates = [split.ref ? `https://${split.repo}#${split.ref}` : undefined, `https://${url}`].filter(
		(value): value is string => Boolean(value),
	);
	for (const candidate of httpsCandidates) {
		const info = hostedGitInfo.fromUrl(candidate);
		if (info) {
			if (split.ref && info.project?.includes("@")) {
				continue;
			}
			return {
				type: "git",
				repo: `https://${split.repo}`,
				host: info.domain || "",
				path: `${info.user}/${info.project}`.replace(/\.git$/, ""),
				ref: info.committish || split.ref || undefined,
				pinned: Boolean(info.committish || split.ref),
			};
		}
	}

	return parseGenericGitUrl(url);
}

export type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
export function findGitPaths(cwd: string): GitPaths | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export interface GitContext {
	repoUrl?: string;
	commit?: string;
	branch?: string;
}

export function gitContextsEqual(a: GitContext, b: GitContext): boolean {
	return a.repoUrl === b.repoUrl && a.commit === b.commit && a.branch === b.branch;
}

function runGit(cwd: string, args: string[]): string | null {
	const result = spawnSync("git", ["--no-optional-locks", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return null;
	return result.stdout.trim() || null;
}

// Env vars that change where git looks for the repository; the file fast path
// below reimplements plain .git discovery, so any of these force the git CLI.
const GIT_DISCOVERY_ENV_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;

const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/;
const REFS_HEADS_PREFIX = "refs/heads/";

function readPackedRef(commonGitDir: string, ref: string): string | null {
	let content: string;
	try {
		content = readFileSync(join(commonGitDir, "packed-refs"), "utf8");
	} catch {
		return null;
	}
	for (const line of content.split("\n")) {
		if (line.startsWith("#") || line.startsWith("^")) continue;
		const space = line.indexOf(" ");
		if (space < 0) continue;
		if (line.slice(space + 1).trim() !== ref) continue;
		const sha = line.slice(0, space).trim();
		return GIT_OBJECT_ID_PATTERN.test(sha) ? sha : null;
	}
	return null;
}

function readLooseRef(commonGitDir: string, ref: string): string | null | "unresolved" {
	let content: string;
	try {
		content = readFileSync(join(commonGitDir, ref), "utf8").trim();
	} catch {
		return null;
	}
	// A loose ref holding another ref is a symref chain; leave it to the git CLI.
	if (content.startsWith("ref:")) return "unresolved";
	return GIT_OBJECT_ID_PATTERN.test(content) ? content : "unresolved";
}

/** A bare repo has no .git entry; the directory itself is the git dir. */
function looksLikeBareGitDir(dir: string): boolean {
	return existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects"));
}

/**
 * Branch/commit without spawning git: HEAD plus loose/packed refs carry the same
 * values `rev-parse HEAD` and `branch --show-current` print. Returns undefined
 * when anything is non-standard so the caller falls back to the git CLI; returns
 * null when cwd is provably outside any repository (plain upward discovery found
 * no .git and no bare git dir, and no discovery-altering env var is set, so git
 * would fail too).
 */
function captureHeadFromFiles(cwd: string): { commit: string | null; branch: string | null } | null | undefined {
	if (GIT_DISCOVERY_ENV_VARS.some((name) => process.env[name] !== undefined)) return undefined;
	const paths = findGitPaths(cwd);
	if (!paths) {
		// Upward .git discovery found nothing, but an ancestor may still be a bare
		// repo (git checks for that shape too); any such hit goes back to the CLI.
		let dir = cwd;
		while (true) {
			if (looksLikeBareGitDir(dir)) return undefined;
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	}
	let head: string;
	try {
		head = readFileSync(paths.headPath, "utf8").trim();
	} catch {
		return undefined;
	}
	if (GIT_OBJECT_ID_PATTERN.test(head)) {
		// Detached HEAD: `branch --show-current` prints nothing, HEAD is the commit.
		return { commit: head, branch: null };
	}
	if (!head.startsWith("ref: ")) return undefined;
	const ref = head.slice(5).trim();
	if (!ref.startsWith(REFS_HEADS_PREFIX)) return undefined;
	const branch = ref.slice(REFS_HEADS_PREFIX.length);
	const loose = readLooseRef(paths.commonGitDir, ref);
	if (loose === "unresolved") return undefined;
	// Unborn branch: no loose or packed ref yet, so HEAD is unresolvable (commit null).
	return { commit: loose ?? readPackedRef(paths.commonGitDir, ref), branch };
}

export function captureGitContext(cwd: string): GitContext | null {
	const head = captureHeadFromFiles(cwd);
	// head null means discovery proved no repository, so every git call would fail.
	if (head === null) return null;
	const commit = head === undefined ? runGit(cwd, ["rev-parse", "HEAD"]) : head.commit;
	const branch = head === undefined ? runGit(cwd, ["branch", "--show-current"]) : head.branch;
	// The remote URL stays with the CLI: `git remote get-url` applies url.*.insteadOf
	// rewrites and merges every config level, which a local config read cannot mirror.
	const remote = runGit(cwd, ["remote", "get-url", "origin"]);
	if (!commit && !branch && !remote) return null;

	const context: GitContext = {};
	if (remote) context.repoUrl = parseGitUrl(remote)?.repo ?? remote;
	if (commit) context.commit = commit;
	if (branch) context.branch = branch;
	return context;
}
