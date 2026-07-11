# Candidate-Bound Semantic Reports and Product Bundle

## Summary

Bind every normalize, generate, and run result to one explicitly identified
candidate source. Report an internally computed candidate hash, a canonical
dependency-bundle hash, and the selected framework tests so TcGen can verify
that a passing result authorizes only the staged candidate that was tested.

## Implementation Notes

- Require `candidateSourcePath` and resolve it against exactly one inline
  source; block missing, unmatched, or duplicate identities before execution.
- Centralize subject/hash calculation in the normalizer and carry selected
  framework-test names through test resolution into generated and run reports.
- Update TypeScript contracts, MCP input schemas, published JSON report
  schemas, examples, fixtures, and schema/hash/framework regression tests.
- Improve the framework wrapper so busy tests receive bounded repeated scans
  and keep the existing non-vacuous assertion requirement.
- Add an esbuild product target at `dist/tcgen-st-test-mcp.cjs` and verify the
  self-contained file is present in `npm pack --dry-run` output.
- Package the CJS server with Node.js 22 as `dist/tcgen-st-test-mcp.exe`, smoke
  its stdio protocol in isolation, and require an external Node only when that
  executable is configured to use a JavaScript rather than native STruC++ CLI.

## Verification

- `npm run typecheck`
- `npm test`
- `npm run bundle`
- `npm run verify:native`
- `npm run pack:check`
