import unittest
from dataclasses import dataclass

from llm_news.adapters.llm._schema import (
    extract_json,
    parse_tags_payload,
    parse_tldr_payload,
    text_of,
)
from llm_news.domain.limits import MAX_TLDR_BULLET, TLDR_TEXT_HARD_CAP
from llm_news.domain.models import Tags

TOPICS = frozenset({"safety", "release"})
COMPANIES = frozenset({"anthropic", "openai", "other"})


@dataclass
class TextBlock:
    text: str


@dataclass
class AssistantMessage:
    content: list


@dataclass
class ResultMessage:
    result: str


class TextOfTest(unittest.TestCase):
    def test_sdk_stream_is_not_doubled(self) -> None:
        j = '{"company": "openai", "topics": ["product"]}'
        out = text_of([AssistantMessage([TextBlock(j)]), ResultMessage(j)])
        self.assertEqual(extract_json(out), {"company": "openai", "topics": ["product"]})

    def test_joins_assistant_blocks(self) -> None:
        self.assertEqual(text_of([AssistantMessage([TextBlock("a"), TextBlock("b")]), ResultMessage("a\nb")]), "a\nb")

    def test_falls_back_to_result_without_assistant_text(self) -> None:
        self.assertEqual(text_of([ResultMessage("only-result")]), "only-result")

    def test_handles_fake_dict(self) -> None:
        self.assertEqual(text_of([{"text": "hi"}, {"text": "there"}]), "hi\nthere")

    def test_ignores_unknown(self) -> None:
        self.assertEqual(text_of([object(), {"nope": 1}]), "")


class ParsePayloadTest(unittest.TestCase):
    def test_tags_valid(self) -> None:
        out = parse_tags_payload(
            {"company": "anthropic", "topics": ["safety", "nope"]},
            allowed_topics=TOPICS,
            valid_companies=COMPANIES,
        )
        self.assertEqual(out, Tags(company="anthropic", topics=("safety",)))

    def test_tags_unknown_company_returns_none(self) -> None:
        self.assertIsNone(
            parse_tags_payload(
                {"company": "acme", "topics": ["safety"]},
                allowed_topics=TOPICS,
                valid_companies=COMPANIES,
            )
        )

    def test_tags_no_valid_topic_returns_none(self) -> None:
        self.assertIsNone(
            parse_tags_payload(
                {"company": "openai", "topics": ["nope"]},
                allowed_topics=TOPICS,
                valid_companies=COMPANIES,
            )
        )

    def test_tldr_clips_text_hard_cap(self) -> None:
        out = parse_tldr_payload({"text": "x" * (TLDR_TEXT_HARD_CAP + 50), "bullets": []})
        self.assertEqual(len(out.text), TLDR_TEXT_HARD_CAP)

    def test_tldr_cleans_bullets(self) -> None:
        out = parse_tldr_payload({"text": "ok", "bullets": ["  a  ", "", "   ", "x" * 500]})
        self.assertEqual(out.bullets, ("a", "x" * MAX_TLDR_BULLET))

    def test_tldr_drops_nonstring_bullets(self) -> None:
        out = parse_tldr_payload({"text": "ok", "bullets": ["a", 3, "b"]})
        self.assertEqual(out.bullets, ("a", "b"))


class ExtractJsonTest(unittest.TestCase):
    def test_plain(self) -> None:
        self.assertEqual(extract_json('{"a": 1}'), {"a": 1})

    def test_fenced(self) -> None:
        self.assertEqual(extract_json('```json\n{"a": 1}\n```'), {"a": 1})

    def test_prose_wrapped(self) -> None:
        self.assertEqual(extract_json('Sure! Here:\n{"a": 1}\nHope that helps'), {"a": 1})

    def test_garbage_returns_none(self) -> None:
        self.assertIsNone(extract_json("no json at all"))


if __name__ == "__main__":
    unittest.main()
