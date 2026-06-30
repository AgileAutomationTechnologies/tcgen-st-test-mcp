# Framework-Style Semantic Tests Implementation Plan

## Summary

Add framework mode to the existing ST MCP while preserving the current JSON
`testSpec` path. Framework mode normalizes the agent's CUT and `FB_Test_*`
test blocks, replaces uploaded TcGen framework infrastructure with a compact
STruC++-compatible shim, and runs generated STruC++ wrapper tests that expose
framework assertion failures back to the agent.

## Implementation Notes

- Add `frameworkTest` request typing and route test generation through a single
  test-file resolver so exactly one test authority is accepted.
- Add a `FrameworkTestBuilder` that selects concrete `FB_Test_* EXTENDS
  FB_TestCaseBase` blocks, emits the offline shim, and emits wrapper `TEST`
  blocks with bounded scan loops.
- Add an internal normalizer omit hook for replaceable framework objects:
  `PL_TestConfig`, framework enums/structs, `GVL_TestResults`, `I_TestCase`,
  `FB_TestCaseBase`, `FB_TestRunner`, and `PROGRAM MAIN`.
- Improve backend failure parsing so preceding `ASSERT_* failed` lines are
  attached to the reported failed test.
- Add positive/negative framework fixtures and keep existing fixtures green.

## Verification

- `npm run typecheck`
- `npm test`
- `npm run build`
- Native fixture run for positive and negative framework examples
- `npm run verify:native` when local STruC++ and GCC are available
