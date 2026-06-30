import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FrameworkTestConfig, NormalizeRequest, TcGenTestSpec } from "../src/domain/models.js";

export const exampleNames = [
  "adder",
  "external-method",
  "nested-method",
  "external-property",
  "gvl-reference",
  "parameter-list",
  "state-machine",
  "timer",
  "framework-limit-counter"
];

export type FixtureRequest = NormalizeRequest & { testSpec?: TcGenTestSpec; frameworkTest?: FrameworkTestConfig };

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
