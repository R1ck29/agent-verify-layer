from collections.abc import Iterable, Sequence
from datetime import date, datetime
from typing import Protocol, runtime_checkable

from llm_news.domain.models import (
    TLDR,
    ProcessedItem,
    RawItem,
    RenderResult,
    Tags,
)


@runtime_checkable
class Source(Protocol):
    source_id: str

    def fetch(self, since: datetime) -> Iterable[RawItem]:
        """Yield items published at or after ``since``.

        Contract (ADR-007): ``since`` MUST be a tz-aware UTC datetime.
        Implementations call ``adapters.sources._clip.require_aware_since``
        eagerly so a naive datetime fails at the call site, not on first
        iteration.

        Error policy (ADR-006): transport / HTTP / SDK failures propagate
        to the caller; the Pipeline wraps each Source in a single
        try/except so behaviour is uniform across implementations.
        """
        ...


@runtime_checkable
class Tagger(Protocol):
    def tag(self, item: RawItem) -> Tags:
        """Classify ``item`` into a company + topic tuple.

        Failure policy (ADR-008): transport / SDK exceptions propagate; the
        Pipeline catches per-item (Phase 4). Schema violations stay in-class
        and degrade to ``Tags(company="other", topics=("other",))`` after
        the adapter's own retry budget — that fallback is a normal storage
        state, NOT a retry signal for the Pipeline.
        """
        ...


@runtime_checkable
class Summarizer(Protocol):
    def summarize(self, item: RawItem) -> TLDR:
        """Produce a 1-2 sentence TLDR + up to 3 bullets.

        Failure policy (ADR-008): transport failures propagate; schema /
        empty-body cases degrade to ``TLDR(text="", bullets=())``. The
        Renderer treats empty TLDR as "title only, no bullets".
        """
        ...


@runtime_checkable
class Storage(Protocol):
    def exists(self, source_id: str, external_id: str) -> bool:
        """Has this ``(source_id, external_id)`` been persisted?

        Used by the Pipeline to skip dedup-hits before paying LLM tokens.
        """
        ...

    def upsert(self, item: ProcessedItem) -> None:
        """Insert or replace ``item`` (UNIQUE on ``(source_id, external_id)``)."""
        ...

    def list_for_jst_date(self, jst_date: date) -> list[ProcessedItem]:
        """Return items whose ``processed_at`` falls within jst_date in JST.

        ADR-003 (Phase 6 update, architect M-1): the digest filename axis,
        the pipeline rendering axis, and this storage query axis are ALL
        JST. The pipeline computes ``now.astimezone(JST).date()`` and passes
        it here; the operator who types ``llm-news render --date 2026-05-11``
        gets back the SAME items the production pipeline rendered into
        ``docs/digest/2026-05-11.md``.

        Boundary: ``jst_date`` is interpreted as the half-open interval
        ``[jst_date 00:00 JST, (jst_date+1) 00:00 JST)`` so an item processed
        at exactly JST midnight belongs to the new day (the cron's typical
        21:00 UTC firing = 06:00 JST is comfortably inside this window).

        Idempotent re-run (architect M-3): the JST date of ``now`` is
        invariant for the same cron firing — a retry within the same JST day
        sees the same set of items, including those persisted by the first
        attempt before failure. The cross-JST-day anomaly recovery (state
        not advanced, cron fires the next day) has the same loss-window
        characteristic as the previous UTC axis; the spec §6 trade-off
        ("他 Source 継続") is unchanged.
        """
        ...


@runtime_checkable
class Renderer(Protocol):
    def render(
        self,
        items: list[ProcessedItem],
        target_date: date,
        *,
        failed_sources: Sequence[str] = (),
    ) -> RenderResult:
        """Emit the digest for ``target_date`` (JST) listing ``items``.

        ADR-006 / spec §6 / §10: when one or more Sources failed during the
        run, the Pipeline passes their ``source_id`` strings here so the
        Markdown footer can surface ``⚠️ Fetch failures: ...`` — a Phase 5
        GHA workflow scrapes that marker to file Issues. Default ``()``
        keeps the manual ``llm-news render --date ...`` rebuild path
        backward-compatible (no failure context available offline).
        """
        ...
