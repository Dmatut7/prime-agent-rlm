"""Secret withholding in change tracking (rlm.effects): shapes the scan must catch, what it must leave alone.

Fake credentials are assembled from pieces so no complete one sits in this file.
"""

from __future__ import annotations

import json
import os
import sys
import time
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


def _activity_records(cell: te.Cell, kind: str) -> list[dict]:
    """Every activity record of one kind, in the order the host would apply them (all versions of each step)."""
    return [record for record in cell.payloads(te.ACTIVITY) if record["kind"] == kind]


@unittest.skipUnless(te.HAS_GIT, "git is needed for the work-tree comparison")
class ActivityLabelTests(te.TrackerCase):
    """FIX-6: a step's label is the command line the model typed. The record is saved with the session, so a
    label holding a credential shows the step's kind instead, like a detail that holds one is left out.
    The whole label is scanned before it is cut to the label length."""

    def test_a_command_with_an_inline_key_is_labelled_by_its_kind_in_every_record(self):
        cell = self.kernel.run(f"await bash(\"true 'Authorization: Bearer {_OLD_KEY}'\")")
        records = _activity_records(cell, "command")
        self.assertGreater(len(records), 0)
        self.assertEqual({record["label"] for record in records}, {"command"})
        self.assertEqual(_anywhere(cell, _OLD_KEY), [])

    def test_a_key_that_straddles_the_label_cut_is_found_before_the_cut(self):
        # The command line reaches the label length in the middle of the key: cut first, and what is
        # left of the key is under the scan's length floor while its first characters still show.
        command = "true " + "x" * 130 + " Bearer " + _OLD_KEY
        self.assertGreater(len(command), effects.MAX_LABEL)
        cell = self.kernel.run(f"await bash({command!r})")
        records = _activity_records(cell, "command")
        self.assertEqual({record["label"] for record in records}, {"command"})
        self.assertEqual(_anywhere(cell, _OLD_KEY[:10]), [])

    def test_ordinary_commands_keep_their_label(self):
        commands = [
            "echo npm install --save-dev typescript",
            "echo git log --oneline -20",
            "echo max_tokens=4096 password_hint=none",
            "echo " + "word " * 60,
        ]
        self.assertGreater(len(commands), 0)
        for command in commands:
            with self.subTest(command=command):
                cell = self.kernel.run(f"await bash({command!r})")
                labels = {record["label"] for record in _activity_records(cell, "command")}
                self.assertEqual(labels, {effects._one_line(command, effects.MAX_LABEL)})

    def test_a_background_command_is_labelled_by_its_kind_when_it_is_left_running_and_when_it_ends(self):
        first = self.kernel.run(f"h = bash(\"sleep 0.4; true 'Authorization: Bearer {_OLD_KEY}'\")\nh.pid")
        time.sleep(1.2)  # the model thinking: the command ends while no cell runs
        second = self.kernel.run("x = 1")
        records = _activity_records(first, "command") + _activity_records(second, "command")
        self.assertTrue(any(record.get("background") and record["status"] == "ok" for record in records), records)
        self.assertEqual({record["label"] for record in records}, {"command"})
        self.assertEqual(_anywhere(first, _OLD_KEY) + _anywhere(second, _OLD_KEY), [])


def _spawn_reply(name: str) -> dict:
    return {"rlm.run": {"rlm_child_id": "c1", "name": name, "session_dir": "/tmp/child", "model": "prov/model-x"}}


@unittest.skipUnless(te.HAS_GIT, "git is needed for the work-tree comparison")
class SubagentLabelTests(te.TrackerCase):
    """The task text of a subagent spawn is a label too: the step's label while the child is admitted."""

    def host_replies(self) -> dict:
        return _spawn_reply("researcher")

    def test_a_task_text_with_a_key_is_labelled_by_the_kind_until_the_child_has_a_name(self):
        cell = self.kernel.run(f"handle = await rlm.run('call the api with Bearer {_OLD_KEY} and report')\nhandle.name")
        records = _activity_records(cell, "subagent")
        self.assertEqual(records[0]["status"], "running")
        self.assertEqual(records[0]["label"], "subagent")
        self.assertEqual(records[-1]["label"], "researcher")
        self.assertEqual(_anywhere(cell, _OLD_KEY), [])

    def test_an_ordinary_task_text_is_the_label_as_before(self):
        cell = self.kernel.run("handle = await rlm.run('look into the flaky test')\nhandle.name")
        records = _activity_records(cell, "subagent")
        self.assertEqual((records[0]["label"], records[-1]["label"]), ("look into the flaky test", "researcher"))


