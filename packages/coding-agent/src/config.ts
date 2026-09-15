import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep, win32 } from "path";
import { fileURLToPath } from "url";
import { shouldUseWindowsShell } from "./utils/child-process.js";
import { normalizeSocketPath } from "./utils/daemon-socket-path.js";
import { appendPrivateFile, ensurePrivateFile } from "./utils/private-files.js";
import { getPrimeAgentDownloadBaseUrl } from "./utils/version-check.js";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

export const SELF_UPDATE_INTERACTIVE_CHILD_ENV = "PRIME_AGENT_INTERACTIVE_SELF_UPDATE";
export const SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE = 75;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "homebrew" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

interface SelfUpdateCommandStep {
	command: string;
	args: string[];
	display: string;
}

export interface SelfUpdateCommand extends SelfUpdateCommandStep {
	steps?: SelfUpdateCommandStep[];
}

function makeSelfUpdateCommand(
	installStep: SelfUpdateCommandStep,
	uninstallStep?: SelfUpdateCommandStep,
	options: { uninstallAfterInstall?: boolean } = {},
): SelfUpdateCommand {
	if (!uninstallStep) return installStep;
	if (options.uninstallAfterInstall) {
		return {
			...installStep,
			display: `${installStep.display} && ${uninstallStep.display}`,
			steps: [installStep, uninstallStep],
		};
	}
	return {
		...installStep,
		display: `${uninstallStep.display} && ${installStep.display}`,
		steps: [uninstallStep, installStep],
	};
}

function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
	return {
		command,
		args,
		display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}
	if (isHomebrewInstall()) {
		return "homebrew";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

function isHomebrewInstall(): boolean {
	const packageDir = getPackageDir().toLowerCase().replace(/\\/g, "/");
	return packageDir.includes("/cellar/") && packageDir.includes("/libexec/lib/node_modules/");
}

function getInferredNpmInstall(): { root: string; prefix: string } | undefined {
	const packageDir = getPackageDir();
	const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
	const parent = path.dirname(packageDir);
	let root: string | undefined;
	if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") {
		root = path.dirname(parent);
	} else if (path.basename(parent) === "node_modules") {
		root = parent;
	}
	if (!root) return undefined;
	const rootParent = path.dirname(root);
	if (path.basename(rootParent) === "lib") return { root, prefix: path.dirname(rootParent) };
	// Windows global npm prefixes use `<prefix>\\node_modules`, which is
	// indistinguishable from local project installs by path shape alone. Do not
	// infer unsupported Windows custom prefixes without `npm root -g` evidence.
	return undefined;
}

// =============================================================================
// Self-Update Spec Trust
// =============================================================================

/**
 * Why a self-update spec was refused. Each reason carries the shape the caller should
 * have used instead, because these strings reach the user as the explanation for a
 * refused update: "untrusted source" without "what a trusted source looks like" is not
 * actionable.
 */
export type UpdateSpecRejectionReason =
	| "untrusted_artifact_source"
	| "missing_artifact_hash"
	| "unverified_local_artifact"
	| "unsupported_artifact_spec"
	| "invalid_registry_spec";

/** A registry spec (`name`, `name@version`, `name@tag`) the package manager resolves itself. */
export interface RegistryUpdateSpec {
	kind: "registry";
	spec: string;
	packageName: string;
}

/**
 * A hash-pinned artifact under the configured release download base. Recognized, but never
 * handed to a package manager as a URL: npm accepts any URL and verifies nothing, so the
 * caller has to download it and check {@link sha256} first, then come back with
 * {@link VerifiedUpdateArtifact}.
 */
export interface ArtifactUpdateSpec {
	kind: "artifact";
	spec: string;
	url: string;
	sha256: string;
}

/** A local tarball the caller has already downloaded and checked against a pinned sha256. */
export interface VerifiedArtifactUpdateSpec {
	kind: "verified-artifact";
	spec: string;
	path: string;
	sha256: string;
}

export interface RejectedUpdateSpec {
	kind: "rejected";
	spec: string;
	reason: UpdateSpecRejectionReason;
	detail: string;
}

export type UpdateSpecClassification =
	| RegistryUpdateSpec
	| ArtifactUpdateSpec
	| VerifiedArtifactUpdateSpec
	| RejectedUpdateSpec;

export interface VerifiedUpdateArtifact {
	path: string;
	sha256: string;
}

