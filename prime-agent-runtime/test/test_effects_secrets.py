"""Secret withholding in change tracking (rlm.effects): shapes the scan must catch, what it must leave alone.

Fake credentials are assembled from pieces so no complete one sits in this file.
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import test_effects as te  # noqa: E402

from rlm import effects  # noqa: E402

# The live bailian key looks like `sk-ws-H.<random>`: the dot is part of the key.
_DOT_KEY = "sk-" + "ws-H." + "PIPELINEDOTKEY" + "x" * 16 + "1234"
_PLAIN_KEY = "sk-" + "ant-FAKE" + "0" * 20
_OLD_KEY = "sk-" + "OLDFAKE" + "0" * 24
_NEW_KEY = "sk-" + "NEWFAKE" + "0" * 24

_DIFF_MIME = "application/vnd.prime-agent.diff+json"
_SKILL_SRC = os.path.join(os.path.dirname(__file__), "..", "..", "packages", "coding-agent", "skills", "edit", "src")


def _anywhere(cell: te.Cell, *needles: str) -> list[str]:
    """Which needles appear anywhere in a cell's protocol events (records, outputs, everything)."""
    text = json.dumps(cell.events)
    return [needle for needle in needles if needle in text]


class DottedKeyShapeTests(unittest.TestCase):
    """FIX-1: a key whose body holds a dot (`sk-ws-H.<random>`) is a key all the same."""

    def test_every_spelling_of_a_dotted_key_is_withheld(self):
        spellings = [
            f'the_key = "{_DOT_KEY}"',
            f'key: "{_DOT_KEY}"',
            '{"key": "%s"}' % _DOT_KEY,
            f"x-api-key: {_DOT_KEY}",
            f'KEY = "{_DOT_KEY}"',
            f"export TOKEN={_DOT_KEY}",
        ]
        self.assertGreater(len(spellings), 0)
        for text in spellings:
            with self.subTest(text=text):
                self.assertTrue(effects._looks_secret(text))

    def test_undotted_keys_and_ordinary_constants_are_judged_as_before(self):
        withheld = [f"key = {_PLAIN_KEY}", f"Authorization: Bearer {_DOT_KEY}"]
        ordinary = [
            'BLOB = "SGVsbG8gd29ybGQgMTIzNDU2Nzg5MDEy"',
            'HASH = "a1b2c3d4e5f6a1b2c3d4e5f6"',
            "max_tokens = 4096",
            "task-abcdefghijklmnopqrstuvwxyz",
        ]
        self.assertGreater(len(withheld) + len(ordinary), 0)
        for text in withheld:
            with self.subTest(text=text):
                self.assertTrue(effects._looks_secret(text))
        for text in ordinary:
            with self.subTest(text=text):
                self.assertFalse(effects._looks_secret(text))


@unittest.skipUnless(te.HAS_GIT, "git is needed for the work-tree comparison")
class DottedKeyPipelineTests(te.TrackerCase):
    def test_a_dotted_key_written_to_an_ordinary_file_keeps_its_counts_but_no_diff(self):
        cell = self.kernel.run(f"open('plain_key.txt', 'w').write('the_key = \"{_DOT_KEY}\"\\n')")
        record = cell.by_rel()["plain_key.txt"]
        self.assertEqual((record["kind"], record["source"], record["added"]), ("created", "python", 1))
        self.assertEqual(record["diffOmitted"], effects.SENSITIVE)
        self.assertNotIn("diff", record)
        self.assertEqual(_anywhere(cell, _DOT_KEY), [])


def _diff_events(cell: te.Cell) -> list[dict]:
    """Every display event of a cell that carries an edit-skill diff payload, whole."""
    return [e["data"] for e in cell.events if e.get("event") == "display" and _DIFF_MIME in e.get("data", {})]


