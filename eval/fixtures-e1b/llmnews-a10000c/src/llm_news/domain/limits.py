"""Size caps for adapter-layer data sanitization (security M-1).

Adapter Sources MUST truncate untrusted external content before yielding a
RawItem so that downstream LLM prompts have bounded input. The actual
truncation helper lives in ``adapters/sources/_clip.py`` — this module only
declares the limits so they can be referenced by tests and reviewers without
pulling the adapter layer.
"""

MAX_TITLE: int = 512
MAX_BODY: int = 8000
MAX_TLDR_TEXT: int = 1000
MAX_TLDR_BULLET: int = 200

# Phase 3 LLM-adapter prompt-input caps. These are tighter than MAX_BODY
# (storage cap) because Anthropic API spend is proportional to prompt tokens
# and we don't need the full 8K body to classify or summarize.
MAX_TAGGER_PROMPT_BODY: int = 4000
MAX_SUMMARIZER_PROMPT_BODY: int = 6000

# Phase 3 LLM-output hard caps. The JSON Schema ``maxLength``/``maxItems`` on
# the submit_tldr tool is advisory to the model only — the Anthropic API does
# not enforce them server-side. These caps clip the model's response at the
# adapter boundary so downstream consumers (storage, renderer) see bounded
# input. Headroom above schema (280 → 400, 3 → 5) absorbs occasional overruns
# without false positives.
TLDR_TEXT_HARD_CAP: int = 400
TLDR_BULLETS_HARD_CAP: int = 5
