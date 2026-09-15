from __future__ import annotations

import os
import unittest
from unittest import mock

from rlm import bash


class BashChildEnvTest(unittest.IsolatedAsyncioTestCase):
    """bash() children run model-authored shell code: the kernel env (worker
    auth token, injected provider keys such as SERPER_API_KEY, the user's agent
    socket) must not ride along into them."""

    async def test_bash_children_do_not_see_injected_secrets(self):
        secrets = {
            "SERPER_API_KEY": "serper-secret-xyz",
            "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN": "worker-token-xyz",
            "SSH_AUTH_SOCK": "/tmp/ssh-agent-sock",
            "GITHUB_TOKEN": "gh-token-xyz",
            "ANTHROPIC_API_KEY": "anthropic-key-xyz",
            "RLM_SESSION_DIR": "/tmp/rlm-session",
        }
        with mock.patch.dict(os.environ, secrets):
            result = await bash("env | sort")
        self.assertEqual(result.exit_code, 0)
        for key, value in secrets.items():
            self.assertNotIn(key, result.output, f"{key} leaked to bash() child")
            self.assertNotIn(value, result.output)

    async def test_bash_children_keep_working_environment(self):
        # Positive control: a filtered env must still be a usable shell env.
        result = await bash("env | sort")
        self.assertEqual(result.exit_code, 0)
        self.assertRegex(result.output, r"(?m)^PATH=")
        if "HOME" in os.environ:
            self.assertIn(f"HOME={os.environ['HOME']}", result.output)
        if "TMPDIR" in os.environ:
            self.assertIn(f"TMPDIR={os.environ['TMPDIR']}", result.output)

    async def test_bash_children_honor_explicit_passthrough(self):
        # The opt-in hatch: names listed in PRIME_AGENT_ENV_PASSTHROUGH (comma
        # separated) are forwarded to bash() children on request.
        with mock.patch.dict(
            os.environ,
            {
                "PRIME_AGENT_ENV_PASSTHROUGH": "SERPER_API_KEY,CI_TEST_TOKEN",
                "SERPER_API_KEY": "opted-in-serper-key",
                "CI_TEST_TOKEN": "opted-in-token",
            },
        ):
            result = await bash("printenv SERPER_API_KEY; printenv CI_TEST_TOKEN")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("opted-in-serper-key", result.output)
        self.assertIn("opted-in-token", result.output)


if __name__ == "__main__":
    unittest.main()
