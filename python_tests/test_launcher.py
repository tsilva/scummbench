"""Launcher contracts without installing dependencies or invoking a model."""

import contextlib
import io
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from scummbench import cli


class LauncherTests(unittest.TestCase):
    def test_editable_runtime_is_the_current_checkout(self):
        self.assertEqual(cli.runtime_root(), ROOT)

    def test_exec_preserves_arguments_and_working_directory(self):
        cwd = Path.cwd()
        with patch.object(cli.shutil, "which", return_value="/runtime/node"), \
             patch.object(cli.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "v22.1.0\n")), \
             patch.object(cli.os, "execv") as execute, \
             patch.object(sys, "argv", ["scummbench", "tasks", "literal argument"]):
            cli.main()
        execute.assert_called_once_with("/runtime/node", ["/runtime/node", str(ROOT / "src/cli.js"), "tasks", "literal argument"])
        self.assertEqual(Path.cwd(), cwd)

    def test_missing_or_old_node_fails_with_an_actionable_error(self):
        for node in (None, "/runtime/node"):
            with self.subTest(node=node), patch.object(cli.shutil, "which", return_value=node), \
                 patch.object(cli.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "v20.0.0\n")), \
                 patch.object(cli.os, "execv") as execute, contextlib.redirect_stderr(io.StringIO()), \
                 self.assertRaises(SystemExit) as failure:
                cli.main()
            self.assertEqual(failure.exception.code, 2)
            execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
