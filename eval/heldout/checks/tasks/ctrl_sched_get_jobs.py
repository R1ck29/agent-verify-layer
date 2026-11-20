# VL-EVAL-CANARY-7f3c1a: 評価の採点・参照解の印。解答のトランスクリプトに出たら、その試行は INVALID（eval/tools/leak_check.py）
"""held-out 対照 ctrl-sched-get-jobs（schedule）: Scheduler.get_jobs(tag=None) と schedule.get_jobs(tag=None)。罠なし。"""
from _common import Fail, probe

FIXTURE = "schedule-a6fdc61"

_PROBE = r'''
import json
import schedule
def job(): pass
s = schedule.Scheduler()
a = s.every().second.do(job).tag("db", "nightly")
b = s.every().minute.do(job).tag("db")
c = s.every().hour.do(job)
out = [s.get_jobs() == [a, b, c], s.get_jobs("db") == [a, b], s.get_jobs("nightly") == [a], s.get_jobs("none") == []]
got = s.get_jobs(); got.clear()
out.append(len(s.jobs) == 3)        # 返したリストを変えても Scheduler には影響しない
d = schedule.every().day.do(job).tag("x")
out += [schedule.get_jobs("x") == [d], d in schedule.get_jobs()]
print(json.dumps(out))
'''


def get_jobs(head):
    got = probe(head, _PROBE)
    names = ["全部", "tag=db", "tag=nightly", "該当なし", "コピーを返す", "schedule.get_jobs(tag)", "schedule.get_jobs()"]
    bad = [n for n, ok in zip(names, got) if not ok]
    if bad:
        raise Fail(f"get_jobs が期待と違う: {bad}")


CHECKS = [("get-jobs", get_jobs, False)]
