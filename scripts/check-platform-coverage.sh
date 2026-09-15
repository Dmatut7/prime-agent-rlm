#!/usr/bin/env bash
# CI-3 gate: a test that only runs on a platform CI does not have must be on a written list.
#
# Why this exists
# ---------------
# Every `runs-on` in this repository is `ubuntu-latest` (twelve of them), so a test guarded by
# `skipIf(process.platform !== "win32")` or `skipIf(process.platform !== "darwin")` never runs
# in CI at all. Nothing said which tests those were: `bash-close-hang-windows.test.ts` sat on
# the shard-1 `max_nothing_files: 3` budget as an unnamed skip and the darwin-only timezone test
# was an individual skip inside a file that otherwise runs. A green board therefore said nothing
# about them, and a *new* platform-only test could be added without anyone noticing.
#
# This gate keeps the inventory written down and checked:
#
#   - it scans the test trees for platform-conditional `skipIf`/`runIf` sites and classifies each
#     one as "runs here" or "requires <platform>";
#   - every discovered file must appear in the registry below: a new platform-conditional test
#     is a red gate that names the file;
#   - an entry requires the platform it names to be one CI cannot provide, and its "no runner"
#     decision must carry a reason;
#   - the platforms CI *does* provide are read from `.github/workflows/*.yml` `runs-on` values,
#     so the day a darwin or windows runner is added, the entries still saying NONE turn red
#     instead of quietly staying unfalsifiable.
#
# It prints the "no runner in CI" list, which is the honest counterpart of a green board: those
# tests are unverified by CI and the report says so.
#
# Usage
# -----
#   bash scripts/check-platform-coverage.sh [--root <dir>] [--registry <file>]
#   bash scripts/check-platform-coverage.sh --self-test
#
# The registry is embedded here (one reviewable artifact, no data file to drift): one line per
# file, `path|requires|runsIn|note`, `requires` in none/win32/darwin/linux/helper (helper = the
# guard is a platform constant this scan cannot resolve; the note must spell it out), `runsIn`
# in NONE/any/<workflow job>.
set -euo pipefail

SELF_TEST=0
ROOT=""
REGISTRY_FILE=""
die() { echo "check-platform-coverage: $*" >&2; exit 2; }

usage() {
	cat >&2 <<'USAGE'
usage: bash scripts/check-platform-coverage.sh [--root <dir>] [--registry <file>]
       bash scripts/check-platform-coverage.sh --self-test
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
		--self-test) SELF_TEST=1; shift ;;
		--root) [ $# -ge 2 ] || die "--root needs an argument"; ROOT="$2"; shift 2 ;;
		--root=*) ROOT="${1#--root=}"; shift ;;
		--registry) [ $# -ge 2 ] || die "--registry needs an argument"; REGISTRY_FILE="$2"; shift 2 ;;
		--registry=*) REGISTRY_FILE="${1#--registry=}"; shift ;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown option $1" ;;
	esac
done

default_registry() {
	cat <<'REGISTRY'
# path|requires|runsIn|note
packages/coding-agent/test/bash-close-hang-windows.test.ts|win32|NONE|the whole describe is win32-only: child-process close handling on Windows; no windows runner exists, nightly-process-stress.yml is ubuntu too
packages/coding-agent/test/suite/regressions/879-timezone-stable-process-identity.test.ts|darwin|NONE|one darwin-only test (supervisor ownership after a timezone change); the rest of the file runs on linux so the file itself is not a nothing-file
packages/coding-agent/test/child-process.test.ts|none|any|skips one test on win32
packages/coding-agent/test/command-recovery-journal.test.ts|none|any|skips one test on win32
packages/coding-agent/test/cron-jobs.test.ts|none|any|runs everywhere but win32
packages/coding-agent/test/daemon-ps.test.ts|none|any|runs everywhere but win32
packages/coding-agent/test/daemon-socket.test.ts|none|any|one describe skips on win32
packages/coding-agent/test/exec.test.ts|none|any|the execCommand describe skips on win32
packages/coding-agent/test/interactive-update-relaunch.test.ts|none|any|skips one test on win32
packages/coding-agent/test/kernel-snapshot-reference-states.test.ts|none|any|skips one test on win32
packages/coding-agent/test/kernel-venv-in-use.test.ts|none|any|skips one test on win32
packages/coding-agent/test/package-temp-cache.test.ts|helper|any|guard is the local IS_WINDOWS constant (= process.platform === "win32"), so it runs on the linux runner
packages/coding-agent/test/proper-lockfile-compromise.test.ts|none|any|skips one test on win32
packages/coding-agent/test/session-manager/flat-storage.test.ts|none|any|three tests run everywhere but win32
packages/coding-agent/test/suite/regressions/6008-headless-python-cancellation.test.ts|none|any|one describe skips on win32
REGISTRY
}

