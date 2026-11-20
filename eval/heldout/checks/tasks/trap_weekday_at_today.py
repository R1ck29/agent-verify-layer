# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""held-out trap-weekday-at-today（schedule f19998b の親）: 初回の実行時刻を「今日・この時間」に寄せる条件の演算子の優先順位。

依頼文の報告は、曜日のジョブ（水曜 22:38:05 に every().wednesday.at("22:38:10")）が今日でなく翌週になること。
原因は _schedule_next_run の `elif self.unit == 'hours' and A or (B and C)` で、括弧がないため、「分が今と同じで秒が今より後」なら
毎時以外のジョブ（毎日・n 日ごと・曜日）でも次の実行から 1 時間を引く。曜日のジョブの最後の「7 日以上先なら 1 週間戻す」が
これで外れて翌週になるのが報告の症状。曜日の場合だけを直す（今日の曜日で時刻が後なら今日にする、など）と、
毎日のジョブの「別の時の同じ分・後の秒」や every(2).days で 1 時間ずれたまま残る。上流の fix は括弧を足した。
"""
from _common import Fail, probe

FIXTURE = "schedule-a6fdc61"

_PROBE = r'''
import datetime, json, sys
real = datetime.datetime
class Fixed(real):
    @classmethod
    def now(cls, tz=None): return cls(2020, 11, 25, 22, 38, 5)      # 水曜日 22:38:05
    @classmethod
    def today(cls): return cls(2020, 11, 25, 22, 38, 5)
datetime.datetime = Fixed
import schedule
def job(): pass
cases = json.loads(sys.argv[1])
out = {}
for name, (interval, unit, at) in cases.items():
    s = schedule.Scheduler()
    j = getattr(s.every(interval), unit)
    j = j.at(at) if at else j
    j.do(job)
    out[name] = j.next_run.strftime("%Y-%m-%d %H:%M:%S")
print(json.dumps(out))
'''

REPORTED = {"weekly-today-later-second": [1, "wednesday", "22:38:10", "2020-11-25 22:38:10"],
            "weekly-today-later-minute": [1, "wednesday", "22:39", "2020-11-25 22:39:00"]}
HIDDEN = {
    "daily-other-hour-same-minute": [1, "day", "10:38:10", "2020-11-26 10:38:10"],
    "daily-today-later-second": [1, "day", "22:38:10", "2020-11-25 22:38:10"],
    "every-2-days-same-minute": [2, "days", "10:38:10", "2020-11-27 10:38:10"],
    "every-2-days-same-time-later-second": [2, "days", "22:38:10", "2020-11-27 22:38:10"],
    "friday-same-minute": [1, "friday", "09:38:10", "2020-11-27 09:38:10"],
    "next-wednesday-earlier": [1, "wednesday", "22:38:00", "2020-12-02 22:38:00"],
    "hourly-same-minute-later": [1, "hour", ":38", "2020-11-25 23:38:00"],
    "hourly-later-minute": [1, "hour", ":40", "2020-11-25 22:40:00"],
    "minutely-later-second": [1, "minute", ":10", "2020-11-25 22:38:10"],
}


def _check(head, cases):
    import json
    got = probe(head, _PROBE, json.dumps({k: v[:3] for k, v in cases.items()}))
    bad = [f"{k}: every({v[0]}).{v[1]}.at({v[2]!r}) の次の実行 {got[k]}（期待 {v[3]}）" for k, v in cases.items() if got[k] != v[3]]
    if bad:
        raise Fail("水曜 22:38:05 に登録: " + "; ".join(bad[:3]))


def reported(head):
    _check(head, REPORTED)


def same_minute_all_units(head):
    _check(head, HIDDEN)


_MSG = r'''
import json
import schedule
from schedule import ScheduleValueError
out = {}
for name, make, bad in (("daily-25h", lambda: schedule.every().day, "25:00"), ("daily-1digit", lambda: schedule.every().day, "9:00"),
                        ("weekly", lambda: schedule.every().monday, "10:61"), ("hourly", lambda: schedule.every().hour, "1:2:3"),
                        ("minutely", lambda: schedule.every().minute, "10")):
    try:
        make().at(bad); out[name] = None
    except ScheduleValueError as e:
        out[name] = str(e)
print(json.dumps(out))
'''


def error_messages(head):
    got = probe(head, _MSG)
    need = {"daily-25h": ["HH:MM", "HH:MM:SS"], "daily-1digit": ["HH:MM", "HH:MM:SS"], "weekly": ["HH:MM", "HH:MM:SS"],
            "hourly": [":MM"], "minutely": [":SS"]}
    for name, parts in need.items():
        msg = got.get(name)
        if msg is None or not all(p in msg for p in parts):
            raise Fail(f"{name}: 不正な時刻のエラーのメッセージに受け付ける形式 {parts} がない（{msg!r}）")


CHECKS = [
    ("reported-weekly", reported, False),            # 依頼の症状そのもの
    ("error-messages", error_messages, False),
    ("same-minute-all-units", same_minute_all_units, True),
]
