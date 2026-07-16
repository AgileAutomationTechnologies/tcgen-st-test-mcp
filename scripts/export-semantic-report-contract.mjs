import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureStartTime = Date.parse("2026-01-01T00:00:00.000Z");
const managedFrameworkTestMarker = "(* TCGEN_VIRTUAL_TESTS_MANAGED_TEST:v1 *)\n";

export async function exportSemanticReportContract(outputPath, options = {}) {
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new Error("An output JSON path is required.");
  }

  const root = options.repositoryRoot ?? repositoryRoot;
  const dependencies = options.dependencies ?? await loadBuiltDependencies(root);
  const packageJson = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8")
  );
  const request = canonicalizeFrameworkSourcePaths(JSON.parse(
    await readFile(resolve(root, "examples", "framework-limit-counter", "request.json"), "utf8")
  ));
  const generated = await dependencies.toolHandlers.tcgen_st_test_generate(request);
  const standardFunctionBlockContracts = dependencies.validateStandardFunctionBlockContracts(
    representativeStandardFunctionBlockContract()
  );
  const fixture = createSemanticReportContractFixture({
    generated,
    packageVersion: packageJson.version,
    testedStrucppVersion: dependencies.testedStrucppVersion,
    standardFunctionBlockContracts,
    buildFrameworkAssertionLedger: dependencies.buildFrameworkAssertionLedger
  });

  const { mcpVersion: _mcpVersion, ...semanticReport } = fixture;
  const validationDiagnostics = dependencies.validateSemanticReport(semanticReport);
  if (validationDiagnostics.length > 0) {
    throw new Error(
      "Exported semantic-report contract fixture is invalid: "
      + validationDiagnostics.map(item => `${item.code}: ${item.message}`).join("; ")
    );
  }

  const absoluteOutputPath = resolve(outputPath);
  await mkdir(dirname(absoluteOutputPath), { recursive: true });
  await writeFile(absoluteOutputPath, serializeSemanticReportContractFixture(fixture), "utf8");
  return { outputPath: absoluteOutputPath, fixture };
}

export function createSemanticReportContractFixture(input) {
  const generated = input.generated;
  if (generated?.testMode !== "framework") {
    throw new Error("The contract fixture must be produced from Framework ST.");
  }
  if (!Array.isArray(generated.assertions) || generated.assertions.length === 0) {
    throw new Error("The contract fixture must contain Framework assertion evidence.");
  }
  if (!Array.isArray(generated.generatedTestNames) || generated.generatedTestNames.length === 0) {
    throw new Error("The contract fixture must contain an executable Framework test.");
  }

  const assertions = generated.assertions.map((assertion, index) => ({
    ...assertion,
    reached: true,
    status: "passed",
    executionEvidence: "assertion_checkpoint_passed",
    startedAt: fixtureTimestamp(index * 2),
    completedAt: fixtureTimestamp(index * 2 + 1)
  }));
  const tests = generated.generatedTestNames.map((name, index) => ({
    name,
    status: "passed",
    startedAt: fixtureTimestamp(assertions.length * 2 + index * 2),
    completedAt: fixtureTimestamp(assertions.length * 2 + index * 2 + 1)
  }));
  const diagnostics = (generated.diagnostics ?? []).map(item => ({ ...item }));
  if (diagnostics.some(item => item.blocking === true)) {
    throw new Error("The source-controlled Framework fixture has blocking generation diagnostics.");
  }

  return {
    mcpVersion: input.packageVersion,
    schemaVersion: 2,
    testMode: "framework",
    coveredExecutableObjects: [...generated.coveredExecutableObjects],
    frameworkTargetCoverage: generated.frameworkTargetCoverage.map(item => ({ ...item })),
    assertions,
    assertionLedger: input.buildFrameworkAssertionLedger(assertions, true),
    artifactIdentities: generated.artifactIdentities.map(item => ({ ...item })),
    generatedTestNames: [...generated.generatedTestNames],
    subject: { ...generated.subject },
    verdict: "passed",
    backend: {
      name: "strucpp",
      executionAttempted: true,
      version: input.testedStrucppVersion,
      standardFunctionBlockContracts: input.standardFunctionBlockContracts,
      standardFunctionBlockContractQualified: true,
      beckhoffSimulation: { ...generated.backend.beckhoffSimulation }
    },
    normalization: generated.normalization,
    summary: {
      passed: tests.length,
      failed: 0,
      skipped: 0,
      compileErrors: 0,
      runtimeErrors: 0,
      timedOut: 0,
      unsupported: 0,
      total: tests.length
    },
    tests,
    diagnostics,
    artifacts: {
      normalizedFiles: generated.normalizedFiles.map(file => ({ ...file })),
      testFile: { ...generated.testFile },
      generatedTestFile: { ...generated.generatedTestFile },
      frameworkTestFiles: generated.frameworkTestFiles.map(file => ({ ...file })),
      stdout: "All representative Framework assertion checkpoints passed.",
      stderr: ""
    },
    hashes: { ...generated.hashes },
    qualification:
      "Deterministic MCP semantic-report contract fixture. It demonstrates the report shape and is not evidence for a user project mutation."
  };
}