# One line per platform-conditional guard site, reduced to `file|requires|scope`.
scan_sites() {
	local root="$1"
	grep -rnE '\.(skipIf|runIf)\(.*(platform|Platform|WINDOWS|WIN32|DARWIN|LINUX|MAC)' \
		--include='*.test.ts' "$root"/packages/*/test "$root"/prime-agent-runtime/test 2>/dev/null |
		while IFS= read -r line; do
			local path="${line%%:*}"
			local rest="${line#*:}"
			local op cmp platform requires scope
			op=$(printf '%s' "$rest" | sed -nE 's/.*\.(skipIf|runIf)\(.*/\1/p')
			cmp=$(printf '%s' "$rest" | sed -nE 's/.*(!==|===)[[:space:]]*"(win32|darwin|linux)".*/\1/p')
			platform=$(printf '%s' "$rest" | sed -nE 's/.*(!==|===)[[:space:]]*"(win32|darwin|linux)".*/\2/p')
			# `skipIf(x)` runs when x is false; `runIf(x)` runs when x is true. So a required
			# platform is `skipIf(!== p)` or `runIf(=== p)`; the other two spell "any but p".
			if [ -z "$op" ]; then
				requires="unknown"
			elif [ -z "$platform" ]; then
				requires="helper"
			elif [ "$op" = "skipIf" ] && [ "$cmp" = "!==" ]; then
				requires="$platform"
			elif [ "$op" = "runIf" ] && [ "$cmp" = "===" ]; then
				requires="$platform"
			else
				requires="none"
			fi
			scope="test"
			case "$rest" in *"describe.skipIf("*|*"describe.runIf("*) scope="describe" ;; esac
			printf '%s|%s|%s\n' "${path#"$root"/}" "$requires" "$scope"
		done
}

# collapses the sites to one line per file: the platform any of its guards requires (or none).
scan_files() {
	local root="$1"
	scan_sites "$root" | awk -F'|' '
		{
			file = $1; requires = $2; scope = $3;
			if (!(file in first)) first[file] = requires;
			if (requires == "win32" || requires == "darwin" || requires == "linux") {
				platform[file] = requires;
				if (scope == "describe") describe_level[file] = 1;
			} else if (requires == "helper" && !(file in platform)) {
				helper[file] = 1;
			}
		}
		END {
			for (file in first) {
				r = (file in platform) ? platform[file] : (file in helper) ? "helper" : "none";
				s = (file in describe_level) ? "describe" : "test";
				printf "%s|%s|%s\n", file, r, s;
			}
		}' | sort
}

# platforms the workflows provide, derived from `runs-on` rather than from memory.
runner_platforms() {
	local root="$1"
	grep -hE '^[[:space:]]*runs-on:' "$root"/.github/workflows/*.yml 2>/dev/null |
		sed -E 's/.*runs-on:[[:space:]]*//; s/[[:space:]]*$//; s/"//g' |
		sed -E 's/^(ubuntu).*/\1/; s/^(windows).*/\1/; s/^(macos).*/\1/' |
		sort -u
}

# `ubuntu` -> linux, `windows` -> win32, `macos` -> darwin
platform_of_runner() {
	case "$1" in
		ubuntu) echo linux ;;
		windows) echo win32 ;;
		macos) echo darwin ;;
		*) echo "$1" ;;
	esac
}

check() {
	local root="$1" registry="$2"
	local failures=0
	local runners runner_platforms=""
	if [ ! -d "$root/.github/workflows" ]; then
		echo "check-platform-coverage: no .github/workflows under $root" >&2
		return 2
	fi
	runners=$(runner_platforms "$root")
	local runner
	while IFS= read -r runner; do
		[ -n "$runner" ] || continue
		case "$runner" in
			ubuntu|windows|macos) runner_platforms="$runner_platforms $(platform_of_runner "$runner")" ;;
			*) echo "   note: runs-on \"$runner\" is not a literal platform label; the platform it provides is not derived" ;;
		esac
	done <<RUNNERS