export interface UpdateSpecOptions {
	/**
	 * A local artifact this process downloaded and verified itself ({@link verifyUpdateArtifactHash}).
	 * An unverified path on disk is not evidence of anything: `install -g <path>.tgz` runs whatever
	 * bytes are there, so the downloaded artifact only becomes installable once its digest is pinned
	 * here.
	 */
	verifiedArtifact?: VerifiedUpdateArtifact;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NPM_VERSION_SELECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_^~*|<>= -]*$/;

/** Origins whose release artifacts this installation trusts. One source of truth: the download base. */
export function getTrustedUpdateArtifactOrigins(): string[] {
	try {
		return [new URL(getPrimeAgentDownloadBaseUrl()).origin];
	} catch {
		return [];
	}
}

/** True only for https URLs on the configured release download base, lookalike hosts included-none. */
export function isTrustedUpdateArtifactUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	return getTrustedUpdateArtifactOrigins().includes(parsed.origin);
}

/**
 * Constant-shape digest check for a downloaded release artifact. An unreadable or empty payload
 * never passes: a zero-byte "release tarball" is not a release tarball.
 */
export function verifyUpdateArtifactHash(bytes: Uint8Array, expectedSha256: string): boolean {
	const expected = expectedSha256.trim().toLowerCase();
	if (!SHA256_HEX_PATTERN.test(expected)) return false;
	if (bytes.byteLength === 0) return false;
	return createHash("sha256").update(bytes).digest("hex") === expected;
}

function rejectedUpdateSpec(spec: string, reason: UpdateSpecRejectionReason, detail: string): RejectedUpdateSpec {
	return { kind: "rejected", spec, reason, detail };
}

function looksLikeTarballPath(spec: string): boolean {
	const withoutQuery = spec.split("#")[0];
	if (withoutQuery.startsWith("file:")) return true;
	return /\.(?:tgz|tar\.gz)$/i.test(withoutQuery);
}

function artifactSourceDetail(): string {
	return `its source is not the configured release download base (${getTrustedUpdateArtifactOrigins().join(", ") || "unset"})`;
}

/**
 * Classify one self-update spec.
 *
 * The rule this encodes: a self-update may only run something whose bytes are pinned by the
 * release it claims to come from. npm install -g takes an arbitrary absolute URL, follows
 * redirects, and checks nothing, so a URL is only accepted when it points at the configured
 * download base *and* carries `#sha256=<64 hex>`, and even then it is not installed directly -
 * the caller downloads it, verifies the digest, and installs the verified local file.
 */
