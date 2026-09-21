from __future__ import annotations

import asyncio
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


SKILL = Path(__file__).parents[2] / "packages/coding-agent/skills/agent-message/src/agent_message/__init__.py"


def load_module(name: str):
    spec = importlib.util.spec_from_file_location(name, SKILL)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AgentMessageAbortTest(unittest.TestCase):
    def test_abort_sends_role_name_and_send_queued_default(self) -> None:
        module = load_module("agent_message_abort_default")
        host = AsyncMock(return_value={"target": {"activeSessionId": "child-1"}, "sendQueued": True, "resumedQueued": True})
        with patch.object(module, "host_request", host), patch.object(module, "_emit_abort_message"):
            receipt = asyncio.run(module.abort("child", "wedged-worker"))
        host.assert_awaited_once_with(
            "agent_message.abort",
            {"receiver_role": "child", "receiver_name": "wedged-worker", "send_queued": True},
        )
        self.assertEqual(receipt["resumedQueued"], True)

    def test_abort_send_queued_false_is_forwarded(self) -> None:
        module = load_module("agent_message_abort_plain")
        host = AsyncMock(return_value={"target": {"activeSessionId": "child-1"}, "sendQueued": False})
        with patch.object(module, "host_request", host), patch.object(module, "_emit_abort_message"):
            asyncio.run(module.abort("child", "wedged-worker", send_queued=False))
        self.assertFalse(host.await_args.args[1]["send_queued"])

    def test_abort_parent_form_omits_the_name(self) -> None:
        module = load_module("agent_message_abort_parent")
        host = AsyncMock(return_value={"target": {"activeSessionId": "parent-1"}, "sendQueued": True})
        with patch.object(module, "host_request", host), patch.object(module, "_emit_abort_message"):
            asyncio.run(module.abort("parent"))
        host.assert_awaited_once_with("agent_message.abort", {"receiver_role": "parent", "receiver_name": None, "send_queued": True})

    def test_abort_selector_validation(self) -> None:
        module = load_module("agent_message_abort_validation")
        with self.assertRaisesRegex(ValueError, "receiver_role"):
            asyncio.run(module.abort("grandchild"))
        with self.assertRaisesRegex(ValueError, "required"):
            asyncio.run(module.abort("child"))
        with self.assertRaisesRegex(ValueError, "omitted"):
            asyncio.run(module.abort("parent", "named"))

    def test_abort_surfaces_the_daemon_capability_degrade(self) -> None:
        module = load_module("agent_message_abort_degrade")
        host = AsyncMock(side_effect=RuntimeError('Agent abort is not supported by the connected daemon (missing the "abort_agent_target" capability)'))
        with patch.object(module, "host_request", host), patch.object(module, "_emit_abort_message"):
            with self.assertRaisesRegex(RuntimeError, "abort_agent_target"):
                asyncio.run(module.abort("child", "wedged-worker"))

    def test_abort_labels_the_receipt_by_outcome(self) -> None:
        import rlm

        module = load_module("agent_message_abort_label")
        cases = [
            ({"resumedQueued": True}, "queued work flushed"),
            ({"resumedQueued": False}, "active run stopped"),
        ]
        for receipt, expected in cases:
            with self.subTest(receipt=receipt), patch.object(rlm, "emit") as emitted:
                module._emit_abort_message(receipt, "child")
            payload = emitted.call_args.args[0]
            self.assertIn(expected, payload["text/plain"])
            self.assertEqual(payload["application/vnd.prime-agent.agent-message+json"]["receiverRole"], "child")


if __name__ == "__main__":
    unittest.main()
