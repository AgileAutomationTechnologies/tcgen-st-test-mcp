# tcgen-st-test-mcp

Offline semantic validation for TcGen Structured Text review bundles.

This MCP server accepts inline TcGen review-ST sources, normalizes the supported
subset into STruC++-compatible ST, builds either JSON-spec tests or TcGen
framework-style tests, and runs them through the `strucpp` CLI in a temporary
workspace.

Passing results mean only:

> Offline semantic test passed for the normalized STruC++ model. Final TwinCAT
> compilation or target validation may still be required for vendor libraries,
> task behavior, I/O, ADS, motion, lifecycle methods, and runtime-specific
> behavior.

## Tools

- `tcgen_st_backend_check`
- `tcgen_st_normalize`
- `tcgen_st_test_generate`
- `tcgen_st_test_run`

## CLI

```bash
tcgen-st-test backend-check
tcgen-st-test normalize request.json
tcgen-st-test generate request.json
tcgen-st-test run request.json
```

## Test Modes

`tcgen_st_test_generate` and `tcgen_st_test_run` accept exactly one test
authority:

- `testSpec`: the original JSON step format, converted into STruC++ `TEST`
  blocks.
- `frameworkTest`: TcGen/TwinCAT-style ST tests where the request sources include
  the CUT plus concrete `FB_Test_* EXTENDS FB_TestCaseBase` blocks.

Framework mode uses:

```json
{
  "frameworkTest": {
    "mode": "tcgen-test-framework",
    "testFunctionBlocks": ["FB_Test_LimitCounter"],
    "maxScans": 200
  }
}
```

In framework mode the MCP normalizes the CUT and agent-authored test FBs, omits
uploaded framework infrastructure such as `FB_TestRunner`, `I_TestCase`,
`FB_TestCaseBase`, `GVL_TestResults`, and `PROGRAM MAIN`, injects a compact
STruC++-compatible framework shim, then runs generated wrapper `TEST` blocks
against the concrete `FB_Test_*` instances. A failing framework assertion is
returned as `verdict: "failed"` with the STruC++ assertion detail in
`tests[].message`.

## Local Development

Use Node.js 22 or later.

```powershell
npm ci
npm run build
```

For local development against a sibling STruC++ checkout:

```powershell
git clone https://github.com/AgileAutomationTechnologies/STruCpp.git C:\Users\fboid\source\python\STruCpp
cd C:\Users\fboid\source\python\STruCpp
git checkout development

$env:STRUCPP_PATH = "C:\Users\fboid\source\python\STruCpp"
$env:STRUCPP_GPP_PATH = "C:\msys64\ucrt64\bin\g++.exe"
```

`STRUCPP_PATH` may point to a `strucpp` executable, `dist/node/cli.js`, or the
STruC++ repository root. `STRUCPP_GPP_PATH` is optional for backend checks, but
`tcgen_st_test_run` needs a working `g++` for STruC++ `--test` execution.

The v0.1 Windows validation target is the AgileAutomationTechnologies STruC++
`development` branch at commit `0a398a643fad44905d2b786f4229e152cef531bd`,
based on STruC++ `0.5.12` plus AAT Windows/compiler-launch fixes.

## Verification

```powershell
npm run verify
npm run verify:native
npm run fixtures
npm run smoke:mcp
npm pack --dry-run
```

Native verification expects:

```powershell
$env:STRUCPP_PATH = "C:\Users\fboid\source\python\STruCpp"
$env:STRUCPP_GPP_PATH = "C:\msys64\ucrt64\bin\g++.exe"
```

Reference STruC++ checks:

```powershell
cd C:\Users\fboid\source\python\STruCpp
npm run build
npm run typecheck
node dist\node\cli.js --version
node dist\node\cli.js tests\st-validation\function_blocks\fb_accumulator.st --gpp C:\msys64\ucrt64\bin\g++.exe --test tests\st-validation\function_blocks\test_fb_accumulator.st
node dist\node\cli.js tests\st-validation\function_blocks\basic_fb.st --no-default-libs --gpp C:\msys64\ucrt64\bin\g++.exe --test tests\st-validation\function_blocks\test_basic_fb.st
```

## Workspace Retention

Temporary workspaces are deleted by default. `keepWorkspace` only returns a
workspace path when both are true:

- the request sets `options.keepWorkspace = true`;
- the local environment sets `TCGEN_ST_ALLOW_KEEP_WORKSPACE=true`.

Without that environment flag, `keepWorkspace` is ignored and a non-blocking
`SANDBOX_KEEP_WORKSPACE_DISABLED` diagnostic is returned.

## Known STruC++ Limitation

The upstream `basic_fb` sample declares `Toggle`, while bundled OSCAT libraries
also define `TOGGLE`. Run that sample with `--no-default-libs`; use
`fb_accumulator` as the default-library native smoke until library shadowing is
handled upstream.
