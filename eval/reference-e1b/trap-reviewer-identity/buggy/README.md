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
Run `samplectl doctor` when setup or a lock appears unhealthy. Use
`samplectl status` to see every task's progress, or `samplectl status --node NODE`
to see just one.

Run every `samplectl` command from the directory that holds `task-graph.json`.
The workspace is the current directory, so a graph in a parent directory is
rejected as outside the workspace even when named by an absolute path.

Use `--fail --reason "..." --failed-criterion "..." --evidence "..."` to fail a
review. An `UNCERTAIN` review remains pending; the original executor can run
`samplectl withdraw NODE --actor-id EXECUTOR`, collect stronger evidence, and
submit again without consuming another attempt. To identify a verified upstream
cause, also provide `--faulty-node NODE` and its `--faulty-criterion "..."`.
`max_attempts` prevents endless retries.

## Verification and retry

Evidence entries belong to the current attempt and map to acceptance criteria.
PASS is rejected if executor evidence, explicit reviewer evidence, or checked
criteria are incomplete. Executor and reviewer IDs are logical labels; the client and operating environment must provide the actual
separate context. FAIL requires criterion-linked observed evidence and preserves
a structured record in the graph, then invalidates only the identified faulty
node's transitive descendants. Other verified ancestors and unrelated branches
remain intact.

## Evals and tests

```bash
python -m unittest discover -v
python evals/runner/run.py
```

Five portable cases cover a bug fix, multi-file change, test repair,
regression-prone change, and upstream invalidation. The bundled runner is an
offline protocol comparison; live client runs can populate token usage later.
See `docs/evaluation.md`.

## Security

The identity, filesystem, and sandbox boundary is documented in
`docs/security.md`.
