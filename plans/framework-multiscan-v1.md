# Framework Multi-Scan Runtime 0.6.0

## Release contract

- Runtime/tool version: `0.6.0`.
- New capability: `frameworkMultiScanV1`.
- Framework requests must set
  `frameworkTest.executionContract` to
  `tcgen-framework-multiscan-v1`.
- The offline adapter calls `m_xExecute(TRUE)` once, then
  `m_xExecute(FALSE)` once per scan while `m_xIsBusy()` reports busy.
- Each resumed scan advances the pinned STruC++ clock by a deterministic 1 ms;
  the adapter emits this separately so submitted Beckhoff ST stays unchanged.
- Semantic report v2 adds `backend.executionAttempted`; report v1 is unchanged.

## Migration

- Regenerate cached Framework artifacts that do not declare the new contract.
- Update the TcGen-managed Beckhoff runner and the MCP pack together before the
  cloud requires `frameworkMultiScanV1`.
- Rebuild the packaged MCP executable and runtime manifest because the binary,
  descriptor version, and hashes change.
- Do not reuse legacy tests that advance state inside `m_xIsBusy`; move that
  work to the FALSE-trigger branch of `m_xExecute`.

## Compatibility and validation

- Synchronous tests that complete during `m_xExecute(TRUE)` remain compatible.
- Every execute method must declare `VAR_INPUT i_xTrigger : BOOL` and enter
  through a reachable `IF i_xTrigger THEN` initialization branch.
- Multi-scan tests fail closed when they omit a FALSE-trigger resume path,
  mutate state in `m_xIsBusy`, never clear `_xPhaseBusy`, or use anonymous
  inline enum state declarations unsupported by the pinned offline runtime.
- Submitted Framework ST remains byte-identical. The STruC++ execution adapter
  is generated and reported as a separate artifact.
