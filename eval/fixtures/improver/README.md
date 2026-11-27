# improver

改善案（提案の一覧）を検査し、結果を `<out_dir>/improve.json` に記録する小さなライブラリです。

- `improver.report.write_candidate(out_dir, built, run_id)`
- `improver.problems.format_problems(problems)`
- テスト: `python3 -m unittest discover -s tests`

## 記録の方針

- 検査を通った案は、提案の本文（`old` / `new` / `reason`）と `notes` を含めて記録する。
- 検査で見送った案の `improve.json` には、提案の本文（`old` / `new` / `reason`）と `notes` を残さない。
  これらは元の依頼の文面の写しを含みうるため。提案の id・kind・file・op・fixes だけを残す。