export function classifyUpdateSpec(spec: string, options: UpdateSpecOptions = {}): UpdateSpecClassification {
	const raw = spec.trim();
	if (!raw) {
		return rejectedUpdateSpec(spec, "unsupported_artifact_spec", "it is empty");
	}

	const hashMatch = raw.match(/#sha256=([0-9A-Za-z]+)$/i);
	const withoutFragment = hashMatch ? raw.slice(0, raw.length - hashMatch[0].length) : raw;
	const pinnedSha256 = hashMatch?.[1]?.trim().toLowerCase();
	const hasValidPin = pinnedSha256 !== undefined && SHA256_HEX_PATTERN.test(pinnedSha256);

	if (/^https?:\/\//i.test(withoutFragment)) {
		if (!isTrustedUpdateArtifactUrl(withoutFragment)) {
			return rejectedUpdateSpec(raw, "untrusted_artifact_source", artifactSourceDetail());
		}
		if (!hasValidPin) {
			return rejectedUpdateSpec(
				raw,
				"missing_artifact_hash",
				`it pins no sha256 digest (expected "<url>#sha256=<64 hex>")`,
			);
		}
		return { kind: "artifact", spec: raw, url: withoutFragment, sha256: pinnedSha256 };
	}

	// Everything that is not an https artifact has to be a local file this process verified:
	// `file:` URLs, bare paths, and any other scheme (git:, ssh:, …) reach the same refusal.
	const localSpec = looksLikeTarballPath(withoutFragment) || /^[a-z][a-z0-9+.-]*:/i.test(withoutFragment);
	if (localSpec) {
		const localPath = withoutFragment.startsWith("file:") ? withoutFragment.slice("file:".length) : withoutFragment;
		const verified = options.verifiedArtifact;
		const isVerified =
			verified !== undefined &&
			SHA256_HEX_PATTERN.test(verified.sha256) &&
			resolve(verified.path) === resolve(localPath);
		if (!isVerified) {
			return rejectedUpdateSpec(
				raw,
				"unverified_local_artifact",
				`the local artifact ${localPath} was not verified against a pinned sha256 digest`,
			);
		}
		return {
			kind: "verified-artifact",
			spec: raw,
			path: localPath,
			sha256: verified.sha256.toLowerCase(),
		};
	}

	const selectorIndex = raw.lastIndexOf("@");
	const packageName = selectorIndex > 0 ? raw.slice(0, selectorIndex) : raw;
	const selector = selectorIndex > 0 ? raw.slice(selectorIndex + 1) : undefined;
	if (!NPM_PACKAGE_NAME_PATTERN.test(packageName)) {
		return rejectedUpdateSpec(raw, "invalid_registry_spec", "it is not a valid npm package name");
	}
	if (selector !== undefined && !NPM_VERSION_SELECTOR_PATTERN.test(selector)) {
		return rejectedUpdateSpec(raw, "invalid_registry_spec", `"${selector}" is not a valid npm version or tag`);
	}
	return { kind: "registry", spec: raw, packageName };
}

function isInstalledArtifactSpec(classification: UpdateSpecClassification): boolean {
	return classification.kind === "artifact" || classification.kind === "verified-artifact";
}

function getSelfUpdateCommandForMethod(
	method: InstallMethod,
	installedPackageName: string,
	updateSpec = installedPackageName,
	npmCommand?: string[],
	updatePackageName?: string,
	options: UpdateSpecOptions = {},
): SelfUpdateCommand | undefined {
	const classification = classifyUpdateSpec(updateSpec, options);
	// Refused before any command shape exists: a rejected spec must never reach a package
	// manager, and a hash-pinned URL is not installable as a URL at all (npm would fetch it
	// unchecked). The caller resolves that case to a verified local artifact first.
	if (classification.kind === "rejected" || classification.kind === "artifact") return undefined;
	// A registry spec carries its own name (so `prime-agent@0.9.1` does not look like a rename);
	// an artifact installs the package this installation already is unless the caller says otherwise.
	const resolvedUpdatePackageName =
		updatePackageName ?? (classification.kind === "registry" ? classification.packageName : installedPackageName);
	const installSpec = classification.kind === "verified-artifact" ? classification.path : classification.spec;
	const uninstallAfterInstall = isInstalledArtifactSpec(classification);
	switch (method) {
		case "bun-binary":
		case "homebrew":
			return undefined;
		case "pnpm":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("pnpm", ["install", "-g", installSpec]),
				resolvedUpdatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("pnpm", ["remove", "-g", installedPackageName]),
				{ uninstallAfterInstall },
			);
		case "yarn":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("yarn", ["global", "add", installSpec]),
				resolvedUpdatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
				{ uninstallAfterInstall },
			);
		case "bun":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("bun", ["install", "-g", installSpec]),
				resolvedUpdatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
				{ uninstallAfterInstall },
			);
		case "npm": {
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
			const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
			const installStep = makeSelfUpdateCommandStep(command, [...prefixArgs, "install", "-g", installSpec]);
			const uninstallStep =
				resolvedUpdatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
			return makeSelfUpdateCommand(installStep, uninstallStep, { uninstallAfterInstall });
		}
		case "unknown":
			return undefined;
	}
}

function readCommandOutput(
	command: string,
	args: string[],
	options: { requireSuccess?: boolean } = {},
): string | undefined {
	const result = spawnSync(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		shell: shouldUseWindowsShell(command),
	});
	if (result.status === 0) return result.stdout.trim() || undefined;
	if (options.requireSuccess) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
	}
	return undefined;
}

function getGlobalPackageRoots(method: InstallMethod, _packageName: string, npmCommand?: string[]): string[] {
	switch (method) {
		case "npm": {
			const configured = !!npmCommand?.length;
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			if (configured && command === "bun") {
				const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
					requireSuccess: true,
				});
				const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
				if (bunBin) {
					roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
				}
				return roots;
			}
			const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
				requireSuccess: configured,
			});
			const inferred = configured ? undefined : getInferredNpmInstall();
			return [root, inferred?.root].filter((x): x is string => !!x);
		}
		case "pnpm": {
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			return root ? [root, dirname(root)] : [];
		}
		case "yarn": {
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		case "bun": {
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			if (bunBin) {
				roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
			}
			return roots;
		}
		case "bun-binary":
		case "homebrew":
		case "unknown":
			return [];
	}
}