@unittest.skipUnless(te.HAS_GIT, "git is needed for the work-tree comparison")
class SubagentSecretNameTests(te.TrackerCase):
    """The label a step ends with (the child's name) goes through the same scan as the one it starts with."""

    def host_replies(self) -> dict:
        return _spawn_reply("creds-" + _OLD_KEY)

    def test_a_final_label_that_looks_like_a_key_is_replaced_by_the_kind(self):
        cell = self.kernel.run("handle = await rlm.run('look into the flaky test')\n1")
        records = _activity_records(cell, "subagent")
        self.assertEqual(records[0]["label"], "look into the flaky test")
        self.assertEqual(records[-1]["label"], "subagent")
        self.assertEqual(_anywhere(cell, _OLD_KEY), [])


class PassphraseShapeTests(unittest.TestCase):
    """FIX-3: a passphrase kept in quotes has spaces in it (`"correct horse battery staple"`), which no
    value rule allowed. Two to five short words of letters and digits, next to a credential's name, are
    now withheld unless they read as a sentence or a label."""

    def test_a_quoted_passphrase_next_to_a_credentials_name_is_withheld(self):
        passphrases = [
            'password = "correct horse battery staple"',
            'password: "two words here"',
            "password = 'correct horse battery staple'",
            'db_password = "purple monkey dishwasher"',
            'client_secret: "abcd efgh ijkl mnop"',
            '{"api_key": "alpha bravo charlie delta echo"}',
        ]
        self.assertGreater(len(passphrases), 0)
        for text in passphrases:
            with self.subTest(text=text):
                self.assertTrue(effects._looks_secret(text))

    def test_sentences_labels_and_names_that_are_not_credentials_stay_clean(self):
        ordinary = [
            'token = "a very long natural sentence that is not a secret"',
            'api_key = "the value is set by the deploy pipeline"',
            'password = "please use the staging credentials for now"',
            'name = "John Smith"',
            'title = "hello world"',
            '"confirm_password": "Confirm password"',
            '"password": "Enter your password"',
            'token = "Invalid token"',
            'api_key = "Missing API key"',
            'secret = "not set yet"',
            'password = "1234 5678"',
            "password = 'Password used to generate key'",
            "// token: 'Bearer xxxx'",
            'password = "your value here"',
            'secret = "Access denied"',
        ]
        self.assertGreater(len(ordinary), 0)
        for text in ordinary:
            with self.subTest(text=text):
                self.assertFalse(effects._looks_secret(text))

    def test_single_words_and_bare_values_are_judged_as_before(self):
        withheld = ['password = "hunter22"', "password: hunter2passw", '"password": "hunter22"']
        clean = ['password = "changeme"', "password: str", 'password = "use-token-here"', 'password == "abcdefgh1234"']
        self.assertGreater(len(withheld) + len(clean), 0)
        for text in withheld:
            with self.subTest(text=text):
                self.assertTrue(effects._looks_secret(text))
        for text in clean:
            with self.subTest(text=text):
                self.assertFalse(effects._looks_secret(text))

    def test_unquoted_words_and_long_phrases_are_not_covered(self):
        # By design: the bare value stops at the first space, and a sixth word makes it prose.
        for text in ["password: correct horse battery staple", 'password = "one two three four five six"']:
            with self.subTest(text=text):
                self.assertFalse(effects._looks_secret(text))


@unittest.skipUnless(te.HAS_GIT, "git is needed for the work-tree comparison")
class PassphrasePipelineTests(te.TrackerCase):
    def test_a_passphrase_written_to_an_ordinary_file_keeps_its_counts_but_no_diff(self):
        cell = self.kernel.run("open('notes.txt', 'w').write('password = \"correct horse battery staple\"\\n')")
        record = cell.by_rel()["notes.txt"]
        self.assertEqual((record["kind"], record["added"]), ("created", 1))
        self.assertEqual(record["diffOmitted"], effects.SENSITIVE)
        self.assertNotIn("diff", record)
        self.assertEqual(_anywhere(cell, "horse battery"), [])


if __name__ == "__main__":
    unittest.main()
