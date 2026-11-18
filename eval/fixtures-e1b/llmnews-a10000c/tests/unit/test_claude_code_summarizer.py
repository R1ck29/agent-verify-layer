import unittest
from collections.abc import AsyncIterator
from datetime import UTC, datetime

from llm_news.adapters.llm.claude_code_summarizer import ClaudeCodeSummarizer
from llm_news.domain.models import RawItem


def _item(body: str) -> RawItem:
    return RawItem(
        source_id="blog:anthropic",
        external_id="1",
        url="https://x",
        title="t",
        body=body,
        published_at=datetime(2026, 5, 15, tzinfo=UTC),
        author=None,
    )


def _fake(text: str):
    async def _q(prompt: str) -> AsyncIterator[object]:
        yield {"text": text}

    return _q


class ClaudeCodeSummarizerTest(unittest.TestCase):
    def test_empty_body_skips_call(self) -> None:
        called = []

        async def _q(prompt: str) -> AsyncIterator[object]:
            called.append(prompt)
            yield {"text": "{}"}

        out = ClaudeCodeSummarizer(query_fn=_q).summarize(_item("   "))
        self.assertEqual((out.text, out.bullets), ("", ()))
        self.assertEqual(called, [])

    def test_parses_json(self) -> None:
        s = ClaudeCodeSummarizer(query_fn=_fake('{"text":"A tight summary.","bullets":["x","y"]}'))
        out = s.summarize(_item("real content"))
        self.assertEqual((out.text, out.bullets), ("A tight summary.", ("x", "y")))

    def test_bad_json_degrades_to_empty(self) -> None:
        out = ClaudeCodeSummarizer(query_fn=_fake("garbage, no json")).summarize(_item("real content"))
        self.assertEqual((out.text, out.bullets), ("", ()))

    def test_fenced_json_ok(self) -> None:
        s = ClaudeCodeSummarizer(query_fn=_fake('```json\n{"text":"hi","bullets":[]}\n```'))
        self.assertEqual(s.summarize(_item("real")).text, "hi")


if __name__ == "__main__":
    unittest.main()
