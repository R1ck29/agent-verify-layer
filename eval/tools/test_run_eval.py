#!/usr/bin/env python3
"""run-eval.sh（AHE v0.10.0 用）の単体テスト。モデルは呼ばない（偽の claude を PATH の先頭に置き、`plan` モード = 見積もりまでで止まる）。
  python3 eval/tools/test_run_eval.py
AHE の場所は AHE_DIR（既定 ../../ahe-sound、なければ ../../agent-harness-eval）。見つからなければ AHE を使うテストは SKIP。"""
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

EVAL = Path(__file__).resolve().parent.parent
RUN = EVAL / "run-eval.sh"


def find_ahe():
    for c in (os.environ.get("AHE_DIR"), EVAL / "../../ahe-sound", EVAL / "../../agent-harness-eval"):
        if c and (Path(c) / "harness_eval" / "__init__.py").is_file():
            return Path(c).resolve()
    return None


AHE = find_ahe()


def fake_bin(d: Path, version="2.1.329 (Claude Code)"):
    d.mkdir(parents=True, exist_ok=True)
    f = d / "claude"
    f.write_text(f"#!/bin/sh\n[ \"$1\" = --version ] && {{ echo '{version}'; exit 0; }}\necho 'model は呼ばない' >&2; exit 99\n")
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    return d


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="run-eval-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        for f in (EVAL / "profiles-e1b").glob(".sbx.*"):
            f.unlink()

    def run_eval(self, *args, env=None, path_prepend=None):
        e = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CODE_OAUTH_TOKEN", "SANDBOX")}
        e.update({"OUT_ROOT": str(self.tmp / "out"), "CLAUDE_CODE_OAUTH_TOKEN": "dummy-not-a-real-token"})
        if AHE:
            e["AHE_DIR"] = str(AHE)
        if path_prepend:
            e["PATH"] = f"{path_prepend}:{e['PATH']}"
        e.update(env or {})
        return subprocess.run(["bash", str(RUN), *args], capture_output=True, text=True, env=e, cwd=EVAL, timeout=300)


class VersionGate(Base):
    def test_old_ahe_stops(self):
        fake = self.tmp / "oldahe"
        (fake / "harness_eval").mkdir(parents=True)
        (fake / "harness_eval" / "__init__.py").write_text('__version__ = "0.9.9"\n')
        r = self.run_eval("plan", "heldout", env={"AHE_DIR": str(fake)})
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("0.10.0", r.stderr)


@unittest.skipUnless(AHE, "AHE（v0.10.0 以上）が見つからない")
class PlanMode(Base):
    def profile(self, name):
        return (EVAL / "profiles-e1b" / name).read_text()

    def test_real_profiles_use_ahe_bwrap_not_sandbox_run(self):
        r = self.run_eval("plan", "heldout", path_prepend=str(fake_bin(self.tmp / "bin")))
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 0, out)
        for n in (".sbx..p0.claude-baseline.yaml", ".sbx.claude-verify-layer.yaml"):
            y = self.profile(n)
            self.assertNotIn("sandbox-run.sh", y)
            self.assertNotIn("executable:", y)
            self.assertIn("sandbox: bwrap", y)
            self.assertIn("sandbox_ro:", y)
            for sub in ("/scripts", "/hooks", "/codex", "/rules"):
                self.assertIn(sub, y.split("sandbox_ro:")[1])
        self.assertNotIn("見つかりません", out)  # doctor が claude の版を見つける
        self.assertIn("2.1.329", out)

    def test_plan_is_not_stopped_by_cost_and_never_runs(self):
        r = self.run_eval("plan", "heldout", path_prepend=str(fake_bin(self.tmp / "bin")))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("止めました", r.stdout + r.stderr)
        self.assertNotIn("== 実行 →", r.stdout)

    def test_no_bwrap_stops(self):
        nb = self.tmp / "nobwrap"
        nb.mkdir()
        for d in ("/usr/bin", "/bin"):
            for p in Path(d).iterdir():
                if p.name != "bwrap" and not (nb / p.name).exists():
                    (nb / p.name).symlink_to(p)
        fake_bin(nb)
        r = self.run_eval("plan", "heldout", env={"PATH": f"{nb}"})
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("bwrap", r.stderr)

    def test_sandbox_off_is_recorded_not_for_verdict(self):
        r = self.run_eval("plan", "heldout", env={"SANDBOX": "off"}, path_prepend=str(fake_bin(self.tmp / "bin")))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("sandbox: off", self.profile(".sbx.claude-verify-layer.yaml"))
        self.assertTrue((self.tmp / "out" / "plan-heldout" / "NOT-FOR-VERDICT.txt").is_file())


