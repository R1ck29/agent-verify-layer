# Graph Engineering Agent Harness

A small, vendor-neutral task-state harness for coding and other structured work.
It records an objective as a DAG, code-gates state transitions, requires explicit
executor and reviewer evidence, and retries only affected descendants. The
deterministic core runs locally with Python's standard library and needs no
network, database, or orchestration server.

The CLI is a ledger and verification gate. It does not generate a plan from an
objective, execute task commands, start an AI client, or prove that two IDs are
different people. Codex, Claude Code, another client, or a human performs the
work. Use a separate read-only reviewer session when independence matters.

## Architecture

```text
Objective -> Planner -> Task Graph -> Executor/Specialist -> Reviewer
                                      PASS -> verified
                                      FAIL -> faulty node + descendant invalidation -> retry
```

`sample_harness/` enforces state and evidence. `core/` defines the portable
contract.

New to this? [docs/how-it-works.md](docs/how-it-works.md) explains the whole
repository in plain language, with no programming knowledge assumed.

## Before you start

Requires Python 3.10 or newer.

Do not put passwords, API keys, customer names, contract terms, personal data,
or unredacted client material in graph evidence. Evidence is retained in the
graph and may also remain in shell history. Use repository-relative artifact
references and redacted summaries, as the example below does.

### macOS or Linux installation

```bash
python3 --version
python3 -m venv .venv
. .venv/bin/activate
python -m pip install .
cp examples/quickstart/task-graph.json task-graph.json
```

### Windows PowerShell installation

```powershell
py -3.10 --version
py -3.10 -m venv .venv
.\.venv\Scripts\python.exe -m pip install .
Copy-Item examples\quickstart\task-graph.json task-graph.json
$Graphctl = (Resolve-Path .\.venv\Scripts\samplectl.exe).Path
```

If `py -3.10` is unavailable, install a supported Python release and substitute
the exact interpreter path. Do not rely on an unrelated `python` command that
may point to an older installation.

## Complete quick start

The sample is intentionally non-sensitive and has one node so the walkthrough
finishes with a verified objective.

### macOS or Linux

```bash
samplectl validate
samplectl ready
samplectl start deliverable --executor-id executor-1
samplectl submit deliverable --actor-id executor-1 --evidence "@examples/quickstart/submission-evidence.json" --relevant-file examples/quickstart/deliverable.txt
samplectl review-packet deliverable
samplectl verify deliverable --pass --reviewer-id reviewer-1 --criterion "the deliverable contains a title, intended audience, and next step without customer data" --evidence "@examples/quickstart/review-evidence.json"
samplectl completion-check
```

### Windows PowerShell

```powershell
& $Graphctl validate
& $Graphctl ready
& $Graphctl start deliverable --executor-id executor-1
& $Graphctl submit deliverable --actor-id executor-1 --evidence "@examples/quickstart/submission-evidence.json" --relevant-file examples/quickstart/deliverable.txt
& $Graphctl review-packet deliverable
& $Graphctl verify deliverable --pass --reviewer-id reviewer-1 --criterion "the deliverable contains a title, intended audience, and next step without customer data" --evidence "@examples/quickstart/review-evidence.json"
& $Graphctl completion-check
```

The final command returns `{"complete": true}`. In real use, stop after
`review-packet`, give that packet and the referenced artifacts to a separate
read-only reviewer, and let the reviewer supply the final two arguments.

Create a graph for your own one-step objective with `samplectl init --objective
"..." --criterion "..."`. The command refuses to overwrite an existing graph.
Grow it into a dependency graph with `samplectl add-node NODE --description
"..." --criterion "..." --depends-on EXISTING`, adding each node after the ones
it depends on. A new node starts `blocked` and becomes `ready` once every
dependency is verified. Run `samplectl doctor` when setup or a lock appears
unhealthy.

Run every `samplectl` command from the directory that holds `task-graph.json`.
The workspace is the current directory, so a graph in a parent directory is
rejected as outside the workspace even when named by an absolute path.

Use `--fail --reason "..." --failed-criterion "..." --evidence "..."` to fail a
review. An `UNCERTAIN` review remains pending; the original executor can run
`samplectl withdraw NODE --actor-id EXECUTOR`, collect stronger evidence, and
submit again without consuming another attempt. To identify a verified upstream
cause, also provide `--faulty-node NODE` and its `--faulty-criterion "..."`.
`max_attempts` prevents endless retries.

## Stop hook

`samplectl-claude-stop` is the Claude Code Stop hook. It refuses to let a
session stop while `task-graph.json` in the project has nodes that are not yet
verified. The hook exits immediately when no `task-graph.json` exists.

It reads the Claude Code payload (a JSON object) from standard input. The
project root is `CLAUDE_PROJECT_DIR`, else the payload's `cwd`, else the current
directory. A payload with `stop_hook_active` set is let through. An empty or
unreadable payload is treated as no payload. The hook exits with code 2 when the
graph is incomplete or invalid, when the payload is not a JSON object, and when
it is larger than 1 MiB. `samplectl validate` reports the node and dependency
(`edges`) counts.

## Tests

```bash
python3 -m unittest discover -s tests
```

<!-- VL-EVAL-CANARY-7f3c1a -->