@unittest.skipUnless(te.HAS_GIT, "git is needed for the work-tree comparison")
class EditSkillPayloadTests(te.TrackerCase):
    """FIX-2: the edit skill's diff payload is saved with the session, so it obeys the same withholding
    as the file-change record of the very same write: a credential file or a secret-looking text sends
    only its path, and the model's own result (`Edited <path>`) is untouched."""

    def setUp(self) -> None:
        super().setUp()
        self.kernel.run(f"import sys\nsys.path.insert(0, {os.path.abspath(_SKILL_SRC)!r})\nimport edit")

    def _edit(self, rel: str, old: str, new: str) -> te.Cell:
        return self.kernel.run(f"await edit.run({rel!r}, {old!r}, {new!r})")

    def _model_sees(self, cell: te.Cell, rel: str) -> None:
        result = next(e for e in cell.events if e.get("event") == "result")
        self.assertEqual(result["text"], repr(f"Edited {self.path(rel)}"))

    def test_an_edit_to_an_env_file_sends_its_path_and_no_text(self):
        self.write(".env", f"API_KEY=OLD-{_OLD_KEY}\nDEBUG=1\n")
        cell = self._edit(".env", f"API_KEY=OLD-{_OLD_KEY}", f"API_KEY=NEW-{_NEW_KEY}")
        self.assertEqual(cell.status, "ok")
        events = _diff_events(cell)
        self.assertEqual([e[_DIFF_MIME] for e in events], [{"path": self.path(".env"), "omitted": effects.SENSITIVE}])
        self.assertEqual(_anywhere(cell, _OLD_KEY, _NEW_KEY), [])
        record = cell.by_rel()[".env"]
        self.assertEqual((record["source"], record["diffOmitted"]), ("edit", effects.SENSITIVE))
        self._model_sees(cell, ".env")

    def test_a_harmless_line_in_an_env_file_is_withheld_like_the_file_record_is(self):
        self.write(".env", "DEBUG=1\n")
        cell = self._edit(".env", "DEBUG=1", "DEBUG=0")
        self.assertEqual([e[_DIFF_MIME] for e in _diff_events(cell)], [{"path": self.path(".env"), "omitted": effects.SENSITIVE}])
        self.assertEqual(cell.by_rel()[".env"]["diffOmitted"], effects.SENSITIVE)
        self._model_sees(cell, ".env")

    def test_a_secret_in_an_ordinary_file_withholds_the_payload_text_only(self):
        self.write("settings.py", f'API_KEY = "{_OLD_KEY}"\nDEBUG = True\n')
        cell = self._edit("settings.py", f'API_KEY = "{_OLD_KEY}"', f'API_KEY = "{_NEW_KEY}"')
        self.assertEqual([e[_DIFF_MIME] for e in _diff_events(cell)], [{"path": self.path("settings.py"), "omitted": effects.SENSITIVE}])
        self.assertEqual(_anywhere(cell, _OLD_KEY, _NEW_KEY), [])
        self.assertEqual(cell.by_rel()["settings.py"]["diffOmitted"], effects.SENSITIVE)
        self._model_sees(cell, "settings.py")

    def test_an_ordinary_edit_sends_the_payload_it_always_sent(self):
        self.write("notes.txt", "alpha\nbeta\ngamma\n")
        cell = self._edit("notes.txt", "beta", "BETA")
        events = _diff_events(cell)
        self.assertEqual(len(events), 1)
        expected = {
            _DIFF_MIME: {"path": self.path("notes.txt"), "old_str": "beta", "new_str": "BETA", "start_line": 2},
            "text/plain": f"Edited {self.path('notes.txt')}",
        }
        self.assertEqual(events[0], expected)
        # Byte for byte: same keys, same order.
        self.assertEqual(json.dumps(events[0]), json.dumps(expected))
        self.assertIn("+BETA\n", cell.by_rel()["notes.txt"]["diff"])
        self._model_sees(cell, "notes.txt")

    def test_an_older_runtime_without_the_scan_sends_the_payload_as_before(self):
        self.write(".env", "DEBUG=1\n")
        older = self.kernel.run(
            "import rlm.effects as fx\ndel fx.looks_secret, fx.is_sensitive_path\n"
            "import importlib, edit\nimportlib.reload(edit)"
        )
        self.assertEqual(older.status, "ok")
        cell = self._edit(".env", "DEBUG=1", "DEBUG=0")
        self.assertEqual(cell.status, "ok")
        payload = _diff_events(cell)[0][_DIFF_MIME]
        self.assertEqual((payload["old_str"], payload["new_str"]), ("DEBUG=1", "DEBUG=0"))


class PublicScanTests(unittest.TestCase):
    """The scan a skill may call: the same answers the change records use."""

    def test_looks_secret_and_is_sensitive_path_answer_as_the_record_scan_does(self):
        self.assertTrue(effects.looks_secret(f'API_KEY = "{_OLD_KEY}"'))
        self.assertFalse(effects.looks_secret("max_tokens = 4096"))
        self.assertFalse(effects.looks_secret(None))
        self.assertTrue(effects.is_sensitive_path("/work/app/.env"))
        self.assertTrue(effects.is_sensitive_path("/home/u/.ssh/config"))
        self.assertFalse(effects.is_sensitive_path("/work/app/secret_manager.py"))
        self.assertFalse(effects.is_sensitive_path(None))


if __name__ == "__main__":
    unittest.main()
