import unittest

from llm_news._md import md_escape, strip_newlines


class MdTest(unittest.TestCase):
    def test_strip_newlines_collapses_all_whitespace(self) -> None:
        self.assertEqual(strip_newlines("a\n\tb   c"), "a b c")

    def test_md_escape_escapes_brackets_and_backslash(self) -> None:
        self.assertEqual(md_escape("a [x] \\ y"), "a \\[x\\] \\\\ y")

    def test_md_escape_is_identity_on_plain_text(self) -> None:
        self.assertEqual(md_escape("plain title 1.0"), "plain title 1.0")


if __name__ == "__main__":
    unittest.main()
