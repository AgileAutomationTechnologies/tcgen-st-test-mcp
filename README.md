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

Every source-processing request must set `candidateSourcePath` to the exact
`sources[].path` of the staged candidate. Exactly one source must match. Reports
bind that candidate to the result through:

```json
{
  "subject": {
    "candidateSourcePath": "cut.st",
    "candidateSha256": "...",
    "dependencyBundleSha256": "...",
    "discoveredFrameworkTests": ["FB_Test_LimitCounter"],
    "selectedFrameworkTests": ["FB_Test_LimitCounter"]
  }
}
```

Semantic generation and run results use report schema v2. The execution
contract adds explicit coverage and generated-test identity alongside the
candidate/dependency hashes:

```json
{
  "schemaVersion": 2,
  "testMode": "generated",
  "coveredExecutableObjects": ["FB_Adder"],
  "generatedTestNames": ["adds two integers"],
  "hashes": {
    "testSource": "..."
  }
}
```

`testMode` is `generated` for JSON `testSpec` requests and `framework` for
TcGen framework requests. Generated coverage names the declared target POU.
Framework coverage names only the concrete `FB_Test_*` blocks executed by the
offline wrappers; it does not infer production-object coverage. The legacy v1
run contract remains published as
[`schemas/semantic-report-v1.schema.json`](schemas/semantic-report-v1.schema.json).

The candidate hash covers its exact UTF-8 content. The dependency hash covers
`JSON.stringify` of the remaining `{path, content}` entries sorted ordinally by
path and then content, so source-array ordering cannot change the identity.
The packaged
[`schemas/dependency-bundle-hash-vectors.json`](schemas/dependency-bundle-hash-vectors.json)
contract publishes exact canonical JSON and lowercase SHA-256 vectors for
cross-language implementations, including JavaScript-specific escaping and
UTF-8 behavior.

For `tcgen_st_test_run`, `scope` may narrow dependencies but cannot exclude any
object parsed from `candidateSourcePath`. The run report's
`normalization.includedObjects` lists only objects actually emitted into the
compiled source; candidate objects excluded by scope or normalization block the
run.

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

When `options.includeArtifacts` is true, run reports include the generated ST
in `artifacts.generatedTestFile` even when preflight blocks execution. Compiler
stdout, stderr, diagnostics, and assertion messages have terminal control
sequences removed and temporary workspace roots replaced with `<workspace>`.
Non-passing compiler/runtime output is also promoted into structured report
diagnostics so consumers do not need to relay raw artifact streams. An exit-0
backend result with no parsed tests is rejected as `backend_error`.

Every `testSpec.tests[].name` must be unique ignoring case and surrounding
whitespace. Duplicate names block generation and execution because result
evidence must identify each generated test unambiguously.

Framework mode uses:

```json
{
  "frameworkTest": {
    "mode": "tcgen-test-framework",
    "executionContract": "tcgen-framework-multiscan-v1",
    "testFunctionBlocks": ["FB_Test_LimitCounter"],
    "targetMappings": [
      {
        "testFunctionBlock": "FB_Test_LimitCounter",
        "productionTarget": "FB_LimitCounter",
        "testSourcePath": "test.st",
        "testSourceSha256": "<lowercase SHA-256 of the exact test.st content>"
      }
    ],
    "maxScans": 200
  }
}
```

When `testFunctionBlocks` is present it must name every discovered submitted
framework test. To focus a run, submit only the relevant test sources rather
than selecting an arbitrary passing subset. Reports expose both
`discoveredFrameworkTests` and `selectedFrameworkTests` for independent checks.

`targetMappings` is mandatory and one-to-one. Every selected `FB_Test_*` and
every executable object in `candidateSourcePath` must be represented exactly
once. The MCP verifies the exact source path and UTF-8 content SHA-256, confirms
that the test source instantiates or references the production target outside
comments and strings, and requires at least one `m_xAssert*` call over an
observed value rather than a literal-only smoke assertion. Framework runner
registration programs and framework infrastructure are not production targets.

