import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { FrameworkTestConfig, NormalizeRequest, TcGenTestSpec } from "../src/domain/models.js";
import { expectedTransparentBeckhoffSimulation } from "../src/backends/StrucppBackend.js";

export const exampleNames = [
  "adder",
  "external-method",
  "nested-method",
  "external-property",
  "gvl-reference",
  "parameter-list",
  "state-machine",
  "timer",
  "framework-limit-counter",
  "framework-production-main"
];

export type FixtureRequest = NormalizeRequest & { testSpec?: TcGenTestSpec; frameworkTest?: FrameworkTestConfig };

export function fakeSimulationInfoScriptLines(): string[] {
  const simulation = expectedTransparentBeckhoffSimulation();
  const cliInfo = {
    schemaVersion: 1,
    profile: simulation.profile,
    runtimeProfile: simulation.runtimeProfile,
    simulationIdentity: simulation.identity,
    capabilities: [simulation.capability],
    descriptorCount: simulation.descriptorCount,
    supportTypeCount: simulation.supportTypeCount,
    qualified: simulation.qualified,
  };
  return [
    "if (process.argv.includes('--simulation-info')) {",
    `  console.log(${JSON.stringify(JSON.stringify(cliInfo))});`,
    "  process.exit(0);",
    "}",
  ];
}

export function qualifiedCompilerContractFixture(): Record<string, unknown> {
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
        outputs: [{ name: "Q1", type: "BOOL" }],
        inouts: [],
        dominance: "reset"
      },
      {
        name: "SR",
        inputs: [
          { name: "SET1", type: "BOOL", aliases: ["S1"] },
          { name: "RESET", type: "BOOL", aliases: ["R"] }
        ],
        outputs: [{ name: "Q1", type: "BOOL" }],
        inouts: [],
        dominance: "set"
      }
    ]
  };
  const canonical = JSON.stringify(payload);
  return {
    ...payload,
    identity: {
      algorithm: "SHA-256",
      payloadSha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
      payloadBytes: Buffer.byteLength(canonical, "utf8")
    }
  };
}

export function loadRequest(name: string): FixtureRequest {
  return JSON.parse(readFileSync(join("examples", name, "request.json"), "utf8"));
}

export function loadTestFixture(name: string): FixtureRequest {
  return JSON.parse(readFileSync(join("test", "fixtures", name), "utf8"));
}

export function localStrucppRepo(): string | undefined {
  const candidate = resolve("..", "STruCpp");
  return existsSync(join(candidate, "dist", "node", "cli.js")) ? candidate : undefined;
}

export async function withEnv<T>(values: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
