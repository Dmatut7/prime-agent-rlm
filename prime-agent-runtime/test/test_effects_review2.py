"""Second-round fixes to secret withholding and change tracking (rlm.effects), from the lu/final-fixes review.

Fake credentials are assembled from pieces so no complete one sits in this file.
"""

from __future__ import annotations

import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_effects as te  # noqa: E402

from rlm import effects  # noqa: E402

_PASSWORD = "hunter2" + "passw0rd" + "ZQ"
_SK_KEY = "sk-" + "ws-H." + "TITLEKEY" + "q" * 20
_OLD_SK_KEY = "sk-" + "ws-H." + "OLDTITLE" + "r" * 20


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


class MemoryTitleScanTests(te.TrackerCase):
    """review2-2: the title and previous title of a memory record are display text saved with the session too."""

    use_git = False

    def _run_memory(self, code: str) -> te.Cell:
        cell = self.kernel.run(code)
        self.assertEqual(cell.status, "ok", cell.error())
        return cell

    def assert_accepted_title(self, record: dict) -> None:
        self.assertIsInstance(record["title"], str)
        self.assertTrue(record["title"], record)

    def test_a_new_entry_with_a_key_in_its_title_shows_its_id_and_no_texts(self):
        cell = self._run_memory(f"_ = rlm.harness.create_memory('deploy with {_SK_KEY}', 'body text', id='deploy-notes')")
        record = cell.memory()[("memory", "session", "deploy-notes")]
        self.assertEqual((record["op"], record["title"], record.get("textOmitted")), ("created", "deploy-notes", effects.SENSITIVE))
        self.assertNotIn("before", record)
        self.assertNotIn("after", record)
        self.assert_accepted_title(record)
        self.assertEqual(_anywhere(cell, _SK_KEY, _SK_KEY[:16], "body text"), [])

    def test_a_rename_to_a_title_with_a_key_shows_the_id_and_no_texts(self):
        self._run_memory("_ = rlm.harness.create_memory('Deploy steps', 'use make deploy', id='deploy-notes')")
        cell = self._run_memory(f"_ = rlm.harness.update_memory('deploy-notes', 'deploy with {_SK_KEY}', 'use make ship')")
        record = cell.memory()[("memory", "session", "deploy-notes")]
        self.assertEqual((record["op"], record["title"], record.get("textOmitted")), ("updated", "deploy-notes", effects.SENSITIVE))
        self.assertEqual(record["previousTitle"], "Deploy steps")
        self.assertNotIn("before", record)
        self.assertNotIn("after", record)
        self.assert_accepted_title(record)
        self.assertEqual(_anywhere(cell, _SK_KEY, _SK_KEY[:16], "use make"), [])

    def test_a_rename_away_from_a_title_with_a_key_drops_the_previous_title_and_the_texts(self):
        first = self._run_memory(f"_ = rlm.harness.create_memory('deploy with {_OLD_SK_KEY}', 'old body', id='deploy-notes')")
        self.assertEqual(_anywhere(first, _OLD_SK_KEY, _OLD_SK_KEY[:16]), [])
        cell = self._run_memory("_ = rlm.harness.update_memory('deploy-notes', 'Deploy steps', 'new body')")
        record = cell.memory()[("memory", "session", "deploy-notes")]
        self.assertEqual((record["op"], record["title"], record.get("textOmitted")), ("updated", "Deploy steps", effects.SENSITIVE))
        self.assertNotIn("previousTitle", record)
        self.assertNotIn("before", record)
        self.assertNotIn("after", record)
        self.assertEqual(_anywhere(cell, _OLD_SK_KEY, _OLD_SK_KEY[:16], "old body", "new body"), [])

    def test_a_deleted_entry_with_a_key_in_its_title_is_withheld_too(self):
        self._run_memory("_ = rlm.harness.create_memory('Notes', 'body text', id='deploy-notes')")
        self._run_memory(f"_ = rlm.harness.update_memory('deploy-notes', 'deploy with {_SK_KEY}', 'body text')")
        cell = self._run_memory("_ = rlm.harness.delete_memory('deploy-notes')")
        record = cell.memory()[("memory", "session", "deploy-notes")]
        self.assertEqual((record["op"], record["title"], record.get("textOmitted")), ("deleted", "deploy-notes", effects.SENSITIVE))
        self.assertEqual(_anywhere(cell, _SK_KEY, _SK_KEY[:16]), [])

    def test_an_id_that_looks_like_a_key_too_leaves_the_kind_as_the_title(self):
        # The id is the entry's identity for the host and is not rewritten; only the title is display text.
        cell = self._run_memory(
            f"_ = rlm.harness.create_memory('deploy with {_SK_KEY}', 'body text', id='{_OLD_SK_KEY}')"
        )
        record = cell.memory()[("memory", "session", _OLD_SK_KEY)]
        self.assertEqual((record["title"], record.get("textOmitted")), ("memory", effects.SENSITIVE))
        self.assertNotIn("before", record)
        self.assertNotIn("after", record)
        self.assertEqual(_anywhere(cell, _SK_KEY, _SK_KEY[:16]), [])

    def test_a_title_the_harness_turned_into_the_id_shows_the_kind(self):
        # No id given: the harness derives one from the title (lower-cased, punctuation flattened), which
        # holds the same characters, so it is no better a title than the title itself.
        cell = self._run_memory(f"_ = rlm.harness.create_memory('deploy with {_SK_KEY}', 'body text')")
        record = next(record for key, record in cell.memory().items() if key[0] == "memory")
        self.assertEqual((record["title"], record.get("textOmitted")), ("memory", effects.SENSITIVE))
        self.assertNotIn("before", record)
        self.assertNotIn("after", record)
        self.assertEqual(_anywhere(cell, _SK_KEY, _SK_KEY[:16], "body text"), [])

    def test_a_prompt_note_title_is_scanned_like_a_memory_title(self):
        cell = self._run_memory(f"_ = rlm.harness.create_prompt_note('tone {_SK_KEY}', 'be brief', id='note-1')")
        record = cell.memory()[("prompt_note", "session", "note-1")]
        self.assertEqual((record["title"], record.get("textOmitted")), ("note-1", effects.SENSITIVE))
        self.assertEqual(_anywhere(cell, _SK_KEY, _SK_KEY[:16], "be brief"), [])

    def test_ordinary_titles_texts_and_renames_are_sent_as_before(self):
        self._run_memory("_ = rlm.harness.create_memory('Deploy steps', 'use make deploy', id='deploy-notes')")
        cell = self._run_memory("_ = rlm.harness.update_memory('deploy-notes', 'Deploy steps v2', 'use make ship')")
        record = cell.memory()[("memory", "session", "deploy-notes")]
        self.assertEqual(record["title"], "Deploy steps v2")
        self.assertEqual(record["previousTitle"], "Deploy steps")
        self.assertEqual((record["before"], record["after"]), ("use make deploy", "use make ship"))
        self.assertNotIn("textOmitted", record)


