"""Adapter-layer helpers shared across Source implementations.

* ``clip_raw`` — title/body truncation (security M-1, advisor 2026-05-11).
* ``require_aware_since`` — fail-fast tz-aware guard for ``Source.fetch(since)``
  (ADR-007, Phase 2 architect H-2).

All Source.fetch() implementations must funnel untrusted external content
through ``clip_raw`` before yielding so downstream prompts have bounded
input, and call ``require_aware_since`` on entry so naive datetimes raise
at call time rather than during iteration.

Domain (``llm_news.domain``) intentionally does NOT depend on this module —
truncation and contract enforcement are adapter-layer policies.
"""

from datetime import datetime

from llm_news.domain.limits import MAX_BODY, MAX_TITLE
from llm_news.domain.models import RawItem


def require_aware_since(since: datetime) -> datetime:
    """Reject naive datetimes immediately (ADR-007).

    Source.fetch is contracted to receive a tz-aware UTC datetime. If the
    Pipeline ever passes ``datetime(2026, 5, 10)``, we want the failure at
    call site, not buried inside the first ``published_at < since`` compare
    on the third iteration.
    """
    if since.tzinfo is None:
        raise ValueError(
            "Source.fetch(since=...) requires a tz-aware datetime; got naive"
        )
    return since


def clip_raw(
    *,
    source_id: str,
    external_id: str,
    url: str,
    title: str,
    body: str,
    published_at: datetime,
    author: str | None,
) -> RawItem:
    """Build a RawItem with title/body truncated to domain limits.

    Whitespace is stripped from title/body before clipping so that trailing
    boilerplate (e.g. "\\n\\n\\n") does not eat the cap budget.
    """
    return RawItem(
        source_id=source_id,
        external_id=external_id,
        url=url,
        title=title.strip()[:MAX_TITLE],
        body=body.strip()[:MAX_BODY],
        published_at=published_at,
        author=author,
    )