function normalizeExistingPathForComparison(path: string): string | undefined {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	let normalizedPath: string;
	try {
		normalizedPath = realpathSync(resolvedPath);
	} catch {
		return undefined;
	}
	if (process.platform === "win32") {
		normalizedPath = normalizedPath.toLowerCase();
	}
	return normalizedPath;
}

function isSelfUpdatePathWritable(): boolean {
	const packageDir = getPackageDir();
	try {
		accessSync(packageDir, constants.W_OK);
		accessSync(dirname(packageDir), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function isManagedByGlobalPackageManager(method: InstallMethod, packageName: string, npmCommand?: string[]): boolean {
	const packageDir = normalizeExistingPathForComparison(getPackageDir());
	return (
		!!packageDir &&
		getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
			const normalizedRoot = normalizeExistingPathForComparison(root);
			return (
				!!normalizedRoot &&
				packageDir.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`)
			);
		})
	);
}

function describeRefusedUpdateSpec(classification: RejectedUpdateSpec | ArtifactUpdateSpec): string {
	if (classification.kind === "artifact") {
		return (
			`Refusing to self-update from ${classification.url}: it is hash-pinned (sha256 ${classification.sha256}) but a package manager cannot check that digest, ` +
			`so Prime Agent only installs it from a copy it downloaded and verified itself. Re-run the update, or install the release with the published installer.`
		);
	}
	const outcomes: Record<UpdateSpecRejectionReason, string> = {
		untrusted_artifact_source:
			"Install Prime Agent from a trusted release source instead: the published installer verifies the release SHA256SUMS before installing.",
		missing_artifact_hash: `A hash-pinned artifact looks like ${getTrustedUpdateArtifactOrigins()[0] ?? "https://<download base>"}/releases/v<version>/<package>-<version>.tgz#sha256=<64 hex>.`,
		unverified_local_artifact:
			"Install the release with the published installer, which verifies the release SHA256SUMS, instead of a local tarball.",
		unsupported_artifact_spec: "Use the published installer instead.",
		invalid_registry_spec: "Use a registry spec such as prime-agent or prime-agent@0.9.1.",
	};
	return `Refusing to self-update from ${classification.spec}: ${classification.detail}. ${outcomes[classification.reason]}`;
}

export function getSelfUpdateCommand(
	packageName: string,
	npmCommand?: string[],
	updateSpec = packageName,
	updatePackageName?: string,
	options: UpdateSpecOptions = {},
): SelfUpdateCommand | undefined {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(
		method,
		packageName,
		updateSpec,
		npmCommand,
		updatePackageName,
		options,
	);
	if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
		return undefined;
	}
	return command;
}

export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	npmCommand?: string[],
	updateSpec = packageName,
	updatePackageName?: string,
	options: UpdateSpecOptions = {},
): string {
	const method = detectInstallMethod();
	// A refused spec is about the spec, not about how this installation was installed: saying
	// "this installation is not managed by a global npm install" here would point the user at
	// the wrong problem.
	const classification = classifyUpdateSpec(updateSpec, options);
	if (classification.kind === "rejected" || classification.kind === "artifact") {
		return describeRefusedUpdateSpec(classification);
	}
	if (method === "bun-binary") {
		return `Download from: https://github.com/PrimeIntellect-ai/prime-agent/releases/latest`;
	}
	if (method === "homebrew") {
		return `Update with: brew upgrade ${APP_NAME}`;
	}
	const command = getSelfUpdateCommandForMethod(
		method,
		packageName,
		updateSpec,
		npmCommand,
		updatePackageName,
		options,
	);
	if (command) {
		if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
			return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
		}
		return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
	}
	return `Update ${updateSpec} using the package manager, wrapper, or source checkout that provides this installation.`;
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName);
	if (command) {
		return `Run: ${command.display}`;
	}
	return getSelfUpdateUnavailableInstruction(packageName);
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

/**
 * Get the directory containing built-in skills shipped with the package.
 * - For Bun binary: skills/ next to executable
 * - For Node.js (dist/): dist/skills/
 * - For tsx (src/): skills/ at the package root
 */
export function getBundledSkillsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "skills");
	}
	const packageDir = getPackageDir();
	// Source checkouts (tsx) keep built-in skills at the package root; built
	// packages copy them to dist/skills. Decide by whether src/ is present so a
	// stale dist/ from a prior build never shadows live source edits.
	const isSourceCheckout = existsSync(join(packageDir, "src"));
	return isSourceCheckout ? join(packageDir, "skills") : join(packageDir, "dist", "skills");
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;