export function serializeSemanticReportContractFixture(fixture) {
  return JSON.stringify(fixture, null, 2) + "\n";
}

export function canonicalizeFrameworkSourcePaths(request) {
  const clone = structuredClone(request);
  const mappings = clone.frameworkTest?.targetMappings;
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new Error("The contract fixture request must contain Framework target mappings.");
  }
  if (!Array.isArray(clone.sources)) {
    throw new Error("The contract fixture request must contain source files.");
  }

  const claimedPaths = new Set(clone.sources.map(source => source.path));
  for (const mapping of mappings) {
    const source = clone.sources.find(candidate => candidate.path === mapping.testSourcePath);
    if (!source) {
      throw new Error(
        `Framework source '${String(mapping.testSourcePath)}' for '${String(mapping.testFunctionBlock)}' is missing.`
      );
    }
    const canonicalPath = `virtual-tests/${mapping.testFunctionBlock}.st`;
    if (canonicalPath !== source.path && claimedPaths.has(canonicalPath)) {
      throw new Error(`Canonical Framework source path '${canonicalPath}' is already in use.`);
    }
    claimedPaths.delete(source.path);
    source.path = canonicalPath;
    if (!source.content.startsWith(managedFrameworkTestMarker)) {
      source.content = managedFrameworkTestMarker + source.content;
    }
    mapping.testSourcePath = canonicalPath;
    mapping.testSourceSha256 = createHash("sha256")
      .update(source.content, "utf8")
      .digest("hex");
    claimedPaths.add(canonicalPath);
  }
  return clone;
}

async function loadBuiltDependencies(root) {
  const importBuilt = relativePath => import(pathToFileURL(resolve(root, "dist", relativePath)).href);
  try {
    const [tools, assertions, contracts, validators, backend] = await Promise.all([
      importBuilt("mcp/tools.js"),
      importBuilt("testspec/FrameworkAssertionEvidence.js"),
      importBuilt("backends/StandardFunctionBlockContracts.js"),
      importBuilt("schemas/validators.js"),
      importBuilt("backends/StrucppBackend.js")
    ]);
    return {
      toolHandlers: tools.toolHandlers,
      buildFrameworkAssertionLedger: assertions.buildFrameworkAssertionLedger,
      validateStandardFunctionBlockContracts: contracts.validateStandardFunctionBlockContracts,
      validateSemanticReport: validators.validateSemanticReport,
      testedStrucppVersion: backend.testedStrucppVersion
    };
  } catch (error) {
    throw new Error(
      "Compiled MCP modules are unavailable. Run `npm run build` before invoking the exporter.",
      { cause: error }
    );
  }
}

function representativeStandardFunctionBlockContract() {
  const payload = {
    schema: "tcgen-iec-function-block-contracts-v1",
    contractVersion: "1.0.0",
    library: { name: "iec-standard-fb", version: "1.1.0", namespace: "strucpp" },
    functionBlocks: [
      {
        name: "RS",
        inputs: [
          { name: "SET", type: "BOOL", aliases: ["S"] },
          { name: "RESET1", type: "BOOL", aliases: ["R1"] }
        ],
        outputs: [{ name: "Q1", type: "BOOL", aliases: [] }],
        inouts: [],
        dominance: "reset"
      },
      {
        name: "SR",
        inputs: [
          { name: "SET1", type: "BOOL", aliases: ["S1"] },
          { name: "RESET", type: "BOOL", aliases: ["R"] }
        ],
        outputs: [{ name: "Q1", type: "BOOL", aliases: [] }],
        inouts: [],
        dominance: "set"
      }
    ]
  };
  const canonicalPayload = JSON.stringify(payload);
  return {
    ...payload,
    identity: {
      algorithm: "SHA-256",
      payloadSha256: createHash("sha256").update(canonicalPayload, "utf8").digest("hex"),
      payloadBytes: Buffer.byteLength(canonicalPayload, "utf8")
    }
  };
}

function fixtureTimestamp(offset) {
  return new Date(fixtureStartTime + offset * 1000).toISOString();
}

async function runCli() {
  const outputPath = process.argv[2];
  if (!outputPath || process.argv.length !== 3) {
    console.error("Usage: node scripts/export-semantic-report-contract.mjs <output-json-path>");
    process.exitCode = 2;
    return;
  }
  const result = await exportSemanticReportContract(outputPath);
  console.log(`Exported deterministic MCP ${result.fixture.mcpVersion} semantic-report contract to ${result.outputPath}`);
}

const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedScript === import.meta.url) {
  await runCli();
}