$runners
RUNNERS

	if [ -z "${runner_platforms// /}" ]; then
		echo "check-platform-coverage: no literal platform runner found in $root/.github/workflows" >&2
		return 1
	fi
	echo "platform coverage: runners provide:${runner_platforms}"

	local sites observed declared_paths
	sites=$(scan_files "$root")
	observed=$(printf '%s\n' "$sites" | cut -d'|' -f1 | sed '/^$/d' | sort -u)
	declared_paths=$(printf '%s\n' "$registry" | sed '/^#/d; /^$/d' | cut -d'|' -f1 | sort -u)

	local path
	while IFS= read -r path; do
		[ -n "$path" ] || continue
		if ! printf '%s\n' "$declared_paths" | grep -qxF "$path"; then
			echo "   RED: $path carries a platform-conditional skipIf/runIf and is not in the registry" >&2
			echo "        add a line '<path>|<requires>|<runsIn>|<note>' to scripts/check-platform-coverage.sh" >&2
			failures=$((failures + 1))
		fi
	done <<OBSERVED
$observed
OBSERVED

	# no-runner report + the two rules that keep it honest
	local no_runner=""
	while IFS= read -r path; do
		[ -n "$path" ] || continue
		if ! printf '%s\n' "$observed" | grep -qxF "$path"; then
			echo "   RED: the registry declares $path but no platform-conditional guard is left in it (stale entry)" >&2
			failures=$((failures + 1))
			continue
		fi
	done <<DECLARED
$declared_paths
DECLARED

	while IFS='|' read -r path requires runs_in note; do
		case "$path" in ''|'#'*) continue ;; esac
		if [ -z "$note" ]; then
			echo "   RED: the registry entry for $path has no reason" >&2
			failures=$((failures + 1))
		fi
		case "$requires" in
			none|helper) ;;
			win32|darwin|linux)
				if printf '%s\n' $runner_platforms | grep -qxF "$requires"; then
					if [ "$runs_in" = "NONE" ]; then
						echo "   RED: $path needs $requires and CI now has a $requires runner: wire it into a job and drop the NONE" >&2
						failures=$((failures + 1))
					fi
				else
					[ "$runs_in" = "NONE" ] || {
						echo "   RED: $path needs $requires but names '$runs_in'; no workflow provides a $requires runner" >&2
						failures=$((failures + 1))
					}
					no_runner="$no_runner
   NO RUNNER: $path (needs $requires) - $note"
				fi
				;;
			*) echo "   RED: the registry entry for $path has an unknown requires field '$requires'" >&2; failures=$((failures + 1)) ;;
		esac
	done <<REGISTRY
$(printf '%s\n' "$registry" | sed '/^#/d; /^$/d')
REGISTRY

	echo ""
	echo "platform-conditional test files:"
	printf '%s\n' "$sites" | sed 's/^/   /'
	echo "tests with no runner in CI (green boards do not cover these):${no_runner:- (none)}"
	if [ "$failures" != "0" ]; then
		echo "platform coverage gate: RED ($failures problem(s))" >&2
		return 1
	fi
	echo "platform coverage gate: GREEN (registry complete, no-runner list printed)"
	return 0
}

