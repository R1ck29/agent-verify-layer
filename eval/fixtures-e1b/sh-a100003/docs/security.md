# Security boundary

The core is offline and executes no task commands. `samplectl` accepts JSON and
keeps state plus failure memory in one atomically replaced graph file. CLI and
evaluation-output paths are confined to the current workspace. Symbolic links
and link-like Windows reparse points, including directory junctions, are
rejected; non-redirecting cloud placeholder tags remain usable.

Executor and reviewer IDs enforce logical separation, not cryptographic
identity. A user who can edit the graph can forge either ID or history. Use
separate platform sessions/agents, read-only reviewer permissions, repository
ACLs, and CI review when tamper resistance matters. Never describe graph state
as an authorization, audit-signature mechanism, or proof that a separate human
or agent actually performed the review. A PASS requires reviewer-supplied
criteria and evidence, but the surrounding platform must enforce the fresh
context and read-only reviewer boundary.
