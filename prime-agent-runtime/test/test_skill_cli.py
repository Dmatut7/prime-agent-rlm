"""Why a skill name is a Python module, not a shell command.

The model-facing prompt used to promise that every skill is also a same-named shell command. Only
two shapes exist in reality, and this pins both: a self-contained skill runs in a plain subprocess,
while a skill that asks the host for work dies the moment it leaves the kernel process, because the
host bridge is the kernel's own protocol pipe. R12, see docs/fork/audits.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from rlm import repl, skill

# A child process must not inherit this session's kernel identity, or the probe would
# be measuring the wrong process.
_PROBE_ENV = {k: v for k, v in os.environ.items() if not k.startswith(("RLM_", "PRIME_AGENT_", "PI_"))}

def _run_probe(code: str, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-P", "-c", code],
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**_PROBE_ENV, "PYTHONPATH": str(Path(repl.__file__).parent.parent)},
    )


class SkillShellShapeTest(unittest.TestCase):
    def test_host_backed_skill_cannot_run_outside_the_kernel(self) -> None:
        """Positive control for the prompt's claim that host-backed skills are kernel-only."""
        result = _run_probe(
            "import asyncio, rlm\n"
            "try:\n"
            "    asyncio.run(rlm.host_request('agent_message.list_agents'))\n"
            "    print('SERVED')\n"
            "except Exception as exc:\n"
            "    print(f'{type(exc).__name__}: {exc}')\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("RuntimeError: repl runtime is not serving", result.stdout)
        self.assertFalse(repl.is_active(), "the test process must not be serving the kernel protocol")

    @unittest.skipIf(
        importlib.util.find_spec("edit") is None,
        "the edit skill is installed by the kernel bootstrap, not by this project's dev venv",
    )
    def test_self_contained_skill_runs_in_a_plain_subprocess(self) -> None:
        """The one CLI shape that does work stays reachable: a self-contained module imports and
        runs in a plain subprocess, which is exactly why it never needed a documented shell form."""
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "target.txt"
            target.write_text("alpha beta\n")
            result = _run_probe(
                "import asyncio, edit\n"
                f"print(asyncio.run(edit.run(path={str(target)!r}, old_str='alpha', new_str='gamma')))\n"
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(target.read_text(), "gamma beta\n")


if __name__ == "__main__":
    unittest.main()
