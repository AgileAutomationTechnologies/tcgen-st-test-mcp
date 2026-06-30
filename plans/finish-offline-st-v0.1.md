# Finish Offline ST Semantic Test v0.1

## Goal

Make the current MCP foundation run real STruC++ semantic tests from local
fixtures, using the local STruC++ checkout and a Windows GCC toolchain.

## Implementation Notes

- Resolve STruC++ from `STRUCPP_PATH` as an executable, `dist/node/cli.js`, or
  repository root. Spawn JavaScript CLIs through `node`.
- Resolve test-mode `g++` from `STRUCPP_GPP_PATH`, `PATH`, or the standard MSYS2
  UCRT64 location. Pass it to STruC++ with `--gpp`.
- Add fixture requests that exercise simple FBs, methods, properties, globals,
  parameter constants, scan-state, and timers through `tcgen_st_test_run`.
- Harden only normalizer and backend behavior needed for truthful v0.1 fixture
  results and clear blocking diagnostics.
- Keep MCP tool schemas compatible with the initial v0.1 foundation.

## Verification

- Build STruC++ 0.5.12 from the local checkout and run one native STruC++ test.
- Run ST MCP typecheck, unit tests, build, CLI smokes, and MCP stdio smoke.
- Re-run the existing TcGen pack installer tests and cloud registry policy tests.