const piConfigName: string | undefined = pkg.piConfig?.name;
const envPrefix =
	(piConfigName || "pi")
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "") || "PI";
export const PACKAGE_NAME: string = pkg.name || "@earendil-works/pi-coding-agent";
export const APP_NAME: string = piConfigName || "pi";
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".prime/agent";
export const VERSION: string = pkg.version || "0.0.0";

// e.g., PI_CODING_AGENT_DIR or PRIME_AGENT_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${envPrefix}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${envPrefix}_SESSION_DIR`;
export const ENV_LEGACY_SESSION_DIR = `${envPrefix}_CODING_AGENT_SESSION_DIR`;

export function expandTildePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return homedir() + path.slice(1);
	return path;
}

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.prime/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.prime/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME);
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/**
 * Directory where daemon and client diagnostic logs are written (e.g. `~/.prime/agent/logs/`).
 * An explicit `agentDir` pins the target for callers that must keep writing to the directory
 * they started in (see the trace upload's write scope).
 */
export function getLogsDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "logs");
}

/** Log file capturing client-side agent-open failures. */
export function getClientErrorLogPath(): string {
	return join(getLogsDir(), "client-errors.log");
}

export function getAgentTracesLogPath(agentDir: string = getAgentDir()): string {
	return join(getLogsDir(agentDir), "agent-traces.log");
}

/** Shared structured (JSON lines) log for client, daemon, and provider diagnostics. */
export function getAgentLogPath(): string {
	return join(getLogsDir(), "agent.jsonl");
}

/**
 * Log file for a daemon. The basename keeps it readable; a hash of the full
 * socket path makes it unique so two sockets that share a basename (e.g.
 * daemon.sock in different dirs) don't interleave into one file.
 */
export function getDaemonLogPath(socketPath: string): string {
	const normalized = normalizeSocketPath(socketPath);
	const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
	return join(getLogsDir(), `${basename(normalized)}.${hash}.log`);
}

export function getDaemonUpdateRestartManifestPath(socketPath: string, agentDir: string = getAgentDir()): string {
	const normalizedSocketPath = normalizeSocketPath(socketPath);
	const socketHash = createHash("sha256").update(normalizedSocketPath).digest("hex");
	return join(agentDir, "daemon-update-restarts", `${socketHash}.json`);
}

export function getLegacyDaemonUpdateRestartManifestPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "daemon-update-restart.json");
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Append a line to a log file, keeping its size bounded with a single-generation
 * rotation. Opens and closes per call (no held fd), so rotation works at runtime
 * — a long-lived writer rotates on the write that crosses the cap, not only at
 * startup. Best-effort: diagnostics must never throw into the caller.
 */
export function appendRotatingLog(logPath: string, message: string, maxBytes: number = MAX_LOG_BYTES): void {
	try {
		// Only the first append has anything to create; ensuring the file again on
		// every call re-walks the whole private directory tree. The append below
		// still validates the target itself, so a symlinked log path is refused
		// either way.
		if (!existsSync(logPath)) ensurePrivateFile(logPath);
		try {
			if (statSync(logPath).size > maxBytes) {
				// Drop any prior .old first: renameSync fails on Windows if it exists.
				rmSync(`${logPath}.old`, { force: true });
				renameSync(logPath, `${logPath}.old`);
			}
		} catch {
			// Keep appending rather than dropping the log on a rotation failure.
		}
		appendPrivateFile(logPath, `${message}\n`);
	} catch {
		// A read-only or missing log dir must never break the caller.
	}
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to cron jobs store */
export function getCronJobsPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "cron-jobs.json");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to sessions directory */
export function getSessionsDir(agentDir: string = getAgentDir()): string {
	const envDir = getSessionDirEnvOverride();
	if (envDir) {
		return envDir;
	}
	return join(agentDir, "sessions");
}

export function getSessionDirEnvOverride(): string | undefined {
	const envDir = process.env[ENV_SESSION_DIR] ?? process.env[ENV_LEGACY_SESSION_DIR];
	return envDir ? expandTildePath(envDir) : undefined;
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
