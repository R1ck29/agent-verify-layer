"""Pure schema parsing/validation shared by all LLM adapters (spec §5.D/§5.E).

Lifted from ClaudeHaiku{Tagger,Summarizer}._extract so a second adapter
cannot drift from the company-enum / hard-cap rules (ADR-002 / ADR-008)."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Callable, Mapping
from typing import Any, cast

from llm_news.domain.limits import TLDR_BULLETS_HARD_CAP, TLDR_TEXT_HARD_CAP
from llm_news.domain.models import TLDR, CompanyName, Tags

# Adapter <-> SDK boundary callable (spec §5.B). Defined here so adapters and
# tests share one type. The concrete message shape is finalized in Phase 1
# (_procode_sdk.py) — this alias only constrains "async iterator of messages".
QueryFn = Callable[[str], AsyncIterator[Any]]


def parse_tags_payload(
    payload: Mapping[str, Any],
    *,
    allowed_topics: frozenset[str],
    valid_companies: frozenset[str],
) -> Tags | None:
    company = payload.get("company")
    topics_raw = payload.get("topics", [])
    if company not in valid_companies:
        return None
    valid_topics = tuple(
        t for t in topics_raw if isinstance(t, str) and t in allowed_topics
    )
    if not valid_topics:
        return None
    return Tags(company=cast(CompanyName, company), topics=valid_topics)


def parse_tldr_payload(payload: Mapping[str, Any]) -> TLDR:
    text_raw = payload.get("text", "")
    bullets_raw = payload.get("bullets", [])
    text = (text_raw if isinstance(text_raw, str) else "")[:TLDR_TEXT_HARD_CAP]
    bullets = tuple(
        b
        for b in list(bullets_raw)[:TLDR_BULLETS_HARD_CAP]
        if isinstance(b, str)
    )
    return TLDR(text=text, bullets=bullets)


def text_of(messages: list[Any]) -> str:
    """Flatten the model's textual output from a message stream.

    Currently handles the ``{"text": ...}`` dicts that the unit-test fake
    ``query_fn`` yields.

    TODO(procode): also read the real claude-agent-sdk stream (spec §5.B):
    ``AssistantMessage`` with ``.content`` = list of blocks that have
    ``.text`` (``TextBlock``), and ``ResultMessage`` with a ``.result`` str
    (the final answer — observed 2026-05-16 to carry the model's JSON/prose).
    """
    parts: list[str] = []
    for m in messages:
        if isinstance(m, dict):
            t = m.get("text")
            if isinstance(t, str):
                parts.append(t)
    return "\n".join(parts)


def extract_json(raw: str) -> dict[str, Any] | None:
    """Defensive JSON extraction (spec §5.E): tolerate fenced / prose-wrapped
    output. Returns None on irrecoverable input — caller treats None exactly
    like an ADR-008 schema violation (feeds the retry loop, not a crash)."""
    try:
        parsed = json.loads(raw.strip())
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if m is None:
        return None
    try:
        parsed = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None
