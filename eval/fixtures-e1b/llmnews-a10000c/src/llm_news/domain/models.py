from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal

CompanyName = Literal["anthropic", "openai", "google", "meta", "other"]


@dataclass(frozen=True, slots=True)
class RawItem:
    source_id: str
    external_id: str
    url: str
    title: str
    body: str
    published_at: datetime  # tz-aware UTC; Phase 2 adapters enforce
    author: str | None


@dataclass(frozen=True, slots=True)
class Tags:
    company: CompanyName
    topics: tuple[str, ...]  # spec §6: empty topics fall back to ("other",) at Tagger


@dataclass(frozen=True, slots=True)
class TLDR:
    text: str
    bullets: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ProcessedItem:
    raw: RawItem
    tags: Tags
    tldr: TLDR
    processed_at: datetime  # tz-aware UTC


@dataclass(frozen=True, slots=True)
class RenderResult:
    """Outcome of a Renderer.render call.

    ADR-004: every Renderer returns this so callers know where the digest
    landed (filesystem path / Notion page id / URL) plus item count, without
    re-deriving them from the input arguments.
    """

    target_date: date
    location: str
    item_count: int