@unittest.skipUnless(AHE, "AHE（v0.10.0 以上）が見つからない")
class P2V02(Base):
    def fake_v02(self, with_impl=True):
        d = self.tmp / "v02"
        (d / "scripts" / "lib").mkdir(parents=True)
        (d / "scripts" / "lib" / "config.js").write_text("// verifyV2\n" if with_impl else "// v0.1\n")
        return d

    def tearDown(self):
        super().tearDown()
        for f in (EVAL / "profiles-heldout").glob(".*.yaml"):
            f.unlink()

    def test_stops_without_v02_implementation(self):
        r = self.run_eval("plan", "heldout", env={"P2": "v02", "VL_V02_DIR": str(self.fake_v02(False))}, path_prepend=str(fake_bin(self.tmp / "bin")))
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("v0.2 の実装", r.stderr)

    def test_codex_p2_is_not_available(self):
        r = self.run_eval("plan", "heldout", env={"P2": "v02", "AGENT": "codex", "VL_V02_DIR": str(self.fake_v02())})
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("linked", r.stderr)

    def test_three_profiles_p0_p1_p2_with_v02_dir_in_sandbox_ro(self):
        v02 = self.fake_v02()
        r = self.run_eval("plan", "heldout", env={"P2": "v02", "VL_V02_DIR": str(v02), "TRIALS": "3"}, path_prepend=str(fake_bin(self.tmp / "bin")))
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 0, out)
        self.assertIn("プロファイル 3 件", out)
        self.assertNotIn("[claude-static-rules]", out)
        y = (EVAL / "profiles-heldout" / ".sbx..v02.claude-verify-v02.yaml").read_text()
        self.assertIn(f"{v02}/scripts", y)
        self.assertIn("sandbox: bwrap", y)
        self.assertNotIn("@V02_DIR@", y)
        self.assertIn("81 試行", out)
        self.assertIn("呼び出し 0 回）", out)  # v0.2 の履歴（P2 × 1.3）があり、見積もれない呼び出しがない


def trials_of(stdout):
    """dry の出力先の trials.jsonl の行（dict の一覧）。"""
    import json
    d = [l.split(": ", 1)[1].strip() for l in stdout.splitlines() if l.startswith("dry の出力先")][0]
    f = next(Path(d).glob("20*/trials.jsonl"))
    return [json.loads(l) for l in f.read_text().splitlines()]


@unittest.skipUnless(AHE, "AHE（v0.10.0 以上）が見つからない")
class DryPipeline(Base):
    def test_dry_passes_all_and_is_not_stopped_by_cost(self):
        r = self.run_eval("dry", "heldout")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        rows = trials_of(r.stdout)
        self.assertEqual((len(rows), sum(1 for x in rows if x["valid"] and x["passed"])), (27, 27))

    def test_full_estimate_uses_history_and_fits_prereg_cap(self):
        r = self.run_eval("plan", "heldout", path_prepend=str(fake_bin(self.tmp / "bin")), env={"TRIALS": "3"})
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 0, out)
        self.assertIn("上限 $16", out)
        self.assertIn("81 試行", out)
        self.assertIn("呼び出し 0 回）", out)  # 履歴がなく見積もれない呼び出しが 0

    def test_without_history_the_estimate_would_stop(self):
        """履歴がないと 81 × 1.5 = 121.5 USD で上限 16 を超えて止まる（履歴を与える理由）。"""
        r = self.run_eval("plan", "heldout", path_prepend=str(fake_bin(self.tmp / "bin")), env={"TRIALS": "3", "HIST_JSONL": "none"})
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("止めました", r.stderr)

    def test_runtime_cap_uses_actual_cost(self):
        r = self.run_eval("dry", "heldout", env={"FAKE_COST": "0.6", "CAP_USD": "1", "JOBS": "1"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("budget_stop", r.stdout)
        ran = [x for x in trials_of(r.stdout) if x["cost_usd"]]
        self.assertTrue(0 < len(ran) < 27)

    def test_sandboxed_peeking_agent_reads_nothing_and_is_invalid(self):
        r = self.run_eval("dry", "heldout", env={"SANDBOX": "dry"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        rows = trials_of(r.stdout)
        self.assertEqual(len(rows), 27)
        self.assertEqual(sum(1 for x in rows if x["passed"]), 0)
        self.assertTrue(all((not x["valid"]) and (x["error"] or {}).get("type") == "leak" for x in rows))
        d = [l.split(": ", 1)[1].strip() for l in r.stdout.splitlines() if l.startswith("dry の出力先")][0]
        err = next(Path(d).glob("20*/trials/*/*/0/stderr.txt")).read_text()
        self.assertIn("readable=False", err)
        self.assertNotIn("readable=True", err)


if __name__ == "__main__":
    unittest.main()
