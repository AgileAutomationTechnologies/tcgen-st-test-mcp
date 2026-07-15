# Trusted Framework Target Coverage

## Summary

Bind each submitted TwinCAT framework test function block to its exact source
and production target, while keeping the agent-authored framework ST distinct
from the generated STruC++ execution adapter.

## Implementation Notes

- Require complete `frameworkTest.targetMappings` identities and validate test
  selection, source SHA-256, production-target existence/use, and meaningful
  framework assertions before generation or execution.
- Publish verified `frameworkTargetCoverage` evidence in semantic report v2 and
  advertise `frameworkTargetCoverageV1` in MCP tool metadata.
- Expose exact submitted framework sources as the primary artifacts and retain
  the generated wrapper as a separate execution-adapter artifact.
- Update TypeScript contracts, MCP schemas, published JSON schemas, examples,
  documentation, and focused contract/failure tests.

## Verification

- `npm run typecheck`
- `npm test`
- `npm run bundle`
