# `DAEMON_OUTBOUND_COMPATIBILITY` has no production consumer (U5)

**Base**: `8ed6d73bc813891679dec7bd11f2160ff218abda` ("fix(scripts): name the process-smoke gate
after its real file and keep self-test side-effect free"). Tree under review:
`packages/coding-agent/src/modes/daemon/daemon-protocol.ts` (1867 lines;
`DAEMON_OUTBOUND_COMPATIBILITY` declared at line 1605).

**Claim (U5)**: the outbound compatibility map is a *registry of record*, not an enforcement point.
No production code reads it; the outbound gate is written by hand at each emitter. A future seat
that treats a row in this table as a gate gets no machine effect at all - so the table says so now.

Every command below is reproduced verbatim in `logs/u5-consumer-scan.sh` (run it with
`bash /tmp/fixD/logs/u5-consumer-scan.sh`); its output is `logs/u5-consumer-scan.out`.

> Run the scans in a **pristine base worktree** (`git worktree add /tmp/scan 8ed6d73bc`). This
> document and the repro scripts quote the identifier, so a scan inside a tree that carries them
> self-matches: in `/tmp/fixD` after this file was written, `grep -rn DAEMON_OUTBOUND_COMPATIBILITY
> docs` finds this file. The canonical numbers below are from the pristine tree.

## 1. Negative scan

```bash
cd /tmp/fixD-scratch        # git worktree add at 8ed6d73bc; `git status --porcelain` empty
grep -rn "DAEMON_OUTBOUND_COMPATIBILITY" . --exclude-dir=node_modules --exclude-dir=.git
# -> 15 hits, exactly these:
#
#   packages/coding-agent/src/modes/daemon/daemon-protocol.ts:1605   the declaration
#   packages/coding-agent/test/daemon-protocol.test.ts:17            import
#   packages/coding-agent/test/daemon-protocol.test.ts:543           assert heartbeats_changed
#   packages/coding-agent/test/daemon-protocol.test.ts:740           assert session_event
#   packages/coding-agent/test/daemon-protocol.test.ts:769           assert session_event
#   packages/coding-agent/test/daemon-protocol.test.ts:894           assert roster_update
#   packages/coding-agent/test/daemon-protocol.test.ts:93            source-text slice boundary
#   packages/coding-agent/test/daemon-protocol.test.ts:356           source-text fixture string
#   docs/fork/audits/rounds/round-30-protocol-chain.md:50            prose
#   docs/fork/review-findings-r3.md:32,53                            prose
#   docs/fork/sync-upstream-r3.md:402                                prose
#   docs/fork/sync-upstream-r3-appendix.md:42,65,503                 prose
SCAN1_HITS=15
```

Classification: **1** declaration, **5** value reads (1 import + 4 assertions, all in one test
file), **9** strings/prose that never read the value (a slice boundary, a fixture, 7 doc lines).

```bash
# The production hemisphere alone: exactly one hit - the declaration.
# NB the glob is the whole set: `packages/*/src` already contains `packages/coding-agent/src`,
# so listing both would print every line twice and inflate the count.
grep -rn "DAEMON_OUTBOUND_COMPATIBILITY" packages/*/src
# -> packages/coding-agent/src/modes/daemon/daemon-protocol.ts:1605:export const DAEMON_OUTBOUND_COMPATIBILITY = {
SCAN2_HITS=1
```

```bash
# No dynamic access: no alias, no computed key, no string-built name.
for pat in "outboundCompatibilit" "OUTBOUND_COMPAT" "outbound_compat" "OUTBOUND COMPATIBILITY"; do
  printf '%-26s -> %s\n' "$pat" "$(grep -rIn "$pat" . --exclude-dir=node_modules --exclude-dir=.git | wc -l | tr -d ' ')"
done
# outboundCompatibilit       -> 0
# OUTBOUND_COMPAT            -> 15   (the same 15 lines: substring of the same identifier)
# outbound_compat            -> 0
# OUTBOUND COMPATIBILITY     -> 0
```

```bash
# Not reachable as a package surface either.
grep -rn "daemon-protocol" packages/coding-agent/src/index.ts packages/coding-agent/package.json
# -> no output (INDEX_HITS=0)
python3 -c "import json; print(json.load(open('packages/coding-agent/package.json'))['exports'])"
# -> {'.': {'types': './dist/index.d.ts', 'import': './dist/index.js'}}
ls packages/coding-agent/dist
# -> ls: packages/coding-agent/dist: No such file or directory   (nothing built in this tree)
```

### Coverage of call paths

The conclusion is "no consumer", so it has to cover every way a binding can be read:
direct `import {…}` (scan 1), namespace import `import * as ns` + `ns.X` (scan 1 - the identifier
still appears), re-export through a barrel (scan 4 - the only package export is `.`), computed /
`Object.keys` / `Reflect` access (scan 3 - no alias or partial-name reference exists anywhere), and
loading the module path dynamically (`import()`/`require` of `daemon-protocol` - scan 4 covers the
only index/package surface; nothing else in the repo references the module path outside tests).
PLT/GOT-style indirection does not exist for TypeScript ES module bindings in this build (no
bundler output in-tree, `dist/` absent).

### Positive control - the same scan does find a consumer of the sibling table

`DAEMON_COMMAND_COMPATIBILITY` is declared in the same file, same `as const satisfies Record<…>`
shape, one screen above, and *is* read by production code:

```bash
grep -rn "DAEMON_COMMAND_COMPATIBILITY\b" packages/*/src
```
```
packages/coding-agent/src/modes/daemon/daemon-protocol.ts:1066:export const DAEMON_COMMAND_COMPATIBILITY = {
packages/coding-agent/src/modes/daemon/daemon-protocol.ts:1322:	return [...requirements, DAEMON_COMMAND_COMPATIBILITY[command.type]];
packages/coding-agent/src/modes/daemon/daemon-supervisor.ts:106:	DAEMON_COMMAND_COMPATIBILITY,
packages/coding-agent/src/modes/daemon/daemon-supervisor.ts:2731:			preParsed.protocolVersion < DAEMON_COMMAND_COMPATIBILITY.get_session_tree.minProtocol
packages/coding-agent/src/modes/daemon/daemon-supervisor.ts:2738:				`get_session_tree requires client protocol ${DAEMON_COMMAND_COMPATIBILITY.get_session_tree.minProtocol} or newer`,
SCAN5_HITS=5
```

It reaches the runtime through four production files:

```bash
grep -rn "getDaemonCommandCompatibilities\|missingDeclaredCommandCapability" packages/*/src
```
```
daemon-protocol.ts:1301  export function getDaemonCommandCompatibilities(...)
daemon-protocol.ts:1329  export function missingDeclaredCommandCapability(...)
daemon-client.ts:20,416            getDaemonCommandCompatibilities
daemon-routed-client.ts:18,159     getDaemonCommandCompatibilities
daemon-supervisor.ts:129,2746      missingDeclaredCommandCapability
daemon-mode.ts:191,4061            missingDeclaredCommandCapability
```

So the method demonstrably reports consumers when consumers exist; the empty result on the outbound
table is a property of the table, not of the scan. (Second control, a planted read, in
`MUTATIONS.md`: 1 hit -> 3 hits and back.)

## 2. The fix: a header comment, nothing else

`patches/0001-*.patch` adds a comment at the top of the table body. Comment only - no behaviour
change, no wiring, no new gate. U5 is not "the table is wrong"; it is "a reader could believe the
table is enforced". Building a real gate is a protocol decision for the outbound emitters and is
out of scope for this pass.

The comment is deliberately placed **inside** the object literal rather than above the declaration:
`test/daemon-protocol.test.ts:91-94` hashes a text slice that *ends at*
`indexOf("export const DAEMON_OUTBOUND_COMPATIBILITY")`, so text above the declaration is part of
the hashed `outbound` slice and would move `DAEMON_SCHEMA_ID` - a wire identity that clients
compare. Text at or below the declaration is outside the slice. Verified: `test/daemon-protocol.test.ts`
stays **33/33 green** with the comment in place, with no `DAEMON_SCHEMA_ID` edit (see `REPORT.md`).

## 3. Business impact

**None on the wire, none on behaviour**: a comment inside a table that no production code reads.
The value is preventive. It stops (a) a future seat from reading this table as a live gate, (b) a
reviewer from re-opening U5 as a "dead table pretending to be a guard", and (c) the next person
from thinking that adding a row here changes what the daemon sends.
