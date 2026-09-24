"""The runtime's str subclasses dump through yaml.safe_dump as plain strings."""

import importlib.util
import unittest

from rlm.bash import OutputText
from rlm.harness import AwaitableText

HAS_YAML = importlib.util.find_spec("yaml") is not None


@unittest.skipUnless(HAS_YAML, "PyYAML is not installed in this environment")
class YamlSafeDumpTest(unittest.TestCase):
    def test_bash_output_and_harness_text_dump_as_plain_strings(self):
        import yaml

        for value in (OutputText("hello\n"), AwaitableText("overview text")):
            dumped = yaml.safe_dump({"v": value})
            self.assertEqual(yaml.safe_load(dumped), {"v": str(value)})
            self.assertNotIn("python/object", yaml.dump({"v": value}))


if __name__ == "__main__":
    unittest.main()
