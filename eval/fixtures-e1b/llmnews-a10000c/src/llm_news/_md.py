"""Shared Markdown text helpers. Promoted from markdown_renderer (spec §5.H):
compare output and the digest renderer both feed attacker-influenced model
text into git-tracked Markdown, so the escaper must be one shared unit.
Behaviour is byte-identical to the original renderer-private helpers —
this promotion intentionally does NOT strengthen the escaping."""

from __future__ import annotations


def strip_newlines(text: str) -> str:
    """Collapse all whitespace (including newlines, tabs, runs of spaces) to single spaces."""
    return " ".join(text.split())


def md_escape(text: str) -> str:
    """Escape Markdown link control chars in trusted-format display text."""
    return (
        strip_newlines(text)
        .replace("\\", "\\\\")
        .replace("[", "\\[")
        .replace("]", "\\]")
    )
