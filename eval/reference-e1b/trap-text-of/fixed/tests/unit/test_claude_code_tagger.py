import unittest
from collections.abc import AsyncIterator
from datetime import UTC, datetime

from llm_news.adapters.llm.claude_code_tagger import ClaudeCodeTagger
from llm_news.domain.models import RawItem, Tags

TOPICS = frozenset({"safety", "release"})


def _item(body: str = "Anthropic shipped a safety update.") -> RawItem:
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


class ClaudeCodeTaggerTest(unittest.TestCase):
    def test_returns_tags_from_valid_json(self) -> None:
        t = ClaudeCodeTagger(
            allowed_topics=TOPICS,
            query_fn=_fake('{"company":"anthropic","topics":["safety"]}'),
        )
        self.assertEqual(t.tag(_item()), Tags(company="anthropic", topics=("safety",)))

    def test_fenced_json_ok(self) -> None:
        t = ClaudeCodeTagger(
            allowed_topics=TOPICS,
            query_fn=_fake('```json\n{"company":"openai","topics":["release"]}\n```'),
        )
        self.assertEqual(t.tag(_item()).company, "openai")

    def test_falls_back_to_other_after_retries(self) -> None:
        t = ClaudeCodeTagger(allowed_topics=TOPICS, query_fn=_fake("not json at all"), schema_max_retries=1)
        self.assertEqual(t.tag(_item()), Tags(company="other", topics=("other",)))

    def test_unknown_company_falls_back(self) -> None:
        t = ClaudeCodeTagger(
            allowed_topics=TOPICS,
            query_fn=_fake('{"company":"acme","topics":["safety"]}'),
        )
        self.assertEqual(t.tag(_item()), Tags(company="other", topics=("other",)))

    def test_negative_retries_rejected(self) -> None:
        with self.assertRaises(ValueError):
            ClaudeCodeTagger(allowed_topics=TOPICS, schema_max_retries=-1)

    def test_propagates_transport_error(self) -> None:
        async def _q(prompt: str) -> AsyncIterator[object]:
            raise RuntimeError("sdk transport down")
            yield  # pragma: no cover

        t = ClaudeCodeTagger(allowed_topics=TOPICS, query_fn=_q)
        with self.assertRaisesRegex(RuntimeError, "sdk transport down"):
            t.tag(_item())


if __name__ == "__main__":
    unittest.main()