class AssignmentDeclarationFormsTests(unittest.TestCase):
    """review2-3: Rust (`let password: &str = ...`) and Go (`var password string = ...`) declare a value
    in ways the assignment rule did not read. Comparisons and bare annotations still are not assignments."""

    def test_rust_and_go_declarations_are_withheld(self):
        declarations = [
            f'let password: &str = "{_PASSWORD}";',
            f"let password: &'static str = \"{_PASSWORD}\";",
            f'const TOKEN: &str = "{_PASSWORD}";',
            f"static API_KEY: &'static str = \"{_PASSWORD}\";",
            f'let secret: Option<&str> = "{_PASSWORD}";',
            f'let mut password: &mut str = "{_PASSWORD}";',
            f'var password string = "{_PASSWORD}"',
            'var token string = "abcdefgh1234"',
            f'var Password *string = "{_PASSWORD}"',
            f'const Secret string = "{_PASSWORD}"',
            f'var apiKey string = "{_PASSWORD}"',
            'var password string = "correct horse battery staple"',
        ]
        self.assertGreater(len(declarations), 0)
        for text in declarations:
            with self.subTest(text=text):
                self.assertTrue(effects.looks_secret(text))

    def test_comparisons_placeholders_bare_annotations_and_prose_stay_clean(self):
        ordinary = [
            'x == "12345678"',
            'password == "abcdefgh1234"',
            'password != "abcdefgh1234"',
            'if password >= "abcdefgh1234":',
            'password <= "abcdefgh1234"',
            "password: Optional[str] = None",
            "password: str",
            'password: str = ""',
            "password field = required",
            "token count = 12345678",
            "let password: &str = &args[1];",
            "let password: String = read_line();",
            'let password: &str = "";',
            'var password string = ""',
            'var password string = "changeme"',
            "var password string = os.Getenv(\"PASSWORD\")",
            "var password string",
            'password string == "abcdefgh1234"',
            "let password: &str;",
        ]
        self.assertGreater(len(ordinary), 0)
        for text in ordinary:
            with self.subTest(text=text):
                self.assertFalse(effects.looks_secret(text))

    def test_a_credential_word_at_a_line_end_does_not_reach_into_the_next_line(self):
        # The type and Go forms stay on one line: a line ending in `token` followed by an ordinary
        # assignment is code, not a declaration (found in cryptography and mcp during review).
        ordinary = [
            "raise InvalidToken\nunpadder = _PKCS7_128.unpadder()",
            'TOKEN_PATH = "/token"\nREGISTRATION_PATH = "/register"',
            'api_token: str\nbase_url = "https://example.com/api/v1"',
            '# Where to fetch the token\nTOKEN_URL = "https://example.com/oauth/token"',
            "def refresh(self, token\n             refresh_interval = 12345678):",
        ]
        self.assertGreater(len(ordinary), 0)
        for text in ordinary:
            with self.subTest(text=text):
                self.assertFalse(effects.looks_secret(text))

    def test_the_earlier_forms_are_judged_as_before(self):
        withheld = [
            f'password: str = "{_PASSWORD}"',
            f'password := "{_PASSWORD}"',
            "token: Optional[str] = 'abcdefgh12345678'",
            f'const password: string = "{_PASSWORD}";',
            'password = "hunter22"',
            "password: hunter2passw",
        ]
        self.assertGreater(len(withheld), 0)
        for text in withheld:
            with self.subTest(text=text):
                self.assertTrue(effects.looks_secret(text))


