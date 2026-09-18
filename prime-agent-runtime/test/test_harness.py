from __future__ import annotations

import importlib
import json
import math
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from rlm import harness as package_harness
from rlm import rlm as callable_rlm
from rlm.harness import HarnessState, get_harness_state

PYTHON_REFERENCE = {
    "type": "python",
    "import": "agent_skills.example",
    "callable": "run",
    "call_pattern": "await run(...)",
}


class HarnessStateTest(unittest.TestCase):
    def test_crud_for_all_entry_kinds(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            created = {
                "prompt": state.create_prompt_note(
                    "Prompt note",
                    "Prompt content",
                    id="prompt_entry",
                    path="prompt/path",
                    metadata={"kind": "prompt"},
                ),
                "memory": state.create_memory(
                    "Memory",
                    "Memory content",
                    id="memory_entry",
                    path="memory/path",
                    metadata={"kind": "memory"},
                ),
                "skill": state.create_skill(
                    "Skill",
                    "Skill content",
                    id="skill_entry",
                    path="skill/path",
                    reference=PYTHON_REFERENCE,
                    arguments={"target": {"type": "string", "required": True}},
                    metadata={"kind": "skill"},
                ),
                "subagent": state.create_subagent(
                    "Subagent",
                    "Subagent content",
                    id="subagent_entry",
                    path="subagent/path",
                    metadata={"kind": "subagent"},
                ),
            }

            for kind, entry in created.items():
                self.assertEqual(entry.kind, kind)
                self.assertIn("content", state.get(kind, entry.id).content.lower())
                self.assertIn(entry, state.list(kind))

            state.update_prompt_note("prompt_entry", "Prompt note", "Prompt content updated")
            state.update_memory("memory_entry", "Memory", "Memory content updated")
            state.update_skill(
                "skill_entry",
                "Skill",
                "Skill content updated",
                reference=PYTHON_REFERENCE,
                arguments={"target": {"type": "string", "required": True}, "mode": {"type": "string"}},
            )
            state.update_subagent("subagent_entry", "Subagent", "Subagent content updated")

            for kind in ("prompt", "memory", "skill", "subagent"):
                entry_id = f"{kind}_entry"
                self.assertEqual(state.get(kind, entry_id).version, 2)
                self.assertIn("updated", state.get(kind, entry_id).content)
                delete_method = getattr(state, f"delete_{'prompt_note' if kind == 'prompt' else kind}")
                self.assertTrue(delete_method(entry_id))
                self.assertIsNone(state.get(kind, entry_id))
                self.assertFalse(delete_method(entry_id))

            self.assertEqual(state.list(), [])

    def test_persists_entries_and_refinements(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            memory = state.create_memory(
                "Prefer focused patches",
                "Small harness updates are easier to validate than broad rewrites.",
                path="engineering",
            )
            skill = state.create_skill(
                "Check failures first",
                "Inspect current failure evidence before editing code.",
                id="failure_first",
                reference=PYTHON_REFERENCE,
                arguments={"failure_log": {"type": "string", "description": "Current failure evidence."}},
            )
            subagent = state.create_subagent(
                "Reviewer",
                "Review the proposed patch for regressions and missing tests.",
                metadata={"max_turns": 3},
            )
            state.create_prompt_note("Refinement cadence", "Refine only after repeated evidence.")
            event = state.record_refinement(
                "skill failed twice",
                ["updated failure_first skill", "added reviewer subagent"],
                evidence="two failed validations",
                outcome="next validation passed",
            )

            reloaded = HarnessState(state.file_path)

            self.assertEqual(reloaded.get("memory", memory.id).content, memory.content)
            self.assertEqual(reloaded.get("skill", skill.id).version, 1)
            self.assertEqual(reloaded.get("skill", skill.id).arguments["failure_log"]["type"], "string")
            self.assertEqual(reloaded.get("subagent", subagent.id).metadata["max_turns"], 3)
            self.assertEqual(reloaded.refinements[0].id, event.id)
            self.assertIn("Prefer focused patches", reloaded.overview())
            self.assertIn(
                "Call contract: installed Python skills use await <skill_import>(...)",
                reloaded.overview(),
            )
            overview = reloaded.overview()
            self.assertIn("handle = await rlm('sub-task')", overview)
            self.assertIn("never the child's answer", overview)
            self.assertIn("receiver_role='parent'", overview)
            self.assertIn("await rlm.list_subagents()", overview)
            self.assertIn("receiver_role='child'", overview)
            self.assertIn("refinements: 1", reloaded.overview())

    def test_windows_harness_proxy_never_resolves_or_writes(self) -> None:
        from unittest.mock import patch

        harness_module = importlib.import_module("rlm.harness")
        # Create the sentinel path before patching: os.name is patched process-wide,
        # and on POSIX instantiating Path under os.name == "nt" raises.
        sentinel = Path("should-not-be-read")
        with patch.object(harness_module.os, "name", "nt"), patch.object(
            harness_module, "_state_file", side_effect=AssertionError("state path must not resolve")
        ):
            state = harness_module.get_harness_state(sentinel)
            self.assertEqual(state.list(), [])
            with self.assertRaisesRegex(RuntimeError, "Persistent harness storage is unsupported on Windows"):
                state.create_memory("blocked", "blocked")
            with self.assertRaisesRegex(RuntimeError, "Persistent harness storage is unsupported on Windows"):
                state.save()

    @unittest.skipIf(os.name == "nt", "POSIX permissions and symlink semantics")
    def test_private_atomic_state_rejects_symlink_destination(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "harness"
            state_path = root / "harness_state.json"
            state = HarnessState(state_path, scope="global")
            state.save()

            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(state_path.stat().st_mode), 0o600)

            outside = Path(temp_dir) / "outside.json"
            outside.write_text("sentinel", encoding="utf-8")
            state_path.unlink()
            state_path.symlink_to(outside)

            with self.assertRaisesRegex(OSError, "non-regular private file"):
                state.save()
            self.assertEqual(outside.read_text(encoding="utf-8"), "sentinel")

    @unittest.skipIf(os.name == "nt", "POSIX permissions and symlink semantics")
    def test_symlinked_harness_load_blocks_later_save(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "harness"
            root.mkdir(mode=0o700)
            state_path = root / "harness_state.json"
            outside = Path(temp_dir) / "outside.json"
            outside.write_text('{"sentinel": true}', encoding="utf-8")
            state_path.symlink_to(outside)

            state = HarnessState(state_path, scope="global")
            self.assertEqual(state.list(), [])
            with self.assertRaisesRegex(RuntimeError, "non-regular private file"):
                state.save()
            self.assertEqual(outside.read_text(encoding="utf-8"), '{"sentinel": true}')

    @unittest.skipIf(os.name == "nt", "POSIX symlink semantics")
    def test_existing_harness_directory_below_symlinked_ancestor_is_resolved(self) -> None:
        # Intermediate ancestor symlinks are legitimate layouts (e.g. a
        # relocated ~/.prime); they are followed after resolution. Only a
        # symlinked state file itself is refused.
        with tempfile.TemporaryDirectory() as temp_dir:
            outside = Path(temp_dir) / "outside"
            existing = outside / "existing"
            existing.mkdir(parents=True, mode=0o755)
            link = Path(temp_dir) / "link"
            link.symlink_to(outside, target_is_directory=True)
            state = HarnessState(link / "existing" / "harness_state.json")

            state.create_memory("Relocated", "works through the link", id="relocated")
            self.assertEqual(stat.S_IMODE(existing.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((existing / "harness_state.json").stat().st_mode), 0o600)
            self.assertIsNotNone(state.get("memory", "relocated"))

    @unittest.skipIf(os.name == "nt", "POSIX symlink semantics")
    def test_relocated_home_layout_reads_and_writes_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            real_store = Path(temp_dir) / "real-store"
            home = Path(temp_dir) / "home"
            real_store.mkdir(mode=0o700)
            home.mkdir(mode=0o755)
            (home / ".prime").symlink_to(real_store, target_is_directory=True)
            state_path = home / ".prime" / "agent" / "harness" / "harness_state.json"

            state = HarnessState(state_path, scope="global")
            state.create_memory("Symlinked home", "memory survives relocation", id="home_memory")

            landed = real_store / "agent" / "harness" / "harness_state.json"
            self.assertTrue(landed.is_file())
            self.assertEqual(stat.S_IMODE(landed.stat().st_mode), 0o600)
            reloaded = HarnessState(state_path, scope="global")
            self.assertIsNotNone(reloaded.get("memory", "home_memory"))

    @unittest.skipIf(os.name == "nt", "POSIX symlink semantics")
    def test_cached_missing_state_rejects_unsafe_replacement_before_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state = HarnessState(state_path)
            outside = Path(temp_dir) / "outside.json"
            outside.write_text('{"sentinel": true}', encoding="utf-8")
            state_path.symlink_to(outside)

            with self.assertRaisesRegex(RuntimeError, "non-regular private file"):
                state.create_memory("Blocked", "must not remain in memory", id="blocked")
            self.assertIsNone(state.get("memory", "blocked"))

    @unittest.skipIf(os.name == "nt", "POSIX no-follow capability")
    def test_missing_no_follow_capability_fails_closed(self) -> None:
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            with patch.object(os, "O_NOFOLLOW", new=None):
                with self.assertRaisesRegex(OSError, "O_NOFOLLOW"):
                    state.save()

    def test_load_ignores_unknown_json_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "schema": 1,
                        "entries": {
                            "memory": {
                                "known": {
                                    "id": "mismatched",
                                    "kind": "skill",
                                    "title": "Known memory",
                                    "content": "Loaded despite extra keys.",
                                    "path": 123,
                                    "source": None,
                                    "version": "2",
                                    "metadata": "not a dict",
                                    "unexpected": True,
                                },
                                "missing_content": {
                                    "title": "Missing content",
                                }
                            }
                        },
                        "refinements": [
                            {
                                "id": "refine_extra",
                                "trigger": "extra keys",
                                "changes": [1, "loaded"],
                                "ignored": "value",
                            },
                            {
                                "id": "refine_missing_changes",
                                "trigger": "missing changes",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            state = HarnessState(state_path)

            self.assertEqual(state.get("memory", "known").content, "Loaded despite extra keys.")
            self.assertEqual(state.get("memory", "known").id, "known")
            self.assertEqual(state.get("memory", "known").kind, "memory")
            self.assertEqual(state.get("memory", "known").path, "general")
            self.assertEqual(state.get("memory", "known").source, "agent")
            self.assertIsNone(state.get("memory", "mismatched"))
            self.assertEqual(state.get("memory", "known").version, 2)
            self.assertEqual(state.get("memory", "known").metadata, {})
            self.assertIsNone(state.get("memory", "missing_content"))
            self.assertEqual(state.refinements[0].id, "refine_extra")
            self.assertEqual(state.refinements[0].changes, ["1", "loaded"])
            self.assertEqual(len(state.refinements), 1)
            self.assertIn("1, loaded", state.overview())

            updated = state.update_memory("known", "Known memory", "Updated content.")
            self.assertEqual(updated.version, 3)

    def test_skill_arguments_are_first_class(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            created = state.create_skill(
                "Edit file",
                "Apply a targeted edit.",
                id="edit_file",
                reference={
                    "type": "python",
                    "import": "agent_skills.file_edit",
                    "callable": "file_edit",
                    "call_pattern": "await file_edit(path=..., find=..., replace=...)",
                },
                arguments={
                    "path": {"type": "string", "required": True},
                    "find": {"type": "string", "required": True},
                    "replace": {"type": "string", "required": True},
                },
            )
            updated = state.update_skill(
                "edit_file",
                "Edit file",
                "Apply a targeted edit after reading context.",
                reference={
                    "type": "python",
                    "import": "agent_skills.file_edit",
                    "callable": "file_edit",
                    "call_pattern": "await file_edit(path=..., find=..., replace=...)",
                },
                arguments={
                    "path": {"type": "string", "required": True},
                    "find": {"type": "string", "required": True},
                    "replace": {"type": "string", "required": True},
                    "validate": {"type": "boolean", "default": True},
                },
            )
            reloaded = HarnessState(state.file_path)

            self.assertEqual(created.arguments["path"]["required"], True)
            self.assertEqual(created.reference["type"], "python")
            self.assertEqual(updated.version, 2)
            self.assertEqual(reloaded.get("skill", "edit_file").arguments["validate"]["default"], True)
            self.assertEqual(reloaded.get("skill", "edit_file").reference["import"], "agent_skills.file_edit")
            self.assertIn('"path"', reloaded.overview())
            self.assertIn("agent_skills", reloaded.overview())

    def test_skill_references_must_be_python(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            with self.assertRaisesRegex(ValueError, "Python reference"):
                state.create_skill("No reference", "missing", arguments={})
            with self.assertRaisesRegex(ValueError, "reference.type must be 'python'"):
                state.create_skill(
                    "Shell reference",
                    "bad",
                    reference={"type": "shell", "command": "edit"},
                    arguments={},
                )
            with self.assertRaisesRegex(ValueError, "Python import"):
                state.create_skill("No import", "bad", reference={"type": "python", "callable": "run"}, arguments={})
            with self.assertRaisesRegex(ValueError, "callable or call_pattern"):
                state.create_skill(
                    "No callable",
                    "bad",
                    reference={"type": "python", "import": "agent_skills.bad"},
                    arguments={},
                )

    def test_load_tolerates_corrupt_or_non_object_state(self) -> None:
        for payload in ("not json at all", "null", "[]", '"a string"', "123"):
            with tempfile.TemporaryDirectory() as temp_dir:
                state_path = Path(temp_dir) / "harness_state.json"
                state_path.write_text(payload, encoding="utf-8")

                state = HarnessState(state_path)

                self.assertEqual(state.list(), [])
                self.assertEqual(state.refinements, [])
                # The store must remain usable and self-heal on the next write.
                created = state.create_memory("Recovered", "Works after corruption.", id="recovered")
                self.assertEqual(HarnessState(state_path).get("memory", "recovered").content, created.content)

    def test_update_skill_preserves_omitted_arguments(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_skill(
                "Edit file",
                "Apply an edit.",
                id="edit_file",
                reference=PYTHON_REFERENCE,
                arguments={"path": {"type": "string", "required": True}},
            )

            # Updating only title/content (arguments omitted) must keep the contract.
            state.update_skill("edit_file", "Edit file", "Apply an edit carefully.", reference=PYTHON_REFERENCE)
            self.assertEqual(state.get("skill", "edit_file").arguments, {"path": {"type": "string", "required": True}})

            # An explicit empty dict still clears it.
            state.update_skill("edit_file", "Edit file", "Now argument-free.", reference=PYTHON_REFERENCE, arguments={})
            self.assertEqual(state.get("skill", "edit_file").arguments, {})

    def test_update_skill_without_reference_preserves_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_skill(
                "Edit file",
                "Apply an edit.",
                id="edit_file",
                reference=PYTHON_REFERENCE,
                arguments={"path": {"type": "string", "required": True}},
            )

            # A title/content-only update must not require re-sending the reference,
            # and must preserve the existing reference and arguments.
            updated = state.update_skill("edit_file", "Edit file", "Apply an edit carefully.")

            self.assertEqual(updated.version, 2)
            self.assertEqual(updated.reference, PYTHON_REFERENCE)
            self.assertEqual(updated.arguments, {"path": {"type": "string", "required": True}})
            self.assertEqual(updated.content, "Apply an edit carefully.")

    def test_update_preserves_omitted_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Grouped", "content", id="grouped", path="repo/testing")

            # Updating without a path keeps the custom grouping path.
            state.update_memory("grouped", "Grouped", "new content")
            self.assertEqual(state.get("memory", "grouped").path, "repo/testing")

            # An explicit path still moves it.
            state.update_memory("grouped", "Grouped", "newer", path="repo/other")
            self.assertEqual(state.get("memory", "grouped").path, "repo/other")

    def test_in_memory_state_never_touches_disk(self) -> None:
        previous = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
            os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
            try:
                state = HarnessState(in_memory=True)
                created = state.create_memory("Volatile", "in memory only", id="volatile")
                state.record_refinement("trigger", ["change"])

                self.assertIsNone(state.file_path)
                self.assertEqual(created.content, "in memory only")
                self.assertEqual(state.get("memory", "volatile").content, "in memory only")
                # Local in-memory operations do not resolve or persist a path.
                self.assertEqual(list(Path(temp_dir).iterdir()), [])
            finally:
                if previous is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

    def test_in_memory_state_global_flag_uses_global_env_store(self) -> None:
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = HarnessState(in_memory=True)
                global_entry = state.create_memory("Global note", "persisted", id="global_note", global_=True)
            finally:
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertIsNone(state.file_path)
            self.assertEqual(global_entry.scope, "global")
            self.assertEqual(global_entry.content, "persisted")
            self.assertIsNone(state.get("memory", "global_note"))
            self.assertEqual(
                HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "global_note").content,
                "persisted",
            )

    def test_in_memory_state_global_flag_uses_default_global_store(self) -> None:
        previous_agent_dir = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            agent_dir = Path(temp_dir) / "agent"
            os.environ["PRIME_AGENT_CODING_AGENT_DIR"] = str(agent_dir)
            os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
            try:
                state = HarnessState(in_memory=True)
                global_entry = state.create_memory("Default global", "persisted", id="default_global", global_=True)
            finally:
                if previous_agent_dir is None:
                    os.environ.pop("PRIME_AGENT_CODING_AGENT_DIR", None)
                else:
                    os.environ["PRIME_AGENT_CODING_AGENT_DIR"] = previous_agent_dir
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertIsNone(state.file_path)
            self.assertEqual(global_entry.scope, "global")
            self.assertIsNone(state.get("memory", "default_global"))
            self.assertEqual(
                HarnessState(agent_dir / "harness" / "harness_state.json", scope="global")
                .get("memory", "default_global")
                .content,
                "persisted",
            )

    def test_reloads_external_writes_before_mutating(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            kernel_state = HarnessState(state_path)
            kernel_state.create_memory("Kernel note", "Written from the kernel.", id="kernel")

            # Simulate the host /refine command rewriting the same file from another
            # process. A second instance loads the current file, adds an entry, saves.
            host_state = HarnessState(state_path)
            host_state.create_memory("Host note", "Written by /refine.", id="host")
            # Guarantee the mtime advances even on coarse-resolution filesystems.
            future = state_path.stat().st_mtime + 5
            os.utime(state_path, (future, future))

            # A read on the long-lived kernel state must observe the host write.
            self.assertEqual(kernel_state.get("memory", "host").content, "Written by /refine.")

            # A mutation must merge onto the host write instead of clobbering it.
            kernel_state.create_memory("Second kernel note", "Written later.", id="kernel_2")

            reloaded = HarnessState(state_path)
            self.assertIsNotNone(reloaded.get("memory", "kernel"))
            self.assertIsNotNone(reloaded.get("memory", "host"))
            self.assertIsNotNone(reloaded.get("memory", "kernel_2"))

    def test_create_detects_externally_written_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state = HarnessState(state_path)

            # Another process creates the same entry on disk after our last load.
            other = HarnessState(state_path)
            other.create_memory("External", "Written elsewhere.", id="dup")
            future = state_path.stat().st_mtime + 5
            os.utime(state_path, (future, future))

            # create() must observe the external entry and honor create-or-fail.
            with self.assertRaisesRegex(ValueError, "already exists"):
                state.create_memory("Local", "Should not overwrite.", id="dup")
            self.assertEqual(state.get("memory", "dup").content, "Written elsewhere.")

    def test_explicit_create_and_update_enforce_entry_existence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            first = state.create_skill("Triage", "old", id="triage", reference=PYTHON_REFERENCE, arguments={})
            with self.assertRaisesRegex(ValueError, "already exists"):
                state.create_skill("Triage", "duplicate", id="triage", reference=PYTHON_REFERENCE, arguments={})
            with self.assertRaisesRegex(ValueError, "does not exist"):
                state.update_skill("missing", "Missing", "missing", reference=PYTHON_REFERENCE, arguments={})

            second = state.update_skill("triage", "Triage", "new", reference=PYTHON_REFERENCE, arguments={})

            self.assertEqual(first.id, second.id)
            self.assertEqual(second.content, "new")
            self.assertEqual(second.version, 2)

    def test_explicit_state_dir_cache_uses_harness_state_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = get_harness_state(temp_dir)
            again = get_harness_state(temp_dir)

            self.assertIs(state, again)
            self.assertEqual(state.file_path, Path(temp_dir).resolve() / "harness_state.json")

    def test_explicit_state_dir_global_flag_uses_matching_state_file(self) -> None:
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            explicit_dir = Path(temp_dir) / "explicit"
            env_global_dir = Path(temp_dir) / "env-global"
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(env_global_dir)
            try:
                state = get_harness_state(explicit_dir)
                global_entry = state.create_memory("Scoped global", "custom dir", id="scoped_global", global_=True)
            finally:
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(global_entry.scope, "global")
            self.assertIsNotNone(
                HarnessState(explicit_dir / "harness_state.json", scope="global").get("memory", "scoped_global")
            )
            self.assertFalse((env_global_dir / "harness_state.json").exists())

    def test_env_default_state_keeps_env_global_target_after_explicit_dir_cache_hit(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            env_global_dir = Path(temp_dir) / "env-global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(env_global_dir)
            try:
                cached_from_env = get_harness_state()
                # An explicit state_dir that aliases the env local dir must not
                # redirect the env-default singleton's global target.
                cached_from_explicit = get_harness_state(local_dir)
                global_entry = cached_from_env.create_memory(
                    "Env global",
                    "still targets the env global dir",
                    id="env_global_after_hit",
                    global_=True,
                )
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertIs(cached_from_env, cached_from_explicit)
            self.assertEqual(global_entry.scope, "global")
            self.assertIsNotNone(
                HarnessState(env_global_dir / "harness_state.json", scope="global").get(
                    "memory", "env_global_after_hit"
                )
            )
            self.assertIsNone(
                HarnessState(local_dir / "harness_state.json").get("memory", "env_global_after_hit")
            )

    def test_local_state_requires_local_path(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        try:
            os.environ.pop("RLM_HARNESS_STATE_DIR", None)
            os.environ.pop("RLM_SESSION_DIR", None)
            with self.assertRaisesRegex(RuntimeError, "Local harness state requires"):
                HarnessState()
        finally:
            if previous_local is None:
                os.environ.pop("RLM_HARNESS_STATE_DIR", None)
            else:
                os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
            if previous_session is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous_session

    def test_default_state_uses_global_harness_env_dir(self) -> None:
        previous = os.environ.get("RLM_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
            try:
                state = HarnessState()
            finally:
                if previous is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous

            self.assertEqual(state.file_path, Path(temp_dir).resolve() / "harness_state.json")

    def test_global_scope_default_state_uses_global_harness_env_dir(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = HarnessState(scope="global")
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(state.scope, "global")
            self.assertEqual(state.file_path, global_dir.resolve() / "harness_state.json")

    def test_default_state_is_local_and_global_flag_targets_global_store(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = get_harness_state()
                global_state = get_harness_state(global_=True)
                local_entry = state.create_memory("Local note", "Only this session.", id="local_note")
                global_entry = state.create_memory("Global note", "All sessions.", id="global_note", global_=True)
                kwargs_entry = state.create_memory(
                    "Kwargs global note",
                    "All sessions via kwargs.",
                    id="kwargs_global_note",
                    **{"global": True},
                )
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(state.file_path, local_dir.resolve() / "harness_state.json")
            self.assertEqual(global_state.file_path, global_dir.resolve() / "harness_state.json")
            self.assertEqual(local_entry.scope, "local")
            self.assertEqual(global_entry.scope, "global")
            self.assertEqual(kwargs_entry.scope, "global")
            self.assertIsNotNone(HarnessState(local_dir / "harness_state.json").get("memory", "local_note"))
            self.assertIsNone(HarnessState(local_dir / "harness_state.json").get("memory", "global_note"))
            self.assertIsNotNone(HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "global_note"))
            self.assertIsNotNone(
                HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "kwargs_global_note")
            )

    def test_global_kwarg_must_be_boolean(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            with self.assertRaisesRegex(TypeError, "global must be a bool"):
                state.create_memory("Bad global flag", "bad", id="bad_global", **{"global": "false"})

    def test_state_cache_keeps_scope_distinct_when_local_and_global_share_a_file(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = temp_dir
            try:
                state = get_harness_state()
                global_state = get_harness_state(global_=True)
                local_entry = state.create_memory("Local note", "Only this session.", id="local_note")
                global_entry = state.create_memory("Global note", "All sessions.", id="global_note", global_=True)
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertIsNot(state, global_state)
            self.assertEqual(state.file_path, global_state.file_path)
            self.assertEqual(state.scope, "local")
            self.assertEqual(global_state.scope, "global")
            self.assertEqual(local_entry.scope, "local")
            self.assertEqual(global_entry.scope, "global")
            reloaded = HarnessState(Path(temp_dir) / "harness_state.json")
            self.assertEqual(reloaded.get("memory", "local_note").scope, "local")
            self.assertEqual(reloaded.get("memory", "global_note").scope, "global")

    def test_scope_prefixed_ids_route_to_the_displayed_scope(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = get_harness_state()
                state.create_memory("Global note", "v1", id="routed", global_=True)

                # The overview displays [global:routed]; that id must be usable
                # as-is on reads, but a write that names the global store from
                # the local state needs the explicit flag (M5/MV-1b parity).
                self.assertEqual(state.get("memory", "global:routed").content, "v1")
                with self.assertRaisesRegex(ValueError, "global_=True"):
                    state.update_memory("global:routed", "Global note", "sneaky")
                updated = state.update_memory("global:routed", "Global note", "v2", global_=True)
                self.assertEqual(updated.scope, "global")
                self.assertEqual(state.get("memory", "global:routed").content, "v2")
                self.assertIsNone(state.get("memory", "routed"))

                state.create_memory("Local note", "local", id="local_note")
                self.assertEqual(state.get("memory", "local:local_note").content, "local")
                self.assertTrue(state.delete_memory("local:local_note"))
                self.assertIsNone(state.get("memory", "local_note"))
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(
                HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "routed").content,
                "v2",
            )

    def test_create_with_prefixed_id_does_not_mint_literal_id(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = get_harness_state()
                # X-9: a create whose id names the global store from the local
                # state is refused with the way out, exactly like update/delete -
                # the prefix no longer silently routes the write.
                with self.assertRaisesRegex(ValueError, "global_=True"):
                    state.create_memory("Validation", "content", id="global:validation")
                entry = state.create_memory("Validation", "content", id="global:validation", global_=True)
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(entry.id, "validation")
            self.assertEqual(entry.scope, "global")
            global_store = HarnessState(global_dir / "harness_state.json", scope="global")
            self.assertIsNotNone(global_store.get("memory", "validation"))
            self.assertIsNone(global_store.get("memory", "global:validation"))
            self.assertFalse((local_dir / "harness_state.json").exists())

    def test_module_harness_binds_lazily_to_env_set_after_import(self) -> None:
        # Forkserver scenario: rlm is imported in the template process without the
        # per-session env; the child applies env after fork. rlm.harness must then
        # resolve against the new env instead of a store frozen at import time.
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            try:
                os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                os.environ.pop("RLM_SESSION_DIR", None)
                # Without local env, local writes fail loudly instead of vanishing.
                with self.assertRaisesRegex(RuntimeError, "global_=True"):
                    package_harness.create_memory("Volatile", "pre-env", id="pre_env")

                os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
                entry = package_harness.create_memory("Session note", "persisted", id="session_note")
                self.assertIsNone(package_harness.get("memory", "pre_env"))
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_session is None:
                    os.environ.pop("RLM_SESSION_DIR", None)
                else:
                    os.environ["RLM_SESSION_DIR"] = previous_session

            self.assertEqual(entry.scope, "local")
            reloaded = HarnessState(Path(temp_dir) / "harness_state.json")
            self.assertEqual(reloaded.get("memory", "session_note").content, "persisted")

    def test_module_harness_without_env_raises_on_local_writes_and_reads_work(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        try:
            os.environ.pop("RLM_HARNESS_STATE_DIR", None)
            os.environ.pop("RLM_SESSION_DIR", None)

            for mutate in (
                lambda: package_harness.create_memory("Lost", "content", id="lost"),
                lambda: package_harness.update_memory("lost", "Lost", "content"),
                lambda: package_harness.delete_memory("lost"),
                lambda: package_harness.upsert("memory", "Lost", "content", id="lost"),
                lambda: package_harness.record_refinement("trigger", ["change"]),
            ):
                with self.assertRaisesRegex(RuntimeError, "Local harness state requires.*global_=True"):
                    mutate()

            # Reads keep working against an empty view.
            self.assertIsNone(package_harness.get("memory", "lost"))
            self.assertEqual(package_harness.list(), [])
            self.assertIn("memory: 0", package_harness.overview())
            self.assertEqual(package_harness.snapshot()["refinements"], [])
        finally:
            if previous_local is None:
                os.environ.pop("RLM_HARNESS_STATE_DIR", None)
            else:
                os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
            if previous_session is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous_session

    def test_module_harness_without_env_still_routes_global_writes(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            global_dir = Path(temp_dir) / "global"
            try:
                os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                os.environ.pop("RLM_SESSION_DIR", None)
                os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
                entry = package_harness.create_memory("Lesson", "keep me", id="no_session_lesson", global_=True)
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_session is None:
                    os.environ.pop("RLM_SESSION_DIR", None)
                else:
                    os.environ["RLM_SESSION_DIR"] = previous_session
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(entry.scope, "global")
            self.assertEqual(
                HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "no_session_lesson").content,
                "keep me",
            )

    def test_import_rlm_without_env_does_not_raise(self) -> None:
        env = dict(os.environ)
        env.pop("RLM_HARNESS_STATE_DIR", None)
        env.pop("RLM_SESSION_DIR", None)
        env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
        result = subprocess.run(
            [sys.executable, "-c", "import rlm; repr(rlm.harness); rlm.harness.overview(); rlm.harness.create_memory"],
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_empty_local_state_dir_env_is_treated_as_unset(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            try:
                # Empty local dir must not fall through to the global agent-dir default.
                os.environ["RLM_HARNESS_STATE_DIR"] = ""
                os.environ.pop("RLM_SESSION_DIR", None)
                with self.assertRaisesRegex(RuntimeError, "Local harness state requires"):
                    HarnessState()

                # With a session dir it takes the session fallback instead.
                os.environ["RLM_SESSION_DIR"] = temp_dir
                state = HarnessState()
                self.assertEqual(state.file_path, Path(temp_dir).resolve() / "harness" / "harness_state.json")

                # A whitespace-only session dir is also unset.
                os.environ["RLM_SESSION_DIR"] = "   "
                with self.assertRaisesRegex(RuntimeError, "Local harness state requires"):
                    HarnessState()
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_session is None:
                    os.environ.pop("RLM_SESSION_DIR", None)
                else:
                    os.environ["RLM_SESSION_DIR"] = previous_session

    def test_explicit_dir_aliasing_env_local_dir_keeps_env_global_target(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            env_global_dir = Path(temp_dir) / "env-global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(env_global_dir)
            try:
                # First construction happens via an explicit dir that merely aliases
                # the env local dir; global writes must still hit the env global dir.
                state = get_harness_state(local_dir)
                global_entry = state.create_memory("Aliased", "still global", id="alias_global", global_=True)
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(global_entry.scope, "global")
            self.assertIsNotNone(
                HarnessState(env_global_dir / "harness_state.json", scope="global").get("memory", "alias_global")
            )
            self.assertIsNone(
                HarnessState(local_dir / "harness_state.json").get("memory", "alias_global")
            )

    def test_callable_rlm_exposes_harness_state_helpers(self) -> None:
        self.assertIs(callable_rlm.harness, package_harness)
        self.assertIs(callable_rlm.get_harness_state, get_harness_state)

    def test_record_refinement_accepts_single_change_string(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            event = state.record_refinement("manual cli test", "single change")

            self.assertEqual(event.changes, ["single change"])
            self.assertEqual(state.refinements[0].changes, ["single change"])

    def test_unknown_kind_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.upsert("tool", "Tool", "Tool content")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.get("tool", "tool")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.delete("tool", "tool")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.list("tool")



class ScopePrefixEdgeCases(unittest.TestCase):
    """MV-1/MV-2/MV-3: the model-visible copy of the harness contract."""

    def _scoped_env(self, temp_dir: str) -> tuple[HarnessState, HarnessState]:
        local_dir = Path(temp_dir) / "local"
        global_dir = Path(temp_dir) / "global"
        os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
        os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
        return HarnessState(local_dir / "harness_state.json"), HarnessState(global_dir / "harness_state.json", scope="global")

    def test_bracketed_ids_are_accepted_verbatim_for_reads_and_matching_writes(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_state, global_state = self._scoped_env(temp_dir)
            try:
                global_state.create_memory("Global note", "v1", id="shared")
                local_state.create_memory("Local note", "v1", id="note")

                # The overview renders [global:shared]; a verbatim copy (closing
                # bracket included, or clipped off) must resolve, not "does not
                # exist".
                self.assertEqual(global_state.get("memory", "[global:shared]").content, "v1")
                self.assertEqual(global_state.get("memory", "[global:shared").content, "v1")
                self.assertEqual(global_state.get("memory", "global:shared]").content, "v1")
                # Reads keep routing to the displayed scope.
                self.assertEqual(local_state.get("memory", "[global:shared]").content, "v1")
                # A write addressed to the entry's own store works verbatim.
                updated = global_state.update_memory("[global:shared]", "Global note", "v2")
                self.assertEqual(updated.id, "shared")
                self.assertEqual(global_state.get("memory", "shared").content, "v2")
                self.assertTrue(global_state.delete_memory("[global:shared]"))
            finally:
                for name, previous in (
                    ("RLM_HARNESS_STATE_DIR", previous_local),
                    ("RLM_GLOBAL_HARNESS_STATE_DIR", previous_global),
                ):
                    if previous is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = previous

    def test_cross_store_prefix_on_update_delete_is_refused_not_routed(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_state, global_state = self._scoped_env(temp_dir)
            try:
                global_state.create_memory("Global note", "v1", id="shared")

                # An update/delete whose id names the other store must refuse
                # with the way out (M5 semantics, TS parity) instead of
                # silently writing through to the global store.
                with self.assertRaisesRegex(ValueError, "global_=True"):
                    local_state.update_memory("global:shared", "Global note", "sneaky")
                with self.assertRaisesRegex(ValueError, "global_=True"):
                    local_state.update_memory("[global:shared]", "Global note", "sneaky")
                with self.assertRaisesRegex(ValueError, "global_=True"):
                    local_state.delete_memory("global:shared")
                self.assertEqual(global_state.get("memory", "shared").content, "v1")
                self.assertFalse((local_state.file_path).exists() if local_state.file_path else False)

                # The explicit flag is the way out.
                updated = local_state.update_memory("global:shared", "Global note", "v2", global_=True)
                self.assertEqual(updated.scope, "global")
                self.assertEqual(global_state.get("memory", "shared").content, "v2")

                # The mirror image: a local-prefixed id on the global store.
                local_state.create_memory("Local note", "v1", id="note")
                with self.assertRaisesRegex(ValueError, "local"):
                    global_state.update_memory("local:note", "Local note", "sneaky")
                self.assertEqual(local_state.get("memory", "note").content, "v1")
            finally:
                for name, previous in (
                    ("RLM_HARNESS_STATE_DIR", previous_local),
                    ("RLM_GLOBAL_HARNESS_STATE_DIR", previous_global),
                ):
                    if previous is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = previous

    def test_create_with_bracketed_id_strips_prefix_and_brackets(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_state, global_state = self._scoped_env(temp_dir)
            try:
                # X-9: same refusal for the bracketed form; the explicit flag is
                # the way out and still strips prefix and brackets.
                with self.assertRaisesRegex(ValueError, "global_=True"):
                    local_state.create_memory("Lesson", "content", id="[global:lesson]")
                entry = local_state.create_memory("Lesson", "content", id="[global:lesson]", global_=True)
                self.assertEqual(entry.id, "lesson")
                self.assertEqual(entry.scope, "global")
                self.assertIsNotNone(global_state.get("memory", "lesson"))
                self.assertNotIn("[global:lesson]", global_state.entries["memory"])
            finally:
                for name, previous in (
                    ("RLM_HARNESS_STATE_DIR", previous_local),
                    ("RLM_GLOBAL_HARNESS_STATE_DIR", previous_global),
                ):
                    if previous is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = previous

    def test_overview_call_contract_does_not_promise_a_shell_cli(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            overview = state.overview()
        self.assertNotIn("shell CLI", overview)
        self.assertNotIn("or a matching shell", overview)
        # The r12 correction, mirrored: a skill name is a kernel module name.
        self.assertIn("not a shell command", overview)

    def test_harness_state_repr_is_readable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json", scope="local")
            state.create_memory("Lesson", "keep me", id="lesson")
            text = repr(state)
        self.assertIn("local", text)
        self.assertIn("harness_state.json", text)
        self.assertIn("memory=1", text)
        self.assertNotIn("object at 0x", text)

    def test_overview_max_entries_per_kind_lists_the_overflow(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            for index in range(25):
                state.create_memory(f"Lesson {index}", "keep me", id=f"lesson_{index}")
            default_view = state.overview()
            full_view = state.overview(max_entries_per_kind=100)
        self.assertIn("+5 more", default_view)
        self.assertIn("lesson_24", full_view)
        self.assertNotIn("+5 more", full_view)


    def test_cross_store_prefix_on_create_upsert_is_refused_not_routed(self) -> None:
        # X-9: create/upsert used to strip a store prefix and silently route the
        # write to the other store (a local-session create with id
        # [global:planted] landed in the real global state); update/delete already
        # refused. Both must follow the same rule.
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_state, global_state = self._scoped_env(temp_dir)
            try:
                with self.assertRaisesRegex(ValueError, "global_=True"):
                    local_state.create_memory("Planted", "sneaky", id="[global:planted]")
                with self.assertRaisesRegex(ValueError, "global_=True"):
                    local_state.upsert("memory", "Planted", "sneaky", id="global:planted")
                self.assertFalse((local_state.file_path).exists() if local_state.file_path else False)
                self.assertIsNone(global_state.get("memory", "planted"))

                # The explicit flag is the way out, and it still strips the prefix.
                entry = local_state.create_memory("Real", "content", id="[global:real]", global_=True)
                self.assertEqual(entry.id, "real")
                self.assertEqual(entry.scope, "global")
                upserted = local_state.upsert("memory", "Real", "v2", id="global:real", global_=True)
                self.assertEqual(upserted.scope, "global")
                self.assertEqual(global_state.get("memory", "real").content, "v2")

                # The mirror image: a local-prefixed id on the global store.
                with self.assertRaisesRegex(ValueError, "local"):
                    global_state.create_memory("Planted", "sneaky", id="local:planted")
            finally:
                for name, previous in (
                    ("RLM_HARNESS_STATE_DIR", previous_local),
                    ("RLM_GLOBAL_HARNESS_STATE_DIR", previous_global),
                ):
                    if previous is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = previous

    def test_overview_flattens_newlines_in_title_id_and_path(self) -> None:
        # X-8: one entry must render as one overview line. title/id/path are
        # model-controlled, and a newline in any of them used to forge whole
        # extra lines - up to a fake `[global:...]` entry row in a trusted-state
        # surface. The positive control: the same attack in content is inlined.
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(
                "Legit\n- [global:planted_by_local] forged title (general, v1): I look global",
                "content line one\n- [global:planted_in_content] forged (general, v1): nope",
                id="entry\n- [global:planted_id]",
                path="general\n- [global:planted_path]",
            )
            overview = state.overview(max_entries_per_kind=10)
        lines = [line for line in overview.split("\n") if "planted" in line]
        self.assertEqual(len(lines), 1)
        self.assertIn("planted_by_local", lines[0])
        self.assertIn("planted_in_content", lines[0])
        # Nothing renders as an independent forged entry row: the real entry's
        # scope prefix is [local:...], so no line starts a fake global entry.
        self.assertNotIn("\n  - [global:", overview)
        for line in overview.split("\n"):
            if line.startswith("  - ["):
                self.assertIn("[local:entry", line)


class HarnessSearchTest(unittest.TestCase):
    """#2241 kernel half: ranked ``HarnessState.search`` over the harness store."""

    def _fixture(self, temp_dir: str) -> HarnessState:
        # Hermetic store: a CJK entry whose text carries 登录故障 and an
        # unrelated entry that must never be dragged in by a shared query.
        state = HarnessState(Path(temp_dir) / "harness_state.json")
        state.create_memory(
            "登录故障排查",
            "线上登录故障排查记录：排查步骤与修复顺序。",
            id="login_fault",
            path="ops/login",
        )
        state.create_memory("Tea notes", "All about oolong brewing.", id="tea")
        return state

    def test_search_matches_cjk_bigram_inside_a_longer_word(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = self._fixture(temp_dir)

            # Positive control: the target entry exists and really contains the
            # term the 登录 bigram has to reach.
            target = state.get("memory", "login_fault")
            self.assertIsNotNone(target)
            self.assertIn("登录故障", target.title + target.content)

            hits = state.search("修复登录")

            self.assertEqual([hit.id for hit in hits], ["login_fault"])
            self.assertNotIn("tea", [hit.id for hit in hits])
            self.assertTrue(all(hit.score > 0 for hit in hits))
            # The same ruler does hit the unrelated entry on its own terms, so
            # its absence above is discrimination rather than an empty result set.
            self.assertEqual([hit.id for hit in state.search("oolong")], ["tea"])

    def test_search_treats_punctuation_as_separators(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Worktree policy", "Use git worktrees for parallel branches.", id="worktree")
            state.create_memory("Open question", "Anything else left open?", id="question")

            control = state.search("worktree")
            # Positive control: the term matches, so the comparisons below
            # compare real hit sets and not two empty lists.
            self.assertEqual([hit.id for hit in control], ["worktree"])

            # Punctuation is a separator: it neither becomes a term of its own
            # (which would match the question entry) nor perturbs scoring, so
            # the hits are identical, snippet and order included.
            self.assertEqual(state.search("worktree?"), control)
            self.assertEqual(state.search("???worktree???"), control)

            self.assertEqual(state.search("??? / . ,"), [])
            self.assertEqual(state.search("..."), [])

    def test_search_returns_empty_for_empty_or_punctuation_only_queries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Worktree policy", "Use git worktrees for parallel branches.", id="worktree")

            # Positive control: the same state is searchable.
            self.assertEqual([hit.id for hit in state.search("worktree")], ["worktree"])

            for query in ("", "   ", "?!。", "???/..."):
                self.assertEqual(state.search(query), [], msg=repr(query))

    def test_search_limit_and_argument_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Worktree memory", "worktree workflow notes", id="m1")
            state.create_prompt_note("Worktree prompt", "worktree workflow notes", id="p1")
            state.create_prompt_note("Worktree prompt two", "worktree workflow notes", id="p2")

            everything = state.search("worktree", limit=10)
            # Positive control: three entries carry the term, so the shorter
            # list below is limit talking, not a missing ruler.
            self.assertEqual(sorted(hit.id for hit in everything), ["m1", "p1", "p2"])
            scores = [hit.score for hit in everything]
            self.assertEqual(scores, sorted(scores, reverse=True))

            self.assertEqual(state.search("worktree", limit=1), everything[:1])
            self.assertEqual([hit.kind for hit in state.search("worktree", kind="prompt")], ["prompt", "prompt"])
            self.assertEqual([hit.kind for hit in state.search("worktree", kind="memory")], ["memory"])

            for bad_limit in (0, -1):
                with self.assertRaises(ValueError):
                    state.search("worktree", limit=bad_limit)
            for bad_limit in (True, 1.5, "3"):
                with self.assertRaises(TypeError):
                    state.search("worktree", limit=bad_limit)
            with self.assertRaises(TypeError):
                state.search(42)
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.search("worktree", kind="tool")
            # An unknown kind is an argument error, reported even when the query
            # itself would match nothing.
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.search("", kind="tool")

    def test_search_discounts_common_terms_and_keeps_frequency_ties(self) -> None:
        """#2392 kernel half: tf-idf discounts ubiquitous terms in ``search``."""
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            # An empty corpus scores nothing, and a lone entry (N=1, df=1 -> log(2)) still scores.
            self.assertEqual(state.search("session"), [])
            state.create_memory("Session notes", "Session signal.", id="solo")
            solo_hits = state.search("session")
            # Positive control: the lone match really scores above zero, so the
            # orderings below compare real ranks, not empty lists.
            self.assertEqual([hit.id for hit in solo_hits], ["solo"])
            self.assertGreater(solo_hits[0].score, 0)
            state.entries["memory"]["solo"].updated_at = "2026-07-01T00:00:00+00:00"

            # Equal frequency discounts every match alike, so recency still orders them: id order
            # alone would put aa_older first.
            for entry_id, day in (("aa_older", "08-01"), ("zz_newer", "09-01")):
                state.create_memory("Session notes", "Same session signal.", id=entry_id)
                state.entries["memory"][entry_id].updated_at = f"2026-{day}T00:00:00+00:00"
            self.assertEqual([hit.id for hit in state.search("session")], ["zz_newer", "aa_older", "solo"])

            # "session" matches 3 of 4 (log(1 + 4/3)), "quantum" 1 of 4 (log(1 + 4)): the rare
            # distinctive term outranks the common-term-dense entries despite being oldest.
            state.create_memory("Quantum note", "Only quantum annealing matters once.", id="rare")
            state.entries["memory"]["rare"].updated_at = "2026-07-01T00:00:00+00:00"
            hits = state.search("session quantum")
            self.assertEqual([hit.id for hit in hits], ["rare", "zz_newer", "aa_older", "solo"])

    def test_search_returns_empty_when_nothing_matches(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = self._fixture(temp_dir)

            # Positive control: the store and the ruler both work.
            self.assertTrue(state.search("登录故障"))

            self.assertEqual(state.search("quantum"), [])
            self.assertEqual(state.search("量子力学"), [])

    def test_search_is_case_insensitive(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Kernel note", "rlm keeps the kernel warm.", id="lower")
            state.create_memory("Upper note", "RLM keeps the kernel warm.", id="upper")

            hits = state.search("RLM")
            hits_by_id = {hit.id: hit for hit in hits}

            # Positive control: both entries exist and both are found by the
            # upper-case query.
            self.assertEqual(sorted(hits_by_id), ["lower", "upper"])
            self.assertEqual(state.search("RLM"), state.search("rlm"))
            # Matching is case-folded, the snippet keeps the stored casing.
            self.assertIn("rlm", hits_by_id["lower"].snippet)
            self.assertIn("RLM", hits_by_id["upper"].snippet)

    def test_search_hit_shape_snippet_and_score_weights(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(
                "Zorblat title",
                "First line.\nSecond line mentions zorblat after a newline.\nThird line.",
                id="zorblat_id",
            )
            state.create_memory("Other note", "Body mentions zorblat once.", id="other_entry")
            state.create_memory(
                "Long note",
                ("filler\n" * 40) + "needle\n" + ("filler\n" * 40),
                id="long",
            )

            hits = state.search("zorblat")

            # Both access shapes are part of the contract.
            kind, entry_id, score, snippet = hits[0]
            self.assertEqual((kind, entry_id), ("memory", "zorblat_id"))
            self.assertEqual(hits[0].snippet, snippet)
            # title + content + path/id is three slots: 1 + 2 * 0.5, discounted
            # by the term's document frequency (df=2 of N=3): log(1 + 3/2).
            idf = math.log(1 + 3 / 2)
            self.assertEqual(score, idf * 2.0)
            self.assertEqual(
                [(hit.id, hit.score) for hit in hits],
                [("zorblat_id", idf * 2.0), ("other_entry", idf * 1.0)],
            )
            # X-8: model-controlled content must not forge extra lines.
            self.assertNotIn("\n", snippet)
            self.assertIn("Zorblat title", snippet)
            self.assertIn("zorblat after a newline", snippet)

            long_snippet = state.search("needle")[0].snippet
            self.assertIn("needle", long_snippet)
            self.assertIn("...", long_snippet)
            self.assertNotIn("\n", long_snippet)
            self.assertLess(len(long_snippet), 200)
            # The window is centred on the first hit, not the head of the text.
            self.assertLess(abs(long_snippet.index("needle") - len(long_snippet) // 2), 60)

    def test_search_orders_by_score_then_recency_then_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Alpha tie", "shared tiebreak keyword", id="alpha")
            state.create_memory("Beta tie", "shared tiebreak keyword", id="beta")

            # Positive control: both entries match with the same score. Both
            # terms are in every entry (df=N=2 -> log(2)), so the discount is
            # uniform and the recency/identity tie-breaks below stay reachable.
            uniform = 2 * math.log(2)
            self.assertEqual(
                {hit.id: hit.score for hit in state.search("tiebreak keyword")},
                {"alpha": uniform, "beta": uniform},
            )

            state.entries["memory"]["alpha"].updated_at = "2020-01-01T00:00:00+00:00"
            state.entries["memory"]["beta"].updated_at = "2021-01-01T00:00:00+00:00"
            self.assertEqual(
                [hit.id for hit in state.search("tiebreak keyword")],
                ["beta", "alpha"],
            )

            # Identical score and timestamp: (kind, id) keeps the order stable.
            state.entries["memory"]["alpha"].updated_at = "2021-01-01T00:00:00+00:00"
            self.assertEqual([hit.id for hit in state.search("tiebreak keyword")], ["alpha", "beta"])
            self.assertEqual(state.search("tiebreak keyword"), state.search("tiebreak keyword"))

    def test_search_routes_to_the_global_store(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                local_state = HarnessState(local_dir / "harness_state.json")
                global_state = HarnessState(global_dir / "harness_state.json", scope="global")
                local_state.create_memory("Local note", "worktree local note", id="local_only")
                global_state.create_memory("Global note", "worktree global note", id="global_only")

                # Positive control: each store's own view finds its own entry.
                self.assertEqual([hit.id for hit in local_state.search("worktree")], ["local_only"])
                self.assertEqual([hit.id for hit in global_state.search("worktree")], ["global_only"])
                self.assertEqual([hit.id for hit in local_state.search("worktree", global_=True)], ["global_only"])
            finally:
                for name, previous in (
                    ("RLM_HARNESS_STATE_DIR", previous_local),
                    ("RLM_GLOBAL_HARNESS_STATE_DIR", previous_global),
                ):
                    if previous is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = previous

    def test_search_keeps_upstream_tokenizer_floors_and_cjk_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Russian note", "мир и согласие в команде.", id="mir")
            state.create_memory("Book note", "किताब पढ़ रहा हूँ।", id="book")
            state.create_memory("Review notes", "The naïve approach failed.", id="naive")
            state.create_memory("Mixed note", "修复login 混排记录。", id="mixed")
            state.create_memory("Ext B note", "𠀀𠀁 ideographs recorded.", id="extb")
            state.create_memory("Short word note", "an ab then abc marker", id="short")

            # Positive controls: each fixture carries a term the same ruler
            # finds, so the empty results below are a floor talking.
            self.assertEqual([hit.id for hit in state.search("мир")], ["mir"])
            self.assertEqual([hit.id for hit in state.search("किताब")], ["book"])
            self.assertEqual([hit.id for hit in state.search("naïve")], ["naive"])
            self.assertEqual([hit.id for hit in state.search("𠀀")], ["extb"])
            self.assertEqual([hit.id for hit in state.search("𠀀𠀁")], ["extb"])
            self.assertEqual([hit.id for hit in state.search("abc")], ["short"])

            # Runs break only at CJK boundaries, so a mixed query keeps both of
            # its words instead of shattering into dropped fragments.
            self.assertEqual([hit.id for hit in state.search("修复login")], ["mixed"])

            # Non-CJK runs need two characters, ASCII runs need three.
            self.assertEqual(state.search("и"), [])
            self.assertEqual(state.search("ab"), [])


if __name__ == "__main__":
    unittest.main()
