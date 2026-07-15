# Candidate compile preflight v1

The cloud scheduler uses the existing trusted `tcgen_st_test_run` schema with a
deterministic empty-step smoke test to compile the exact normalized production
candidate and dependencies before an agent designs Framework ST.

The run tool advertises `candidateCompilePreflightV1`. The contract guarantees
that candidate-scope coverage remains enabled, the backend is actually invoked,
and semantic report v2 retains exact candidate/dependency identities and
source-provenance diagnostics.

The MCP package and reported server version advance to `0.8.0`. Installer pack
activation is version-qualified, so changed capabilities and bytes must not be
republished under the existing `0.7.0` identity.

Known valid TwinCAT constructs that the pinned STruC++ parser cannot yet parse
are reported as backend compatibility diagnostics rather than candidate-source
failures. They fail closed and require a compiler update; they are not rewritten
or sent to an agent for an avoidance-style production repair.
