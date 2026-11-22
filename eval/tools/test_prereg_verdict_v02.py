import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prereg_verdict_v02 import P0, P2, invalid_reason, verdict  # noqa: E402


def oc(spec):
    """spec: {(task, profile): "PFI..."} → outcomes（1 文字 = 1 試行）。"""
    m = {"P": "pass", "F": "fail", "I": "invalid"}
    return {(t, p, (0, i)): m[c] for (t, p), s in spec.items() for i, c in enumerate(s)}


class Verdict(unittest.TestCase):
    def base(self, p0="PFF", p2="PPF", c0="PPP", c2="PPP"):
        spec = {}
        for n in range(6):
            spec[(f"trap-{n}", P0)] = p0
            spec[(f"trap-{n}", P2)] = p2
        for n in range(3):
            spec[(f"ctrl-{n}", P0)] = c0
            spec[(f"ctrl-{n}", P2)] = c2
        return oc(spec)

    def test_useful(self):
        r = verdict(self.base(), [True])
        self.assertEqual(r["verdict"], "USEFUL")
        self.assertEqual(r["trap_pairs"], {"improved": 6, "regressed": 0})

    def test_ceiling_inconclusive(self):
        r = verdict(self.base(p0="PPP", p2="PPP"), [True])
        self.assertEqual(r["verdict"], "INCONCLUSIVE")
        self.assertIn("(a)", r["inconclusive_reasons"][0])

    def test_ctrl_regression_not_useful(self):
        r = verdict(self.base(c2="PPF"), [True])
        self.assertEqual(r["verdict"], "NOT USEFUL")

    def test_no_stop_fired(self):
        self.assertEqual(verdict(self.base(), [False, False])["verdict"], "INCONCLUSIVE")
        self.assertEqual(verdict(self.base(), [None])["verdict"], "USEFUL (要確認(b))")

    def test_invalid_pairs_skipped_and_valid_rate(self):
        r = verdict(self.base(p2="IIF"), [True])
        self.assertEqual(r["trap_pairs"], {"improved": 0, "regressed": 0})
        self.assertEqual(r["verdict"], "NOT USEFUL")  # 12/54 無効 → 有効 77.8% ≥ 75% なので (c) は効かず、P2 の合格 0 で有用でない
        self.assertNotIn("(c) 有効な試行が 75% 未満", r["inconclusive_reasons"])

    def test_invalid_rate(self):
        r = verdict(self.base(p0="PFI", p2="IIF"), [True])
        self.assertIn("(c) 有効な試行が 75% 未満", r["inconclusive_reasons"])

    def test_invalid_reason(self):
        self.assertEqual(invalid_reason({"valid": True, "error": {"type": "agent_error", "message": "You've hit your usage limit"}}), "usage_limit")
        self.assertIsNone(invalid_reason({"valid": True, "error": {"type": "max_turns"}}))
        self.assertEqual(invalid_reason({"valid": True, "error": {"type": "budget_stop"}}), "budget_stop")
        self.assertEqual(invalid_reason({"valid": False, "invalid_reason": "harness_error"}), "harness_error")


if __name__ == "__main__":
    unittest.main()
