import { createHash } from "node:crypto";
import {
  BeckhoffVirtualEnvironment,
  BeckhoffVirtualResource,
  BeckhoffVirtualResourceKind,
} from "./models.js";

const resourceKinds = new Set<BeckhoffVirtualResourceKind>([
  "adsSymbol",
  "sandboxFile",
  "motionAxis",
  "fieldbusDevice",
  "registerBank",
  "messageEndpoint",
  "transferEndpoint",
  "opcUaNode",
  "databaseTable",
  "diagnosticParameter",
]);

export function validateVirtualEnvironment(
  input: unknown,
): BeckhoffVirtualEnvironment | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("virtualEnvironment must be an object.");
  }
  const value = input as Record<string, unknown>;
  const allowedTopLevel = new Set([
    "schemaVersion",
    "profile",
    "scanPeriodNanoseconds",
    "monotonicNanoseconds",
    "utcUnixNanoseconds",
    "timeZone",
    "resources",
    "faults",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedTopLevel.has(key)) {
      throw new Error(
        `virtualEnvironment contains unsupported field '${key}'.`,
      );
    }
  }
  if (value.schemaVersion !== 1 || value.profile !== "beckhoff-virtual-v1") {
    throw new Error(
      'virtualEnvironment requires schemaVersion 1 and profile "beckhoff-virtual-v1".',
    );
  }
  for (const field of [
    "scanPeriodNanoseconds",
    "monotonicNanoseconds",
    "utcUnixNanoseconds",
  ]) {
    const number = value[field];
    if (
      number !== undefined &&
      (!Number.isSafeInteger(number) || (number as number) < 0)
    ) {
      throw new Error(
        `virtualEnvironment.${field} must be a non-negative safe integer.`,
      );
    }
  }
  if (value.timeZone !== undefined && typeof value.timeZone !== "string") {
    throw new Error("virtualEnvironment.timeZone must be a string.");
  }
  if (value.resources !== undefined && !Array.isArray(value.resources)) {
    throw new Error("virtualEnvironment.resources must be an array.");
  }
  if (value.faults !== undefined && !Array.isArray(value.faults)) {
    throw new Error("virtualEnvironment.faults must be an array.");
  }

  const seenResources = new Set<string>();
  const resources = (value.resources ?? []).map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(
        `virtualEnvironment.resources[${index}] must be an object.`,
      );
    }
    const resource = raw as Record<string, unknown>;
    if (
      typeof resource.kind !== "string" ||
      !resourceKinds.has(resource.kind as BeckhoffVirtualResourceKind)
    ) {
      throw new Error(
        `virtualEnvironment.resources[${index}].kind is unsupported.`,
      );
    }
    if (typeof resource.key !== "string" || resource.key.length === 0) {
      throw new Error(
        `virtualEnvironment.resources[${index}].key must be non-empty.`,
      );
    }
    if (seenResources.has(resource.key)) {
      throw new Error(
        `virtualEnvironment has duplicate resource key '${resource.key}'.`,
      );
    }
    seenResources.add(resource.key);
    if (resource.kind === "sandboxFile") validateSandboxPath(resource.key);
    if (
      resource.kind === "motionAxis" &&
      (!Number.isSafeInteger(resource.ads) || (resource.ads as number) < 0)
    ) {
      throw new Error(
        `virtualEnvironment.resources[${index}].ads must identify the AXIS_REF ADS value.`,
      );
    }
    return { ...resource } as BeckhoffVirtualResource;
  });

  const faults = (value.faults ?? []).map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`virtualEnvironment.faults[${index}] must be an object.`);
    }
    const fault = raw as Record<string, unknown>;
    if (
      typeof fault.target !== "string" ||
      !/^[A-Za-z_]\w*\.[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(fault.target)
    ) {
      throw new Error(`virtualEnvironment.faults[${index}].target is invalid.`);
    }
    if (
      fault.resourceKey !== undefined &&
      typeof fault.resourceKey !== "string"
    ) {
      throw new Error(
        `virtualEnvironment.faults[${index}].resourceKey must be a string.`,
      );
    }
    for (const field of ["callNumber", "delayScans", "errorId"]) {
      const number = fault[field];
      if (
        number !== undefined &&
        (!Number.isSafeInteger(number) || (number as number) < 0)
      ) {
        throw new Error(
          `virtualEnvironment.faults[${index}].${field} must be a non-negative safe integer.`,
        );
      }
    }
    return { ...fault } as NonNullable<
      BeckhoffVirtualEnvironment["faults"]
    >[number];
  });

  return {
    schemaVersion: 1,
    profile: "beckhoff-virtual-v1",
    ...(value.scanPeriodNanoseconds !== undefined
      ? { scanPeriodNanoseconds: value.scanPeriodNanoseconds as number }
      : {}),
    ...(value.monotonicNanoseconds !== undefined
      ? { monotonicNanoseconds: value.monotonicNanoseconds as number }
      : {}),
    ...(value.utcUnixNanoseconds !== undefined
      ? { utcUnixNanoseconds: value.utcUnixNanoseconds as number }
      : {}),
    ...(typeof value.timeZone === "string" ? { timeZone: value.timeZone } : {}),
    resources,
    faults,
  };
}

function validateSandboxPath(path: string): void {
  if (/^(?:\\\\|\/\/)/.test(path)) {
    throw new Error(
      "virtualEnvironment sandbox files cannot use network shares.",
    );
  }
  const withoutDrive = path.replace(/^[A-Za-z]:[\\/]/, "");
  if (/^[\\/]/.test(withoutDrive)) {
    throw new Error(
      "virtualEnvironment sandbox files cannot use absolute host paths.",
    );
  }
  if (withoutDrive.split(/[\\/]+/).some((segment) => segment === "..")) {
    throw new Error(
      "virtualEnvironment sandbox files cannot traverse outside the sandbox.",
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function virtualEnvironmentSha256(
  environment: BeckhoffVirtualEnvironment,
): string {
  return createHash("sha256")
    .update(canonicalJson(environment), "utf8")
    .digest("hex");
}
