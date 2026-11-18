"""Tool-locked claude-agent-sdk boundary (spec §5.A). The ONE place that
talks to the agentic SDK. Everything here is the security perimeter:

- ``tools=[]`` is the LOAD-BEARING primary defense. Verified against the
  SDK source (``_internal/transport/subprocess_cli.py:241-245``): an empty
  ``tools`` list emits ``--tools ""`` to the CLI = an EMPTY base tool set,
  i.e. no tool is exposed to the model at all.
- ``allowed_tools=[]`` is a NO-OP and is kept only as harmless intent
  documentation. Verified against the same source (line 256):
  ``if effective_allowed_tools:`` — an empty list is falsy, so the SDK
  passes NO ``--allowedTools`` flag and the CLI falls back to its default
  (all tools). The original ADR-010 assumption that ``allowed_tools=[]``
  was the primary lock was empirically wrong (Phase 1 / 2026-05-16).
- ``disallowed_tools`` emits ``--disallowedTools`` (line 265) — a real
  denylist, kept as belt-and-suspenders for the named builtins even though
  ``tools=[]`` already empties the base set.
- ``max_turns=1`` emits ``--max-turns 1`` (line 259) — layered structural
  defense: even if a tool were reachable, the agent cannot execute it and
  speak the result back within a single turn.
- ``setting_sources=[]`` blocks the user's ~/.claude project/global
  settings (which can register MCP servers / extra tools).
- ``permission_mode="default"`` never auto-approves a tool call in the
  headless SDK (``bypassPermissions``/``plan`` deliberately NOT used —
  ADR-010(6)).
- ``cwd`` is a fresh per-call ``TemporaryDirectory`` — never the repo root,
  deterministically removed (no ``__del__`` finalizer).

Values pinned in ADR-010(6) against ``claude-agent-sdk==0.2.82``.

The per-call wall-clock timeout (ADR-010(6): 90s) is applied by the calling
adapter's ``_collect`` via ``asyncio.wait_for`` — kept there so the
``QueryFn`` seam stays a plain async-iterator (fakes need no timeout
machinery) while the bound is still enforced on every real call.
"""

from __future__ import annotations

import tempfile
from collections.abc import AsyncIterator
from typing import Any

# Builtin tool names denied as belt-and-suspenders. allowed_tools=[] is the
# real guarantee; this list only matters if a future SDK regresses to
# default-allow.
_DENY = ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Task"]

# Per-call wall-clock cap (seconds). Pinned in ADR-010(6). Imported by the
# adapters for their asyncio.wait_for wrap.
QUERY_TIMEOUT_S = 90.0


def build_locked_options(cwd: str) -> Any:
    """Construct the tool-locked ``ClaudeAgentOptions`` (spec §5.A).

    Pure + importable so the security invariant is asserted by a
    deterministic CI unit test (``tests/unit/test_procode_sdk.py``) that
    feeds this through the real SDK command builder and pins the argv —
    no Pro auth / egress / clean shell required. That CI assertion is the
    LOAD-BEARING gate; the live canary test is a behavioural backstop."""
    from claude_agent_sdk import ClaudeAgentOptions

    return ClaudeAgentOptions(
        tools=[],  # LOAD-BEARING: --tools "" => empty base tool set
        allowed_tools=[],  # no-op (kept as intent doc — see module docstring)
        disallowed_tools=_DENY,  # belt-and-suspenders denylist
        max_turns=1,  # layered: no tool->result->speak within 1 turn
        cwd=cwd,
        permission_mode="default",
        setting_sources=[],
    )


async def tool_locked_query(prompt: str) -> AsyncIterator[Any]:
    """Yield SDK messages for a single-turn, zero-tool completion.

    ``prompt`` is the FULL prompt (system framing + the
    ``<untrusted_article_content>`` delimited body) already assembled by the
    adapter. The model can only emit text — no tool/file/bash/network."""
    from claude_agent_sdk import query

    with tempfile.TemporaryDirectory(prefix="llm_news_procode_") as cwd:
        options = build_locked_options(cwd)
        async for message in query(prompt=prompt, options=options):
            yield message
