from __future__ import annotations

import asyncio
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


SKILL = Path(__file__).parents[2] / "packages/coding-agent/skills/agent-message/src/agent_message/__init__.py"


class AgentMessageSkillTest(unittest.TestCase):
    def test_roled_parent_and_broadcast_forms(self) -> None:
        spec = importlib.util.spec_from_file_location("agent_message_test", SKILL)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        host = AsyncMock(return_value={"deliveryStatus": "queued"})
        with patch.object(module, "host_request", host), patch.object(module, "_emit_sent_message"):
            asyncio.run(module.send("done", receiver_role="parent"))
            asyncio.run(module.send("all", "follow up"))
        self.assertEqual(host.await_args_list[0].args[1]["receiver_role"], "parent")
        self.assertEqual(host.await_args_list[1].args[1]["target"], "all")

    def test_roled_selector_validation(self) -> None:
        spec = importlib.util.spec_from_file_location("agent_message_validation", SKILL)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with self.assertRaisesRegex(ValueError, "required"):
            asyncio.run(module.send("hello", receiver_role="child"))
        with self.assertRaisesRegex(ValueError, "omitted"):
            asyncio.run(module.send("hello", receiver_role="parent", receiver_name="x"))
        with self.assertRaisesRegex(TypeError, "unexpected keyword argument 'mode'"):
            asyncio.run(module.send("hello", receiver_role="parent", mode="follow_up"))


    def test_send_mints_one_message_id_per_call(self) -> None:
        spec = importlib.util.spec_from_file_location("agent_message_ids", SKILL)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        host = AsyncMock(return_value={"deliveryStatus": "delivered"})
        with patch.object(module, "host_request", host), patch.object(module, "_emit_sent_message"):
            asyncio.run(module.send("one", receiver_role="parent"))
            asyncio.run(module.send("two", receiver_role="parent"))
            asyncio.run(module.send("all", "broadcast"))
        ids = [call.args[1]["message_id"] for call in host.await_args_list]
        # One id per call, so the host can deliver a repeated call exactly once. Two calls that
        # happen to carry the same text still get two ids and both are delivered.
        self.assertEqual(len(ids), 3)
        self.assertEqual(len(set(ids)), 3)
        for value in ids:
            self.assertRegex(value, r"^[0-9a-f]{32}$")

    def test_duplicate_suppressed_receipt_is_labelled_as_such(self) -> None:
        import rlm

        spec = importlib.util.spec_from_file_location("agent_message_label", SKILL)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cases = [
            ({"duplicateSuppressed": True, "deliveryStatus": "delivered"}, "duplicate suppressed"),
            ({"deliveryStatus": "queued"}, "queued"),
            ({"deliveryStatus": "delivered"}, "sent"),
        ]
        for receipt, expected in cases:
            with self.subTest(receipt=receipt), patch.object(rlm, "emit") as emitted:
                module._emit_sent_message(receipt)
            label = emitted.call_args.args[0]["text/plain"]
            self.assertIn(expected, label)
            if expected != "duplicate suppressed":
                self.assertNotIn("duplicate suppressed", label)


if __name__ == "__main__":
    unittest.main()
