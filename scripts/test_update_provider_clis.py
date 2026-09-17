"""Offline regression tests: every CLI below is a temporary fake native install."""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "updater", Path(__file__).with_name("update-provider-clis.py")
)
updater = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(updater)


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / ".local/bin").mkdir(parents=True)

    def cli(self, provider, body):
        root = self.home / updater.NATIVE_ROOTS[provider]
        root.mkdir(parents=True, exist_ok=True)
        binary = root / "fake-cli"
        binary.write_text(f"#!{sys.executable}\n" + body)
        binary.chmod(0o700)
        launcher = self.home / ".local/bin" / provider
        launcher.symlink_to(binary)
        return launcher

    def test_updates_both_and_reports_versions(self):
        body = (
            "import pathlib, sys\n"
            "state = pathlib.Path.home() / (pathlib.Path(sys.argv[0]).name + '.updated')\n"
            "if sys.argv[1] == 'update': state.write_text('yes')\n"
            "else:\n    version = '2.0.0' if state.exists() else '1.0.0'\n    print('codex-cli ' + version if 'codex' in str(sys.argv[0]) else version + ' (Claude Code)')\n"
        )
        for provider in updater.NATIVE_ROOTS:
            self.cli(provider, body)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(updater.update_all(self.home), 0)
        self.assertIn("codex: 'codex-cli 1.0.0' -> 'codex-cli 2.0.0'", output.getvalue())
        self.assertIn("claude: '1.0.0 (Claude Code)' -> '2.0.0 (Claude Code)'", output.getvalue())

    def test_failure_does_not_skip_other_provider_or_log_raw_output(self):
        self.cli("codex", "import sys\nprint('private-output')\nsys.exit(5)\n")
        self.cli("claude", "import sys, pathlib\nif sys.argv[1] == 'update': pathlib.Path('attempted').touch()\nprint('1.0.0 (Claude Code)')\n")
        output = io.StringIO()
        with contextlib.redirect_stderr(output), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(updater.update_all(self.home), 1)
        self.assertTrue((self.home / "attempted").exists())
        self.assertIn("exited 5", output.getvalue())
        self.assertNotIn("private-output", output.getvalue())

    def test_missing_first_install_still_updates_second(self):
        self.cli("claude", "import sys, pathlib\nif sys.argv[1] == 'update': pathlib.Path('attempted').touch()\nprint('1.0.0 (Claude Code)')\n")
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(updater.update_all(self.home), 1)
        self.assertTrue((self.home / "attempted").exists())

    def test_rejects_non_native_launcher(self):
        (self.home / updater.NATIVE_ROOTS["codex"]).mkdir(parents=True)
        launcher = self.home / ".local/bin/codex"
        launcher.write_text("#!/bin/sh\nexit 0\n")
        launcher.chmod(0o700)
        with self.assertRaises(ValueError):
            updater.native_binary(self.home, "codex")

    def test_output_is_bounded(self):
        binary = self.cli("codex", "print('x' * 1000000)\n")
        with self.assertRaisesRegex(RuntimeError, "output exceeded"):
            updater.run_command(binary, "update", self.home, 5)

    def test_invalid_version_does_not_start_update(self):
        self.cli("codex", "import pathlib\npathlib.Path('called').open('a').write('x')\nprint('')\n")
        with self.assertRaisesRegex(ValueError, "version banner"):
            updater.update_provider(self.home, "codex")
        self.assertEqual((self.home / "called").read_text(), "x")

    def test_invalid_version_after_update_is_failure(self):
        self.cli("codex", "import pathlib, sys\np = pathlib.Path('updated')\nif sys.argv[1] == 'update': p.touch()\nelse: print('private diagnostic' if p.exists() else 'codex-cli 2.0.0')\n")
        with self.assertRaisesRegex(ValueError, "version banner"):
            updater.update_provider(self.home, "codex")

    def test_version_downgrade_is_failure(self):
        self.cli("codex", "import pathlib, sys\np = pathlib.Path('updated')\nif sys.argv[1] == 'update': p.touch()\nelse: print('codex-cli 1.0.0' if p.exists() else 'codex-cli 2.0.0')\n")
        with self.assertRaisesRegex(ValueError, "decreased"):
            updater.update_provider(self.home, "codex")

    def test_environment_does_not_forward_tokens(self):
        binary = self.cli("codex", "import os\nassert 'PRIVATE_TEST_TOKEN' not in os.environ\nprint(os.environ['HOME'])\n")
        with patch.dict(os.environ, {"PRIVATE_TEST_TOKEN": "secret"}):
            self.assertEqual(updater.run_command(binary, "update", self.home, 5), str(self.home))

    def test_timeout_kills_pipe_holding_descendant(self):
        binary = self.cli("codex", (
            "import os, pathlib, time\n"
            "pid = os.fork()\n"
            "if pid == 0:\n"
            "    time.sleep(0.7)\n"
            "    pathlib.Path('survived').touch()\n"
            "    os._exit(0)\n"
            "os._exit(0)\n"
        ))
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            updater.run_command(binary, "update", self.home, 0.2)
        self.assertLess(time.monotonic() - started, 2)
        time.sleep(0.8)
        self.assertFalse((self.home / "survived").exists())

    def test_eof_without_exit_is_still_bounded(self):
        binary = self.cli("codex", "import os, time\nos.close(1)\nos.close(2)\ntime.sleep(30)\n")
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            updater.run_command(binary, "update", self.home, 0.2)

    def test_concurrent_manual_run_is_rejected(self):
        directory = self.home / ".local/state/codevo-provider-updates"
        directory.mkdir(parents=True)
        with (directory / "update.lock").open("a") as lock:
            updater.fcntl.flock(lock, updater.fcntl.LOCK_EX | updater.fcntl.LOCK_NB)
            with patch.object(updater.Path, "home", return_value=self.home), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(updater.main(), 1)


if __name__ == "__main__":
    unittest.main()
