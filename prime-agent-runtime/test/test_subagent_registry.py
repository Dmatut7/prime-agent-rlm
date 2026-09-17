from __future__ import annotations

import asyncio
import importlib
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


rlm_module = importlib.import_module("rlm")


class RlmSubagentRegistryTest(unittest.TestCase):
    def test_lists_parent_scoped_subagents_from_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-a1b2c3d4",
                        "active_session_id": "active-child",
                        "session_id": "session-child",
                        "session_name": "subagent-check-api-a1b2c3d4",
                        "session_dir": "/tmp/parent/sub-a1b2c3d4",
                        "status": "completed",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            subagents = asyncio.run(rlm_module.rlm.list_subagents())

        self.assertEqual(len(subagents), 1)
        self.assertEqual(subagents[0].rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(subagents[0].active_session_id, "active-child")
        self.assertEqual(subagents[0].session_id, "session-child")
        self.assertEqual(subagents[0].session_name, "subagent-check-api-a1b2c3d4")
        self.assertEqual(subagents[0].session_dir, Path("/tmp/parent/sub-a1b2c3d4"))
        self.assertEqual(subagents[0].status, "completed")
        host_request.assert_awaited_once_with("rlm.list_subagents")


    def test_lists_failed_subagents_from_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-failed",
                        "active_session_id": None,
                        "session_id": None,
                        "session_name": "failed-worker",
                        "session_dir": "/tmp/parent/sub-failed",
                        "status": "error",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            subagents = asyncio.run(rlm_module.rlm.list_subagents())

        self.assertEqual(subagents[0].status, "error")

    def test_forwards_orchestrator_chosen_name_and_model_to_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "rlm_child_id": "sub-a1b2c3d4",
                "name": "api-reviewer",
                "session_dir": "/tmp/parent/sub-a1b2c3d4",
                "model": "deepseek/deepseek-v4-flash",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(
                rlm_module.rlm(
                    "check the API",
                    name="api-reviewer",
                    model="deepseek/deepseek-v4-flash",
                )
            )

        host_request.assert_awaited_once_with(
            "rlm.run",
            {
                "prompt": "check the API",
                "kwargs": {
                    "name": "api-reviewer",
                    "model": "deepseek/deepseek-v4-flash",
                },
            },
        )
        self.assertEqual(result.rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(result.name, "api-reviewer")
        self.assertEqual(result.model, "deepseek/deepseek-v4-flash")

    def test_finds_authenticated_models_through_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "models": [
                    {
                        "provider": "anthropic",
                        "id": "claude-opus-4-7",
                        "name": "Claude Opus 4.7",
                        "selector": "anthropic/claude-opus-4-7",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            models = asyncio.run(rlm_module.rlm.find_models("opus", limit=3))

        self.assertEqual(models[0].provider, "anthropic")
        self.assertEqual(models[0].id, "claude-opus-4-7")
        self.assertEqual(models[0].name, "Claude Opus 4.7")
        self.assertEqual(models[0].selector, "anthropic/claude-opus-4-7")
        host_request.assert_awaited_once_with(
            "rlm.find_models",
            {"query": "opus", "limit": 3},
        )

    def test_rejects_invalid_model_search_input_and_response(self) -> None:
        with self.assertRaisesRegex(TypeError, "query must be str"):
            asyncio.run(rlm_module.find_models(123))
        with self.assertRaisesRegex(TypeError, "limit must be int"):
            asyncio.run(rlm_module.find_models("opus", limit="3"))

        host_request = AsyncMock(return_value={"models": [{"provider": "anthropic"}]})
        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "invalid model entry"):
                asyncio.run(rlm_module.find_models("opus"))

    def test_deletes_subagent_by_name_through_host(self) -> None:
        deleted_payload = {
            "rlm_child_id": "sub-a1b2c3d4",
            "active_session_id": "active-child",
            "session_id": "session-child",
            "session_name": "api-reviewer",
            "session_dir": "/tmp/parent/sub-a1b2c3d4",
            "status": "completed",
        }
        host_request = AsyncMock(return_value={"subagent": deleted_payload})

        with patch.object(rlm_module, "host_request", host_request):
            deleted = asyncio.run(rlm_module.rlm.delete_subagent("  api-reviewer  "))

        self.assertEqual(deleted.rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(deleted.session_name, "api-reviewer")
        host_request.assert_awaited_once_with(
            "rlm.delete_subagent",
            {"target": "api-reviewer"},
        )

    def test_deletes_subagent_object_by_child_id(self) -> None:
        subagent = rlm_module.RLMSubagent(
            rlm_child_id="sub-a1b2c3d4",
            active_session_id=None,
            session_id="session-child",
            session_name="api-reviewer",
            session_dir=Path("/tmp/parent/sub-a1b2c3d4"),
            status="running",
        )
        host_request = AsyncMock(
            return_value={
                "subagent": {
                    "rlm_child_id": subagent.rlm_child_id,
                    "active_session_id": subagent.active_session_id,
                    "session_id": subagent.session_id,
                    "session_name": subagent.session_name,
                    "session_dir": str(subagent.session_dir),
                    "status": subagent.status,
                }
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            asyncio.run(rlm_module.delete_subagent(subagent))

        host_request.assert_awaited_once_with(
            "rlm.delete_subagent",
            {"target": "sub-a1b2c3d4"},
        )

    def test_deletes_subagent_by_spawn_handle(self) -> None:
        handle = rlm_module.RLMSpawnHandle(
            rlm_child_id="sub-a1b2c3d4",
            name="api-reviewer",
            session_dir=Path("/tmp/parent/sub-a1b2c3d4"),
            model="deepseek/deepseek-v4-flash",
        )
        deleted_payload = {
            "rlm_child_id": handle.rlm_child_id,
            "active_session_id": None,
            "session_id": None,
            "session_name": handle.name,
            "session_dir": str(handle.session_dir),
            "status": "completed",
        }
        host_request = AsyncMock(return_value={"subagent": deleted_payload})

        with patch.object(rlm_module, "host_request", host_request):
            deleted = asyncio.run(rlm_module.rlm.delete_subagent(handle))

        self.assertEqual(deleted.rlm_child_id, handle.rlm_child_id)
        self.assertEqual(deleted.session_name, handle.name)
        host_request.assert_awaited_once_with(
            "rlm.delete_subagent",
            {"target": "sub-a1b2c3d4"},
        )

    def test_rejects_invalid_delete_response_and_target(self) -> None:
        host_request = AsyncMock(return_value={"subagent": {"status": "completed"}})

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "rlm.delete_subagent entry is missing rlm_child_id"):
                asyncio.run(rlm_module.delete_subagent("api-reviewer"))

        with self.assertRaisesRegex(ValueError, "target must not be empty"):
            asyncio.run(rlm_module.delete_subagent("   "))
        with self.assertRaisesRegex(TypeError, "target must be RLMSpawnHandle, RLMSubagent, or str"):
            asyncio.run(rlm_module.delete_subagent(123))

    def test_rejects_invalid_registry_payload(self) -> None:
        host_request = AsyncMock(return_value={"subagents": [{"status": "completed"}]})

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "missing rlm_child_id"):
                asyncio.run(rlm_module.list_subagents())

    def test_requires_a_default_session_name(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-a1b2c3d4",
                        "active_session_id": None,
                        "session_id": "session-child",
                        "session_dir": "/tmp/parent/sub-a1b2c3d4",
                        "status": "running",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "missing session_name"):
                asyncio.run(rlm_module.list_subagents())



class RlmCollectTest(unittest.TestCase):
    """Typed fan-in (`rlm.collect`), ported from upstream PR #2223 plus fork fields."""

    def test_collect_all_children_returns_typed_results(self) -> None:
        host_request = AsyncMock(
            return_value={
                "results": [
                    {
                        "rlm_child_id": "sub-a1b2c3d4",
                        "session_name": "worker-a",
                        "session_dir": "/tmp/parent/sub-a1b2c3d4",
                        "status": "done",
                        "settled": True,
                        "answer_preview": "task finished cleanly",
                        "error": None,
                        "duration_ms": 4321,
                        "tool_use_count": 3,
                        "replied_since_task": False,
                        "terminal_kind": "completed_without_reply",
                        "terminal_reason": "completed without sending a reply",
                        "stall_abort": None,
                    },
                    {
                        "rlm_child_id": "sub-b2c3d4e5",
                        "session_name": "worker-b",
                        "session_dir": "/tmp/parent/sub-b2c3d4e5",
                        "status": "running",
                        "settled": False,
                        "answer_preview": None,
                        "error": None,
                        "duration_ms": None,
                        "tool_use_count": None,
                        "replied_since_task": None,
                        "activity_kind": "executing",
                        "terminal_kind": None,
                        "terminal_reason": None,
                        "stall_abort": None,
                    },
                ],
                "timeout_ms": 0,
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            results = asyncio.run(rlm_module.rlm.collect())

        self.assertEqual(len(results), 2)
        done = results[0]
        self.assertIsInstance(done, rlm_module.RLMChildResult)
        self.assertEqual(done.rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(done.session_name, "worker-a")
        self.assertEqual(done.session_dir, Path("/tmp/parent/sub-a1b2c3d4"))
        self.assertEqual(done.status, "done")
        self.assertTrue(done.settled)
        self.assertEqual(done.answer_preview, "task finished cleanly")
        self.assertIsNone(done.error)
        self.assertEqual(done.duration_ms, 4321)
        self.assertEqual(done.tool_use_count, 3)
        self.assertFalse(done.replied_since_task)
        self.assertEqual(done.terminal_kind, "completed_without_reply")
        self.assertEqual(done.terminal_reason, "completed without sending a reply")
        self.assertIsNone(done.stall_abort)
        running = results[1]
        self.assertEqual(running.status, "running")
        self.assertFalse(running.settled)
        self.assertIsNone(running.answer_preview)
        self.assertEqual(running.activity_kind, "executing")
        self.assertIsNone(running.terminal_kind)
        host_request.assert_awaited_once_with("rlm.collect", {"targets": [], "timeout_ms": 0})

    def test_collect_exposes_stall_watchdog_facts(self) -> None:
        """Fork enhancement: a watchdog kill must be distinguishable from a no-reply finish."""
        host_request = AsyncMock(
            return_value={
                "results": [
                    {
                        "rlm_child_id": "sub-stalled",
                        "session_name": "stall-worker",
                        "session_dir": "/tmp/parent/sub-stalled",
                        "status": "done",
                        "settled": True,
                        "answer_preview": "the turn ended after the abort",
                        "error": None,
                        "duration_ms": 900,
                        "tool_use_count": 1,
                        "replied_since_task": False,
                        "activity_kind": "stalled",
                        "terminal_kind": "stall_killed",
                        "terminal_reason": "killed by the stall watchdog after 933s of silence",
                        "stall_abort": {
                            "silent_ms": 933000,
                            "threshold_ms": 900000,
                            "in_flight_tools": ["hang_forever"],
                            "kernel_reasons": ["no_kernel_heartbeat"],
                            "settled": True,
                        },
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            (result,) = asyncio.run(rlm_module.rlm.collect(["stall-worker"], timeout_ms=1000))

        self.assertEqual(result.terminal_kind, "stall_killed")
        self.assertEqual(result.activity_kind, "stalled")
        stall = result.stall_abort
        self.assertIsInstance(stall, rlm_module.RLMChildStallAbort)
        self.assertEqual(stall.silent_ms, 933000)
        self.assertEqual(stall.threshold_ms, 900000)
        self.assertEqual(stall.in_flight_tools, ("hang_forever",))
        self.assertEqual(stall.kernel_reasons, ("no_kernel_heartbeat",))
        self.assertTrue(stall.settled)
        host_request.assert_awaited_once_with(
            "rlm.collect", {"targets": ["stall-worker"], "timeout_ms": 1000}
        )

    def test_collect_normalizes_spawn_handles_and_names(self) -> None:
        host_request = AsyncMock(return_value={"results": []})
        handle = rlm_module.RLMSpawnHandle(
            rlm_child_id="sub-h1",
            name="worker-h",
            session_dir=Path("/tmp/parent/sub-h1"),
            model="faux/faux-model",
        )
        row = rlm_module.RLMSubagent(
            rlm_child_id="sub-r1",
            active_session_id=None,
            session_id=None,
            session_name="worker-r",
            session_dir=Path("/tmp/parent/sub-r1"),
            status="completed",
        )

        with patch.object(rlm_module, "host_request", host_request):
            results = asyncio.run(rlm_module.rlm.collect([handle, row, "worker-b"], timeout_ms=250))

        self.assertEqual(results, [])
        host_request.assert_awaited_once_with(
            "rlm.collect", {"targets": ["sub-h1", "sub-r1", "worker-b"], "timeout_ms": 250}
        )

    def test_collect_accepts_a_single_target(self) -> None:
        host_request = AsyncMock(return_value={"results": []})

        with patch.object(rlm_module, "host_request", host_request):
            asyncio.run(rlm_module.rlm.collect("worker-b"))

        host_request.assert_awaited_once_with("rlm.collect", {"targets": ["worker-b"], "timeout_ms": 0})

    def test_collect_accepts_single_spawn_handle_and_subagent_row(self) -> None:
        handle = rlm_module.RLMSpawnHandle(
            rlm_child_id="sub-h1",
            name="worker-h",
            session_dir=Path("/tmp/parent/sub-h1"),
            model="anthropic/claude-sonnet-4-5",
        )
        subagent = rlm_module.RLMSubagent(
            rlm_child_id="sub-r1",
            active_session_id=None,
            session_id="session-child",
            session_name="worker-r",
            session_dir=Path("/tmp/parent/sub-r1"),
            status="running",
        )

        for target, expected_selector in ((handle, "sub-h1"), (subagent, "sub-r1")):
            host_request = AsyncMock(return_value={"results": []})
            with patch.object(rlm_module, "host_request", host_request):
                results = asyncio.run(rlm_module.rlm.collect(target))

            self.assertEqual(results, [])
            host_request.assert_awaited_once_with(
                "rlm.collect", {"targets": [expected_selector], "timeout_ms": 0}
            )

    def test_collect_validates_arguments(self) -> None:
        with self.assertRaisesRegex(TypeError, "timeout_ms"):
            asyncio.run(rlm_module.rlm.collect(timeout_ms=-1))
        with self.assertRaisesRegex(TypeError, "timeout_ms"):
            asyncio.run(rlm_module.rlm.collect(timeout_ms="soon"))
        with self.assertRaisesRegex(TypeError, "timeout_ms"):
            asyncio.run(rlm_module.rlm.collect(timeout_ms=True))
        with self.assertRaisesRegex(TypeError, "targets must be"):
            asyncio.run(rlm_module.rlm.collect(42))
        with self.assertRaisesRegex(TypeError, "collect target"):
            asyncio.run(rlm_module.rlm.collect(["ok", ""]))

    def test_collect_rejects_invalid_payloads(self) -> None:
        invalid_payloads = [
            ({"results": "nope"}, "invalid results list"),
            ({"results": ["nope"]}, "invalid result entry"),
            ({"results": [{"status": "done", "settled": True}]}, "missing rlm_child_id"),
            ({"results": [{"rlm_child_id": "sub-x", "status": "nonsense", "settled": True}]}, "invalid status"),
            ({"results": [{"rlm_child_id": "sub-x", "status": "done", "settled": "yes"}]}, "invalid settled"),
            (
                {"results": [{"rlm_child_id": "sub-x", "status": "done", "settled": True, "terminal_kind": "weird"}]},
                "invalid terminal_kind",
            ),
            (
                {
                    "results": [
                        {
                            "rlm_child_id": "sub-x",
                            "status": "done",
                            "settled": True,
                            "stall_abort": {"silent_ms": "lots"},
                        }
                    ]
                },
                "stall_abort has invalid silent_ms",
            ),
            (
                {
                    "results": [
                        {"rlm_child_id": "sub-x", "status": "done", "settled": True, "duration_ms": "4321"}
                    ]
                },
                "invalid duration_ms",
            ),
            (
                {
                    "results": [
                        {"rlm_child_id": "sub-x", "status": "done", "settled": True, "activity_kind": 3}
                    ]
                },
                "invalid activity_kind",
            ),
        ]
        self.assertGreater(len(invalid_payloads), 0)
        for payload, expected in invalid_payloads:
            host_request = AsyncMock(return_value=payload)
            with patch.object(rlm_module, "host_request", host_request):
                with self.assertRaisesRegex(RuntimeError, expected):
                    asyncio.run(rlm_module.rlm.collect())


if __name__ == "__main__":
    unittest.main()
