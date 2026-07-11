# Third-Party Notices

## STruC++

This server invokes STruC++ as an external executable. STruC++ is published by
Autonomy / OpenPLC Project under GPL-3.0-or-later:

https://github.com/Autonomy-Logic/STruCpp

The v0.2 compatibility target is STruC++ 0.5.12. The local Windows validation
slice is pinned to the AgileAutomationTechnologies `development` branch at
commit `0a398a643fad44905d2b786f4229e152cef531bd`, including the required
Windows/compiler-launch fixes.

## Ajv

Ajv is used for JSON Schema validation of test specs and reports.

- Project: https://github.com/ajv-validator/ajv
- License: MIT

## TypeScript

TypeScript is used to build this package.

- Project: https://github.com/microsoft/TypeScript
- License: Apache-2.0

## esbuild

esbuild produces the self-contained MCP product bundle.

- Project: https://github.com/evanw/esbuild
- License: MIT

## @yao-pkg/pkg

`@yao-pkg/pkg` packages the MCP bundle with a Node.js 22 runtime for the
standalone Windows executable.

- Project: https://github.com/yao-pkg/pkg
- License: MIT

## Vitest

Vitest is used for the test suite.

- Project: https://github.com/vitest-dev/vitest
- License: MIT

## Node.js Type Definitions

`@types/node` is used for TypeScript type checking.

- Project: https://github.com/DefinitelyTyped/DefinitelyTyped
- License: MIT

## Node.js Runtime

This package runs on Node.js 22 or later.

- Project: https://github.com/nodejs/node
- License: MIT
