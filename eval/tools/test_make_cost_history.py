#!/usr/bin/env python3
"""make-cost-history.py の単体テスト（モデルは呼ばない）。  python3 eval/tools/test_make_cost_history.py"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parent / "make-cost-history.py"


def mean_by_profile(d: Path):
    acc = {}
    for f in d.glob("*.json"):  # AHE の runner._cost_history と同じ読み方
        r = json.loads(f.read_text())
        if r.get("cost_usd") is None:
            continue
        acc.setdefault(r["profile_id"], []).append(r["cost_usd"] + (r.get("judge_cost_usd") or 0))
    return {k: sum(v) / len(v) for k, v in acc.items()}


class History(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hist-test-"))
        self.src = self.tmp / "trials.jsonl"
        rows = [("claude-baseline", 0.10), ("claude-baseline", 0.20), ("claude-static-rules", 0.30),
                ("claude-verify-layer", 0.10), ("claude-verify-layer", 0.30), ("other", 9.0), ("claude-baseline", None)]
        self.src.write_text("\n".join(json.dumps({"profile_id": p, "task_id": "t", "cost_usd": c, "judge_cost_usd": 0.0}) for p, c in rows))
        self.out = self.tmp / "cache"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_tool(self, *args):
        return subprocess.run([sys.executable, str(TOOL), "--out", str(self.out), *args], capture_output=True, text=True)

    def test_claude_from_jsonl_and_v02_is_p2_times_1_3(self):
        r = self.run_tool("--agent", "claude", "--from-jsonl", str(self.src))
        self.assertEqual(r.returncode, 0, r.stderr)
        m = mean_by_profile(self.out)
        self.assertAlmostEqual(m["claude-baseline"], 0.15)
        self.assertAlmostEqual(m["claude-static-rules"], 0.30)
        self.assertAlmostEqual(m["claude-verify-layer"], 0.20)
        self.assertAlmostEqual(m["claude-verify-v02"], 0.26)  # claude-verify-layer（E1b の P2）の実測 × 1.3
        self.assertNotIn("other", m)
        self.assertIn("× 1.3", r.stdout)

    def test_records_are_history_only_and_never_a_cache_hit(self):
        self.run_tool("--agent", "claude", "--from-jsonl", str(self.src))
        for f in self.out.glob("*.json"):
            self.assertTrue(f.name.startswith("hist-"))  # キャッシュのキー名（<hash>.json）にはならない
            self.assertTrue(json.loads(f.read_text())["history_only"])

    def test_rerun_replaces_old_history_and_keeps_other_files(self):
        self.out.mkdir()
        (self.out / "hist-stale.json").write_text("{}")
        (self.out / "abc123.json").write_text("{}")
        self.run_tool("--agent", "claude", "--from-jsonl", str(self.src))
        self.assertFalse((self.out / "hist-stale.json").exists())
        self.assertTrue((self.out / "abc123.json").exists())

    def test_codex_uses_prereg_constant_with_v02_times_1_3(self):
        r = self.run_tool("--agent", "codex")
        self.assertEqual(r.returncode, 0, r.stderr)
        m = mean_by_profile(self.out)
        self.assertAlmostEqual(m["codex-baseline"], 0.09)
        self.assertAlmostEqual(m["codex-verify-layer"], 0.09)
        self.assertAlmostEqual(m["codex-verify-v02"], 0.117)

    def test_zero_for_dry(self):
        self.run_tool("--agent", "claude", "--zero")
        m = mean_by_profile(self.out)
        self.assertTrue(m and all(v == 0.0 for v in m.values()))
        self.assertIn("claude-verify-v02", m)

    def test_missing_profile_in_source_is_an_error(self):
        self.src.write_text(json.dumps({"profile_id": "claude-baseline", "task_id": "t", "cost_usd": 0.1}))
        r = self.run_tool("--agent", "claude", "--from-jsonl", str(self.src))
        self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
