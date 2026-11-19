# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""The Stop hook refuses to end a session while the task graph is unfinished."""

from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from sample_harness import claude_hook
from tests.helpers import graph, node


class StopHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.project = Path(self._directory.name)
        patched = mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(self.project)})
        patched.start()
        self.addCleanup(patched.stop)
        stdin = mock.patch("sys.stdin", io.StringIO(""))
        stdin.start()
        self.addCleanup(stdin.stop)

    def _write_graph(self, document: dict[str, Any]) -> None:
        (self.project / "task-graph.json").write_text(
            json.dumps(document), encoding="utf-8"
        )

    def test_a_project_without_a_graph_may_stop(self) -> None:
        self.assertEqual(0, claude_hook.main())

    def test_an_incomplete_graph_blocks_the_stop(self) -> None:
        self._write_graph(graph(node("task", status="ready")))

        with mock.patch("sys.stderr", io.StringIO()) as reported:
            self.assertEqual(2, claude_hook.main())

        self.assertIn("Graph completion is not verified", reported.getvalue())

    def test_a_verified_graph_may_stop(self) -> None:
        self._write_graph(graph(node("task", status="verified")))

        self.assertEqual(0, claude_hook.main())

    def _stop(self, text: str) -> int:
        with mock.patch("sys.stdin", io.StringIO(text)):
            return claude_hook.main()

    def test_the_payload_is_read_from_standard_input(self) -> None:
        self._write_graph(graph(node("task", status="ready")))

        self.assertEqual(0, self._stop(json.dumps({"stop_hook_active": True})))
        self.assertEqual(2, self._stop(json.dumps({"stop_hook_active": False})))

    def test_an_empty_or_malformed_payload_is_ignored(self) -> None:
        self._write_graph(graph(node("task", status="ready")))

        with mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(2, self._stop(""))
            self.assertEqual(2, self._stop("{not json"))

    def test_a_payload_that_is_not_an_object_or_is_too_large_is_refused(self) -> None:
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(2, self._stop("[1, 2]"))
            self.assertEqual(2, self._stop(json.dumps({"pad": "x" * 1_100_000})))

    def test_the_payload_cwd_is_the_root_when_no_project_dir_is_set(self) -> None:
        self._write_graph(graph(node("task", status="ready")))
        with mock.patch.dict(os.environ):
            del os.environ["CLAUDE_PROJECT_DIR"]
            with mock.patch("sys.stderr", io.StringIO()):
                self.assertEqual(2, self._stop(json.dumps({"cwd": str(self.project)})))

    def test_an_unsupported_interpreter_is_refused(self) -> None:
        with self.assertRaises(SystemExit) as raised:
            claude_hook.ensure_supported_python((3, 8, 5))

        self.assertEqual(2, raised.exception.code)

    @unittest.skip("the Windows launcher is not covered yet")
    def test_the_hook_runs_under_the_windows_launcher(self) -> None:
        self.fail("not written")