# ---------------------------------------------------------------------------
# self-test: planted registries must be enforced
# ---------------------------------------------------------------------------
self_test() {
	local dir
	dir=$(mktemp -d "${TMPDIR:-/tmp}/platform-coverage-selftest.XXXXXX") || die "cannot mktemp"
	trap "rm -rf '$dir'" EXIT
	mkdir -p "$dir/.github/workflows" "$dir/packages/x/test"
	cat >"$dir/.github/workflows/ci.yml" <<'YAML'
jobs:
  test:
    runs-on: ubuntu-latest
YAML
	cat >"$dir/packages/x/test/win-only.test.ts" <<'TS'
describe.skipIf(process.platform !== "win32")("win", () => {
	it("runs on windows only", () => {});
});
TS
	cat >"$dir/packages/x/test/both.test.ts" <<'TS'
it.runIf(process.platform !== "win32")("runs on linux", () => {});
TS
	cat >"$dir/packages/x/test/helper.test.ts" <<'TS'
const IS_WINDOWS = process.platform === "win32";
it.skipIf(IS_WINDOWS)("runs on linux", () => {});
TS

	local reg_ok="$dir/registry-ok.txt" reg_unregistered="$dir/registry-unregistered.txt"
	local reg_runnable="$dir/registry-runnable.txt" reg_stale="$dir/registry-stale.txt" reg_noreason="$dir/registry-noreason.txt"
	cat >"$reg_ok" <<'REG'
packages/x/test/both.test.ts|none|any|runs everywhere but win32
packages/x/test/helper.test.ts|helper|any|guard is the IS_WINDOWS constant
packages/x/test/win-only.test.ts|win32|NONE|windows-only child-process close handling; no windows runner
REG
	cat >"$reg_unregistered" <<'REG'
packages/x/test/both.test.ts|none|any|runs everywhere but win32
packages/x/test/helper.test.ts|helper|any|guard is the IS_WINDOWS constant
REG
	cat >"$reg_runnable" <<'REG'
packages/x/test/both.test.ts|none|any|runs everywhere but win32
packages/x/test/helper.test.ts|helper|any|guard is the IS_WINDOWS constant
packages/x/test/win-only.test.ts|win32|NONE|windows-only child-process close handling
REG
	cat >"$reg_stale" <<'REG'
packages/x/test/both.test.ts|none|any|runs everywhere but win32
packages/x/test/helper.test.ts|helper|any|guard is the IS_WINDOWS constant
packages/x/test/win-only.test.ts|win32|NONE|windows-only
packages/x/test/deleted.test.ts|none|any|left behind after the file was removed
REG
	cat >"$reg_noreason" <<'REG'
packages/x/test/both.test.ts|none|any|runs everywhere but win32
packages/x/test/helper.test.ts|helper|any|guard is the IS_WINDOWS constant
packages/x/test/win-only.test.ts|win32|NONE|
REG

	local mismatches=0
	expect() {
		local name="$1" want="$2" needle="$3"; shift 3
		local out rc
		out=$("$@" 2>&1) && rc=0 || rc=$?
		local ok=1
		[ "$rc" = "$want" ] || ok=0
		if [ -n "$needle" ] && ! printf '%s' "$out" | grep -qF "$needle"; then ok=0; fi
		if [ "$ok" = "1" ]; then
			printf 'ok   %s (exit %s)\n' "$name" "$rc"
		else
			mismatches=$((mismatches + 1))
			printf 'FAIL %s (want exit %s, got %s; wanted text "%s")\n' "$name" "$want" "$rc" "$needle"
			printf '%s\n' "$out" | sed 's/^/       /'
		fi
	}

	expect "a complete registry is green and lists the no-runner test" 0 "NO RUNNER: packages/x/test/win-only.test.ts (needs win32)" check "$dir" "$(cat "$reg_ok")"
	expect "an unregistered platform-conditional file is red" 1 "is not in the registry" check "$dir" "$(cat "$reg_unregistered")"
	expect "a stale registry entry is red" 1 "no platform-conditional guard is left in it" check "$dir" "$(cat "$reg_stale")"
	expect "an entry with no reason is red" 1 "has no reason" check "$dir" "$(cat "$reg_noreason")"
	expect "a runner that now exists turns the NONE entry red" 1 "CI now has a win32 runner" check_with_windows_runner "$dir" "$(cat "$reg_runnable")"
	expect "a helper constant is classified, not silently 'none'" 0 "packages/x/test/helper.test.ts|helper" check "$dir" "$(cat "$reg_ok")"
	expect "a missing workflows dir is a usage-shaped failure" 2 "no .github/workflows" check "$dir/packages" "$(cat "$reg_ok")"

	echo "self-test: 7 controls, $mismatches mismatch(es)"
	if [ "$mismatches" != "0" ]; then exit 1; fi
}

# a copy of the fixture tree with a windows runner in the workflow
check_with_windows_runner() {
	local dir="$1" registry="$2"
	local copy="$dir/with-windows"
	rm -rf "$copy"
	mkdir -p "$copy/.github/workflows" "$copy/packages"
	cp -R "$dir/packages" "$copy/packages"
	cat >"$copy/.github/workflows/ci.yml" <<'YAML'
jobs:
  test:
    runs-on: ubuntu-latest
  windows:
    runs-on: windows-latest
YAML
	check "$copy" "$registry"
}

if [ "$SELF_TEST" = "1" ]; then
	self_test
	exit $?
fi

if [ -z "$ROOT" ]; then
	ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
registry=$(default_registry)
if [ -n "$REGISTRY_FILE" ]; then
	registry=$(cat "$REGISTRY_FILE")
fi
check "$ROOT" "$registry"
