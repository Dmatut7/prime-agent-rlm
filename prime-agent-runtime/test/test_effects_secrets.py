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


if __name__ == "__main__":
    unittest.main()
