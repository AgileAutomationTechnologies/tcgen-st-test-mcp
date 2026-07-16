# Framework assertion ledger v1

Implement the Trace 166 semantic-runtime contract without changing submitted
Framework ST:

1. Load and qualify STruC++ `0.5.13-tcgen.3` against its actual
   compiler-generated, hashed machine-readable IEC function-block sidecar;
   never publish an independently maintained copy.
2. Instrument only the private offline Framework shim. Capture every runtime
   assertion into a bounded ledger while retaining the legacy first-error
   field, then emit stable-ID checkpoint tests. Each checkpoint owns a fresh
   test/CUT instance and reports passed, failed, and not-reached source
   assertions in one backend invocation.
3. Publish the ledger and contract through semantic report v2 and MCP
   capability metadata, and emit request-bound MCP progress notifications
   without forwarding notification tokens to backend children.
4. Keep generated-C++ output as sanitized technical evidence with explicit
   provenance, and cover success, simultaneous failures, conditional
   non-reachability, overflow/incomplete execution, contracts, and progress.
5. Dispatch independent stdio requests concurrently, cache the immutable
   semantic-runtime qualification by runtime generation, and route MCP
   cancellation to only the matching backend child process.
