# Project guide

`sample_harness/` is a small standard-library Python package that keeps a task
graph in one JSON file; `samplectl` (`sample_harness/cli.py`) is its CLI.

- Run the tests from the repository root with `python3 -m unittest discover -s tests`.
- Run `samplectl` from the directory that holds `task-graph.json`
  (`python3 scripts/samplectl.py` in a source checkout).
- Keep the package dependency-free (standard library only).
