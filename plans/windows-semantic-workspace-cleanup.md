# Windows semantic workspace cleanup

- Wait for bounded process-tree termination before a timed-out or cancelled
  STruC++ invocation settles.
- Place STruC++ child test workspaces under the MCP-owned semantic workspace so
  the outer cleanup remains authoritative after forced termination.
- Retry recursive Windows removal and report a sanitized non-blocking cleanup
  diagnostic without replacing the semantic verdict.
- Cover success, timeout, cancellation, and cleanup-exhaustion behavior without
  deleting historical temporary directories.