Generation keeps the submitted TwinCAT framework ST byte-for-byte in
`testFile` and `frameworkTestFiles`. The separately generated STruC++ execution
adapter is returned in `generatedTestFile`; `hashes.testSource` identifies that
adapter, while each framework source retains its own trusted mapping hash.
Semantic report v2 publishes the verified identities and structural evidence in
`frameworkTargetCoverage[]` (`assertionCount`, `targetReferenceCount`, and
`verified`). Generate and run tool metadata advertise the
`frameworkTargetCoverageV1` and `frameworkMultiScanV1` capabilities. The
required `tcgen-framework-multiscan-v1` contract calls `m_xExecute(TRUE)` once,
then calls `m_xExecute(FALSE)` once per offline PLC scan while `m_xIsBusy()`
remains true. The offline task interval is deterministic: each resumed scan is
preceded by `ADVANCE_TIME(1000000)` (one millisecond), allowing IEC timers to
progress without introducing STruC++ syntax into the submitted Beckhoff ST.
Synchronous tests that finish on the initial call remain valid. A
multi-scan test must advance work on FALSE-trigger calls; `m_xIsBusy()` reports
state and must not advance the test as a side effect.

The additive `assertions[]` field identifies every meaningful submitted
`m_xAssert*` call by source path, source SHA-256, one-based line, mapped target,
and stable `assertionId`. Generation reports use `status: "not_run"`. An exact
passing wrapper qualifies its rows as passed with `parent_test_passed` evidence
(it does not claim separate per-call instrumentation); a failing wrapper leaves
rows `unknown` unless its backend message uniquely identifies one submitted
assertion description. This conservative evidence is part of report v2 and the existing
`frameworkTargetCoverageV1` capability; report v1 remains unchanged.

In framework mode the MCP normalizes the CUT and agent-authored test FBs and
replaces uploaded framework infrastructure such as `FB_TestRunner`,
`I_TestCase`, `FB_TestCaseBase`, and `GVL_TestResults` with a compact
STruC++-compatible shim. A PROGRAM containing both `FB_TestRunner` and
`m_udiRegisterTest` is structurally recognized as runner registration and
rewritten to a compiled offline registration surrogate; ordinary production
`PROGRAM MAIN` objects remain unchanged. Generated wrapper `TEST` blocks then
execute every concrete `FB_Test_*` instance. A failing assertion is returned as
`verdict: "failed"` with the STruC++ detail in `tests[].message`.
Semantic report v2 also exposes `backend.executionAttempted`, distinguishing a
normalization/preflight rejection from an invocation that reached STruC++.

## Local Development

Use Node.js 22 or later.

```powershell
npm ci
npm run build
npm run bundle
npm run build:exe
```

`npm run bundle` produces the self-contained Node.js 22 MCP runtime at
`dist/tcgen-st-test-mcp.cjs`. It includes runtime dependencies and can be copied
into the TcGen product pack without `node_modules` or a sibling checkout.
`npm run build:exe` additionally produces
`dist/tcgen-st-test-mcp.exe`, a Windows x64 executable containing its own
Node.js 22 runtime. The product launcher should use this executable; the CJS
bundle remains useful for npm and source-development workflows.

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
Inside the standalone MCP executable, a repository/JavaScript STruC++ path also
requires a real external Node executable through `TCGEN_ST_NODE_PATH` or PATH;
the packaged MCP refuses to recursively use itself as Node. Prefer native
`strucpp-win.exe` in product installations, which needs no external Node.

The v0.7 Windows validation target is the AgileAutomationTechnologies STruC++
downstream branch at commit `5068cdf81ee55a9fcf800845c2798793e94da7df`,
based on upstream STruC++ `0.5.13` plus the qualified TcGen downstream patch set,
identified as `0.5.13-tcgen.1`.
Backend checks and semantic runs fail closed when the detected STruC++ version
is missing or differs from the complete `0.5.13-tcgen.1` distribution version.

## Verification

```powershell
npm run verify
npm run verify:native
npm run fixtures
npm run smoke:mcp
npm run pack:check
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
