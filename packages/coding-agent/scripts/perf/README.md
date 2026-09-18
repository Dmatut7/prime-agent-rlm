# Harness search parity instrument

Cross-language instrument for one claim: under a restricted口径 the TS harness
digest window (`packages/coding-agent/src/core/refinement/refinement.ts`) and the
Python kernel's `harness.search` (`prime-agent-runtime/src/rlm/harness.py`) rank
the same corpus into the same ids, and every place they deliberately differ is
recorded instead of smoothed over.

## Files and how they are wired

| file | role | runs under |
| --- | --- | --- |
| `harness-parity.mjs` | orchestrator: parses options, spawns both faces, computes the independent reference scores, compares, writes the golden and the report | plain `node` |
| `harness-parity-ts.ts` | TS face driver: loads the fixture through `loadHarnessState`, then reports idf/scores/ranking/rendered window | spawned by the orchestrator as `node_modules/.bin/tsx harness-parity-ts.ts` (it must live inside the repo so tsx resolves the workspace `tsconfig.json` paths to `packages/*/src`) |
| `harness-parity-python.py` | Python face driver: loads the same bytes through `HarnessState`, derives the production idf from `search` itself, then reports scores/order | spawned by the orchestrator as `<python> harness-parity-python.py --runtime-src=prime-agent-runtime/src` |

Neither driver spawns the other language, and neither is part of a test face:
`packages/coding-agent/scripts/perf/**` is outside both `biome.json`'s
`files.includes` and the root `tsconfig.json`'s `include` (verified:
`npx biome check packages/coding-agent/scripts/perf/` answers "These paths were
provided but ignored", and `npx tsgo --noEmit` never loads these files). **No repo
gate therefore covers this directory: after editing anything here you must run
`node packages/coding-agent/scripts/perf/harness-parity.mjs --python=<python3.11+>
--verify` by hand and read its exit code** (0 = both faces and the reference scorer
still agree and the golden still reproduces). The sealed needles that CI does run are
`packages/coding-agent/test/harness-search-parity.test.ts` (vitest, never spawns
Python) and `prime-agent-runtime/test/test_harness_search_parity.py` (unittest,
never spawns Node); both pin the golden this instrument writes.

## Usage

```sh
node packages/coding-agent/scripts/perf/harness-parity.mjs --help
node packages/coding-agent/scripts/perf/harness-parity.mjs --python=<python3.11+>          # verify
node packages/coding-agent/scripts/perf/harness-parity.mjs --python=<python3.11+> --write  # re-mint expected.json
node packages/coding-agent/scripts/perf/harness-parity.mjs --python=<python3.11+> --break=py:idf  # positive control
```

`--python` has no silent fallback: an interpreter older than 3.11 (the runtime's
`requires-python`) aborts with an error. `--break=<side>:<name>` arms exactly one
face's deliberately wrong path and *requires* the comparator to catch it; a clean
run under a break exits non-zero because a positive control that cannot fail
proves nothing.

The scoring口径, the six documented divergences and the reproduction commands are
in `docs/fork/evidence/harness-search-parity.md`.
