# Security Policy

## Project extension trust gate

Extensions under `<cwd>/.prime/agent/extensions` (and extension sources declared by the project's own `.prime/agent/settings.json`) are repository-controlled executable code: they run in the agent process with the invoking user's permissions. Before they load, the directory must be trusted.

- Interactive startup asks once per directory (`~/.prime/agent/project-trust.json` stores the answer, keyed by the canonical path). The prompt offers trust, session-only trust, refusal, or session-only refusal; an aborted prompt decides nothing and the next run asks again.
- Non-interactive runs (`-p`, `--mode json|rpc|acp|daemon`, non-TTY stdin) never prompt: without a saved decision they treat the directory as untrusted, skip the project extensions, and print why on stderr, so unattended runs cannot hang on a prompt.
- `--approve` / `-a` trusts project extensions for one run; `--no-approve` / `-na` ignores them for one run.
- A directory that already had agent sessions when the gate first landed is auto-trusted once (during a 14-day upgrade window) with a notice, so an upgrade does not silently disable extensions an existing workflow depends on.
- The gate covers executable extension sources only. Project-local skills, prompts, themes and context files are data, not code, and keep loading; missing project packages were already never auto-installed without confirmation.

This gate is a trust decision, not a sandbox. Only run the agent in repositories you have reviewed, or use an external isolation boundary for untrusted code.

## Reporting a Vulnerability

Do not report security vulnerabilities through public Issues, Discussions, or pull requests.

Send the report to [security@primeintellect.ai](mailto:security@primeintellect.ai). For encrypted communication and the current company-wide disclosure policy, see [primeintellect.ai/security](https://www.primeintellect.ai/security).

Include the following when possible:

- The affected version or commit
- The affected component and environment
- Reproduction steps or a minimal proof of concept
- The expected and observed impact
- Any known mitigations

Do not include real API keys, tokens, personal data, or credentials in the report. Use redacted or disposable test values.

## Behavioral release evaluation

The `pre-release` label enables a trusted behavioral evaluation before release. Exact base
and head revisions build only inside isolated Prime sandboxes. GitHub runners treat their
packages as opaque bytes and never execute or extract them. Model and sandbox credentials
stay behind trusted Verifiers interception and are removed from candidate process
environments. Separate durable approval and evaluation statuses prevent an in-flight evaluation
from restoring approval after the label is removed. Both statuses are revoked when either candidate
revision changes, and repository rules must require both with strict up-to-date enforcement. See
[`scripts/evals/short_swe/README.md`](scripts/evals/short_swe/README.md)
for the full boundary.

## What to Expect

Maintainers will assess the report, determine its scope, and coordinate remediation and disclosure when appropriate. Please allow time for investigation before publishing details that could put users at risk.

Security fixes are generally prepared against the default branch and released on a schedule chosen by the maintainers. We do not guarantee fixes for older versions.

For ordinary bugs, feature requests, and support questions, use [GitHub Discussions](https://github.com/PrimeIntellect-ai/prime-agent/discussions).
