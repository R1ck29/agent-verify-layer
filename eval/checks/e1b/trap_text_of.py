"""E1b trap-text-of（llm-news a10000e）: SDK のメッセージ列（assistant の text と最後の result）から回答を取り出すとき、同じ文章を二重にしない。"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from hidden import Fail, run_py, UTF8_ENV  # noqa: E402

FIXTURE = "llmnews-a10000c"
ITEM = "concat-sources-overlap"

# claude-agent-sdk の実物と同じ名前・属性の最小の代役（SDK は入っていない）。標準出力の最終行に JSON を出す。
_PRELUDE = r'''
import sys, json
sys.path.insert(0, "src")
from dataclasses import dataclass, field
from datetime import UTC, datetime

@dataclass
class TextBlock:
    text: str
@dataclass
class AssistantMessage:
    content: list
    model: str = "claude-haiku-4-5"
@dataclass
class SystemMessage:
    subtype: str
    data: dict = field(default_factory=dict)
@dataclass
class ResultMessage:
    subtype: str
    result: str = None
    is_error: bool = False
    num_turns: int = 1

def stream(text):
    return [SystemMessage("init", {"session_id": "s"}), AssistantMessage([TextBlock(text)]), ResultMessage("success", text)]
'''

_TRAP = _PRELUDE + r'''
from llm_news.adapters.llm._schema import text_of, extract_json
from llm_news.adapters.llm.claude_code_tagger import ClaudeCodeTagger
from llm_news.adapters.llm.claude_code_summarizer import ClaudeCodeSummarizer
from llm_news.domain.models import RawItem, Tags
out = {}
j = '{"company": "openai", "topics": ["product"]}'
out["direct"] = extract_json(text_of(stream(j)))
item = RawItem("blog:x", "1", "https://x", "t", "body text", datetime(2026, 5, 15, tzinfo=UTC), None)
def q(text):
    async def _q(prompt):
        for m in stream(text):
            yield m
    return _q
out["tag"] = list(ClaudeCodeTagger(allowed_topics={"product", "safety"}, query_fn=q(j)).tag(item).topics) + [ClaudeCodeTagger(allowed_topics={"product", "safety"}, query_fn=q(j)).tag(item).company]
t = ClaudeCodeSummarizer(query_fn=q('{"text": "A tight summary.", "bullets": ["x", "y"]}')).summarize(item)
out["sum"] = [t.text, list(t.bullets)]
print(json.dumps(out))
'''


def sdk_stream_not_doubled(head):
    out = json.loads(run_py(_TRAP, head, UTF8_ENV))
    if out["direct"] != {"company": "openai", "topics": ["product"]}:
        raise Fail("assistant の text と result が同じ内容のストリームから text_of が JSON として読める文字列を返さない（内容が二重になっている等）")
    if out["tag"] != ["product", "openai"]:
        raise Fail(f"ClaudeCodeTagger が SDK のメッセージ列からタグを取れない: {out['tag']}")
    if out["sum"] != ["A tight summary.", ["x", "y"]]:
        raise Fail(f"ClaudeCodeSummarizer が SDK のメッセージ列から TLDR を取れない: {out['sum']}")


# 回答の文が assistant 側にない流れ（エラーや拒否で ResultMessage だけが来る）。result を回答として使うこと
_RESULT_ONLY = _PRELUDE + r'''
from llm_news.adapters.llm._schema import text_of, extract_json
j = '{"company": "openai", "topics": ["product"]}'
out = {
    "only": extract_json(text_of([SystemMessage("init"), ResultMessage("success", j)])),
    "empty": extract_json(text_of([SystemMessage("init"), AssistantMessage([TextBlock("")]), ResultMessage("success", j)])),
    "fake": text_of([{"text": "hi"}, {"text": "there"}]),
}
print(json.dumps(out))
'''


def sdk_result_only(head):
    out = json.loads(run_py(_RESULT_ONLY, head, UTF8_ENV))
    want = {"company": "openai", "topics": ["product"]}
    if out["only"] != want or out["empty"] != want:
        raise Fail("assistant の文がなく ResultMessage だけに回答がある流れで、text_of が回答を返さない")
    if out["fake"] != "hi\nthere":
        raise Fail(f"テスト用 fake の辞書の読み方が変わった: {out['fake']!r}")


_RENDER = r'''
import sys, json, tempfile
sys.path.insert(0, "src")
from datetime import UTC, date, datetime
from pathlib import Path
from llm_news.adapters.renderer.markdown_renderer import MarkdownRenderer
from llm_news.domain.models import TLDR, ProcessedItem, RawItem, Tags
raw = RawItem("s", "1", "https://example.com/a", "Title", "", datetime(2026, 4, 8, tzinfo=UTC), None)
it = ProcessedItem(raw, Tags("anthropic", ("agents",)), TLDR("the tldr", ("first point", "[click](http://evil.example)", "third")), datetime(2026, 5, 10, tzinfo=UTC))
with tempfile.TemporaryDirectory() as tmp:
    MarkdownRenderer(tmp).render([it], date(2026, 5, 10), now=datetime(2026, 5, 10, 21, tzinfo=UTC))
    print(json.dumps((Path(tmp) / "2026-05-10.md").read_text(encoding="utf-8")))
'''


def renderer_bullets(head):
    text = json.loads(run_py(_RENDER, head, UTF8_ENV))
    for w in ("first point", "third", "the tldr"):
        if w not in text:
            raise Fail(f"日報に {w!r} が出ていない")
    if "[click](" in text:
        raise Fail("bullets のリンク記法が無効化されていない")
    if text.index("the tldr") > text.index("first point"):
        raise Fail("bullets が TLDR の後ろに出ていない")


_TLDR = r'''
import sys, json
sys.path.insert(0, "src")
from llm_news.adapters.llm._schema import parse_tldr_payload
from llm_news.domain.limits import MAX_TLDR_BULLET
out = parse_tldr_payload({"text": "t", "bullets": ["  a  ", "", "   ", "x" * 500, "b"]})
print(json.dumps([list(out.bullets), MAX_TLDR_BULLET]))
'''


def tldr_bullets(head):
    bullets, cap = json.loads(run_py(_TLDR, head, UTF8_ENV))
    if len(bullets) != 3 or bullets[0] != "a" or bullets[2] != "b":
        raise Fail(f"bullets の空白除去・空要素の除外が仕様どおりでない: {[b[:10] for b in bullets]}")
    if len(bullets[1]) > cap or not bullets[1].startswith("x" * 150):
        raise Fail(f"長い bullet が {cap} 文字以内に切られていない（{len(bullets[1])} 文字）")


_RETRY = r'''
import sys
sys.path.insert(0, "src")
from llm_news.adapters.llm.claude_code_tagger import ClaudeCodeTagger
ClaudeCodeTagger(allowed_topics={"a"}, schema_max_retries=0)
try:
    ClaudeCodeTagger(allowed_topics={"a"}, schema_max_retries=-1)
except ValueError:
    print("ValueError")
else:
    print("no error")
'''


def tagger_negative_retries(head):
    if run_py(_RETRY, head, UTF8_ENV) != "ValueError":
        raise Fail("schema_max_retries が負でも ValueError にならない")


CHECKS = [
    ("sdk_stream_not_doubled", sdk_stream_not_doubled, True),
    ("sdk_result_only", sdk_result_only, False),
    ("renderer_bullets", renderer_bullets, False),
    ("tldr_bullets", tldr_bullets, False),
    ("tagger_negative_retries", tagger_negative_retries, False),
]
