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

    def test_an_unsupported_interpreter_is_refused(self) -> None:
        with self.assertRaises(SystemExit) as raised:
            claude_hook.ensure_supported_python((3, 8, 5))

        self.assertEqual(2, raised.exception.code)

    @unittest.skip("the Windows launcher is not covered yet")
    def test_the_hook_runs_under_the_windows_launcher(self) -> None:
        self.fail("not written")
