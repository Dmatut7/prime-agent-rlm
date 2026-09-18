#!/usr/bin/env bash
set -e

# Credential isolation: the suite must not read, refresh or rewrite the developer's real
# credential stores (`~/.prime/agent/auth.json` and the legacy `~/.pi/agent/auth.json`).
#
# The previous version moved both stores aside and relied on `trap cleanup EXIT` to move them back.
# A trap does not run for SIGKILL, a panic or a power loss: the credentials stayed parked in `.bak`
# and the next run then found no live store at all - the isolation habit held the developer's
# credentials hostage to the suite's own crash. Nothing is moved now. The suite is pointed at a
# throwaway agent directory through the environment variable the product itself resolves
# (`getAgentDir()` reads `<PREFIX>_CODING_AGENT_DIR`; `packages/coding-agent/src/config.ts` derives
# the prefix from the package's `piConfig.name`, which is `prime-agent`, so the effective spelling
# is `PRIME_AGENT_CODING_AGENT_DIR` - both spellings are exported because the prefix follows the
# package name), so every credential path the suite can reach resolves inside the temp directory and
# the real stores are never opened. The temp directory is what the trap cleans up, and losing it to
# a crash costs nothing.
#
# This also makes a local run look like CI: a fresh runner has no `~/.prime/agent` either, so tests
# that still read the developer's real agent directory no longer see this machine's files.
#
# The legacy `~/.pi/agent` store is deliberately not redirected (no env points at it): nothing under
# `src/` reads credentials from it - the only references are the session migration and docs, both of
# which run against the configured agent directory.
TEST_AGENT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/prime-agent-test-agent-dir.XXXXXX")"
trap 'rm -rf "$TEST_AGENT_DIR"' EXIT
export PRIME_AGENT_CODING_AGENT_DIR="$TEST_AGENT_DIR"
export PI_CODING_AGENT_DIR="$TEST_AGENT_DIR"
echo "Agent dir redirected to $TEST_AGENT_DIR (the real credential stores are not touched)"

# Live provider tests are opt-in (see packages/ai/README.md, "Running tests").
# Make sure the opt-in is off so no test reads or refreshes real credentials; the opt-in names a
# dedicated copy of the store (`PI_TEST_AUTH_FILE`) and its helper refuses the real stores.
unset PI_LIVE_TESTS
unset PI_TEST_AUTH_FILE

# Skip local LLM tests (ollama, lmstudio)
export PI_NO_LOCAL_LLM=1

# Unset API keys (see packages/ai/src/stream.ts getEnvApiKey)
unset ANTHROPIC_API_KEY
unset ANTHROPIC_OAUTH_TOKEN
unset OPENAI_API_KEY
unset GEMINI_API_KEY
unset GROQ_API_KEY
unset CEREBRAS_API_KEY
unset XAI_API_KEY
unset OPENROUTER_API_KEY
unset ZAI_API_KEY
unset MISTRAL_API_KEY
unset MINIMAX_API_KEY
unset MINIMAX_CN_API_KEY
unset KIMI_API_KEY
unset HF_TOKEN
unset AI_GATEWAY_API_KEY
unset OPENCODE_API_KEY
unset COPILOT_GITHUB_TOKEN
unset GH_TOKEN
unset GITHUB_TOKEN
unset GOOGLE_APPLICATION_CREDENTIALS
unset GOOGLE_CLOUD_PROJECT
unset GCLOUD_PROJECT
unset GOOGLE_CLOUD_LOCATION
unset AWS_PROFILE
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN
unset AWS_REGION
unset AWS_DEFAULT_REGION
unset AWS_BEARER_TOKEN_BEDROCK
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
unset AWS_CONTAINER_CREDENTIALS_FULL_URI
unset AWS_WEB_IDENTITY_TOKEN_FILE
unset BEDROCK_EXTENSIVE_MODEL_TEST
unset FIREWORKS_API_KEY

echo "Running tests without API keys..."
npm test
