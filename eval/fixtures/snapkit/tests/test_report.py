import unittest

from snapkit.report import render, summarize


class ReportTest(unittest.TestCase):
    def test_summarize_counts_by_extension(self):
        s = summarize(["a.py", "b.py", "c.md", "Makefile"])
        self.assertEqual(s["count"], 4)
        self.assertEqual(s["by_ext"], {".md": 1, ".py": 2, "(none)": 1})

    def test_render(self):
        text = render(summarize(["a.py"]))
        self.assertEqual(text, "files: 1\n  .py: 1")


if __name__ == "__main__":
    unittest.main()
