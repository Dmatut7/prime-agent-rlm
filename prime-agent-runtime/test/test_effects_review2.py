"""Second-round fixes to secret withholding and change tracking (rlm.effects), from the lu/final-fixes review.

Fake credentials are assembled from pieces so no complete one sits in this file.
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_effects as te  # noqa: E402

from rlm import effects  # noqa: E402

_PASSWORD = "hunter2" + "passw0rd" + "ZQ"


def _anywhere(cell: te.Cell, *needles: str) -> list[str]:
    """Which needles appear anywhere in a cell's protocol events (records, outputs, everything)."""
    text = json.dumps(cell.events)
    return [needle for needle in needles if needle in text]


def _straddling(name: str, value: str) -> str:
    """A long text whose quoted `name = "value"` crosses the memory text cut: the value starts 14 characters before it."""
    opening = f'{name} = "'
    start = effects.MAX_MEMORY_TEXT - 14
    return "x" * (start - len(opening)) + opening + value + '"\n' + "tail\n" * 20


class MemoryScanBeforeCutTests(te.TrackerCase):
    """review2-1: a memory text is scanned before it is cut to the length the record carries.

    A quoted value that crosses the cut loses its closing quote to it, and no value rule matches an
    unterminated quote: the cut text looks clean and the start of the value would ride along.
    """

    use_git = False

    def _run_memory(self, code: str) -> te.Cell:
        cell = self.kernel.run(code)
        self.assertEqual(cell.status, "ok", cell.error())
        return cell

    def test_the_fixture_really_cuts_the_value_open(self):
        text = _straddling("password", _PASSWORD)
        self.assertGreater(len(text), effects.MAX_MEMORY_TEXT + 100)
        cut = text[: effects.MAX_MEMORY_TEXT - 1] + "…"
        self.assertIn(_PASSWORD[:10], cut)
        self.assertNotIn(_PASSWORD, cut)
        self.assertFalse(effects.looks_secret(cut))
        self.assertTrue(effects.looks_secret(text))

    def test_a_new_entry_whose_value_crosses_the_cut_is_withheld(self):
        text = _straddling("password", _PASSWORD)
        cell = self._run_memory(f"_ = rlm.harness.create_memory('Notes', {text!r}, id='notes')")
        record = cell.memory()[("memory", "session", "notes")]
        self.assertEqual(record.get("textOmitted"), effects.SENSITIVE)
        self.assertNotIn("before", record)
        self.assertNotIn("after", record)
        self.assertEqual(_anywhere(cell, _PASSWORD[:10]), [])

    def test_the_previous_text_of_an_entry_is_scanned_before_the_cut_too(self):
        text = _straddling("password", _PASSWORD)
        self._run_memory(f"_ = rlm.harness.create_memory('Notes', {text!r}, id='notes')")
        cell = self._run_memory("_ = rlm.harness.update_memory('notes', 'Notes', 'short and clean')")
        record = cell.memory()[("memory", "session", "notes")]
        self.assertEqual((record["op"], record.get("textOmitted")), ("updated", effects.SENSITIVE))
        self.assertNotIn("before", record)
        self.assertNotIn("after", record)
        self.assertEqual(_anywhere(cell, _PASSWORD[:10]), [])

    def test_a_deleted_entry_is_scanned_before_the_cut_too(self):
        text = _straddling("password", _PASSWORD)
        self._run_memory(f"_ = rlm.harness.create_memory('Notes', {text!r}, id='notes')")
        cell = self._run_memory("_ = rlm.harness.delete_memory('notes')")
        record = cell.memory()[("memory", "session", "notes")]
        self.assertEqual((record["op"], record.get("textOmitted")), ("deleted", effects.SENSITIVE))
        self.assertNotIn("before", record)
        self.assertEqual(_anywhere(cell, _PASSWORD[:10]), [])

    def test_an_entry_withheld_by_its_first_write_stays_withheld_after_a_clean_edit_in_the_same_cell(self):
        text = _straddling("password", _PASSWORD)
        cell = self._run_memory(
            f"_ = rlm.harness.create_memory('Notes', {text!r}, id='notes')\n"
            "_ = rlm.harness.update_memory('notes', 'Notes', 'clean now')\n"
        )
        record = cell.memory()[("memory", "session", "notes")]
        self.assertEqual((record["op"], record.get("textOmitted")), ("created", effects.SENSITIVE))
        self.assertNotIn("before", record)
        self.assertNotIn("after", record)
        self.assertEqual(_anywhere(cell, _PASSWORD[:10], "clean now"), [])

    def test_a_long_clean_entry_keeps_its_cut_text(self):
        text = "y" * (effects.MAX_MEMORY_TEXT + 500)
        cell = self._run_memory(f"_ = rlm.harness.create_memory('Notes', {text!r}, id='notes')")
        record = cell.memory()[("memory", "session", "notes")]
        self.assertNotIn("textOmitted", record)
        self.assertEqual(record["after"], "y" * (effects.MAX_MEMORY_TEXT - 1) + "…")

    def test_a_value_far_past_the_cut_never_shows_and_does_not_withhold(self):
        text = "y" * (effects.MAX_MEMORY_TEXT + 5000) + f' password = "{_PASSWORD}"'
        cell = self._run_memory(f"_ = rlm.harness.create_memory('Notes', {text!r}, id='notes')")
        record = cell.memory()[("memory", "session", "notes")]
        self.assertNotIn("textOmitted", record)
        self.assertEqual(len(record["after"]), effects.MAX_MEMORY_TEXT)
        self.assertEqual(_anywhere(cell, _PASSWORD[:10]), [])

    def test_a_rules_file_whose_shown_start_holds_a_cut_value_is_withheld(self):
        # The edit is on the first line: the diff carries no trace of the value, only the memory texts do.
        filler = "".join(f"line {index:03d} " + "-" * 50 + "\n" for index in range(60))
        head = "# Rules\n" + filler
        opening = 'password = "'
        pad = effects.MAX_MEMORY_TEXT - 14 - len(head) - len(opening)
        self.assertGreater(pad, 1)
        text = head + "z" * (pad - 1) + "\n" + opening + _PASSWORD + '"\n' + filler
        self.assertIn(_PASSWORD[:10], text[: effects.MAX_MEMORY_TEXT])
        self.assertNotIn(_PASSWORD, text[: effects.MAX_MEMORY_TEXT - 1])
        self.write("AGENTS.md", text)
        cell = self._run_memory(
            "p = open('AGENTS.md').read()\nopen('AGENTS.md', 'w').write(p.replace('# Rules', '# Rules v2', 1))"
        )
        change = cell.by_rel()["AGENTS.md"]
        self.assertNotIn(_PASSWORD[:10], change.get("diff", ""))
        memory = [record for key, record in cell.memory().items() if key[0] == "rules_file"]
        self.assertEqual(len(memory), 1)
        self.assertEqual(memory[0].get("textOmitted"), effects.SENSITIVE)
        self.assertNotIn("before", memory[0])
        self.assertNotIn("after", memory[0])
        self.assertEqual(_anywhere(cell, _PASSWORD[:10]), [])


if __name__ == "__main__":
    unittest.main()