class DeclarationPipelineTests(te.TrackerCase):
    use_git = False

    def test_rust_and_go_declarations_written_to_source_files_keep_their_counts_but_no_diff(self):
        sources = {
            "main.rs": f'let password: &str = "{_PASSWORD}";',
            "main.go": f'var password string = "{_PASSWORD}"',
        }
        code = "".join(f"open({name!r}, 'w').write({line + chr(10)!r})\n" for name, line in sources.items())
        cell = self.kernel.run(code)
        files = cell.by_rel()
        self.assertEqual(sorted(files), sorted(sources))
        for name in sources:
            with self.subTest(name):
                record = files[name]
                self.assertEqual((record["kind"], record["added"]), ("created", 1))
                self.assertEqual(record["diffOmitted"], effects.SENSITIVE)
                self.assertNotIn("diff", record)
        self.assertEqual(_anywhere(cell, _PASSWORD[:10]), [])


class AssignmentScanCostTests(unittest.TestCase):
    """The declaration arms must stay linear: the scan runs on every label, detail, diff and memory text."""

    def test_pathological_runs_after_a_credentials_name_are_scanned_in_linear_time(self):
        size = 50_000
        texts = {
            "spaces": "password " + " " * size,
            "spaces then a word": "password" + " " * size + "x",
            "words": "password " + "word " * (size // 5),
            "one letter words": "password " + "a " * (size // 2),
            "one long word": "password " + "a" * size,
            "annotation words": "password: " + "a " * (size // 2),
            "annotation long word": "password: " + "a" * size,
            "annotation symbols": "password: " + "&'<*" * (size // 4),
            "repeated names": "password " * (size // 9),
            "repeated names with colons": "password: " * (size // 10),
            "repeated names with words": "password string " * (size // 16),
            "spaced colons": ("password:" + " " * 50) * (size // 59),
            "tabs and newlines": "token" + "\t\n " * (size // 3),
        }
        self.assertGreater(len(texts), 0)
        for name, text in texts.items():
            with self.subTest(name):
                started = time.perf_counter()
                effects.looks_secret(text)
                self.assertLess(time.perf_counter() - started, 1.0)


class _LinkReplacedByFile:
    """review2-4: a symlink replaced by a regular file of the same name is a modified file, in a git work
    tree and outside one alike: the file's lines show as new and nothing calls it a link."""

    def replace_link_with_file(self) -> dict:
        self.kernel.run("await bash('ln -s t alias')")
        cell = self.kernel.run("await bash('rm alias; echo x > alias')")
        self.assertEqual(sorted(cell.by_rel()), ["alias"])
        return cell.by_rel()["alias"]

    def test_the_replaced_link_is_a_plain_modified_file_with_its_lines_shown(self):
        record = self.replace_link_with_file()
        self.assertEqual(record["kind"], "modified")
        self.assertEqual(record["source"], "shell")
        self.assertNotIn("symlink", record)
        self.assertEqual((record["added"], record["removed"]), (1, 0))
        self.assertIn("+x\n", record["diff"])
        self.assertNotIn("diffOmitted", record)

    def test_the_replaced_link_by_an_empty_file_is_still_listed(self):
        self.kernel.run("await bash('ln -s t alias')")
        cell = self.kernel.run("await bash('rm alias; : > alias')")
        record = cell.by_rel()["alias"]
        self.assertEqual(record["kind"], "modified")
        self.assertNotIn("symlink", record)
        self.assertEqual((record["added"], record["removed"]), (0, 0))

    def test_a_file_replaced_by_a_link_is_still_a_modified_link(self):
        self.kernel.run("await bash('echo x > swap.txt')")
        cell = self.kernel.run("await bash('rm swap.txt; ln -s t swap.txt')")
        record = cell.by_rel()["swap.txt"]
        self.assertEqual((record["kind"], record["source"]), ("modified", "shell"))
        self.assertTrue(record.get("symlink"), record)
        self.assertEqual((record["added"], record["removed"]), (0, 0))
        self.assertNotIn("diff", record)

    def test_a_removed_link_and_a_re_pointed_link_are_still_links(self):
        self.kernel.run("await bash('ln -s t gone; ln -s t hop')")
        cell = self.kernel.run("await bash('rm gone; ln -sfn u hop')")
        files = cell.by_rel()
        self.assertEqual(sorted(files), ["gone", "hop"])
        self.assertEqual((files["gone"]["kind"], files["hop"]["kind"]), ("deleted", "modified"))
        for record in files.values():
            self.assertTrue(record.get("symlink"), record)
            self.assertEqual((record["added"], record["removed"]), (0, 0))
            self.assertNotIn("diff", record)


@unittest.skipUnless(os.name == "posix", "needs symlinks")
class NoGitLinkReplacedByFileTests(_LinkReplacedByFile, te.TrackerCase):
    use_git = False


@unittest.skipUnless(te.HAS_GIT and os.name == "posix", "needs git and symlinks")
class GitLinkReplacedByFileTests(_LinkReplacedByFile, te.TrackerCase):
    pass


@unittest.skipUnless(te.HAS_GIT and os.name == "posix", "needs git and symlinks")
class LinkReplacedInPythonTests(te.TrackerCase):
    def test_a_link_removed_and_rewritten_from_python_is_a_plain_modified_file(self):
        self.kernel.run("await bash('ln -s t alias')")
        cell = self.kernel.run("import os\nos.remove('alias')\nopen('alias', 'w').write('x\\n')")
        record = cell.by_rel()["alias"]
        self.assertEqual((record["kind"], record["source"]), ("modified", "python"))
        self.assertNotIn("symlink", record)
        self.assertEqual((record["added"], record["removed"]), (1, 0))
        self.assertIn("+x\n", record["diff"])


if __name__ == "__main__":
    unittest.main()
