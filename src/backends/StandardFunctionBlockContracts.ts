import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  StandardFunctionBlockContract,
  StandardFunctionBlockContracts
} from "../domain/models.js";

export const standardFunctionBlockContractSchema =
  "tcgen-iec-function-block-contracts-v1" as const;
export const standardFunctionBlockContractVersion = "1.0.0" as const;
export const standardFunctionBlockLibraryVersion = "1.1.0" as const;

type CompilerParameter = {
  name?: unknown;
  type?: unknown;
  aliases?: unknown;
};

type CompilerFunctionBlock = {
  name?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  inouts?: unknown;
  dominance?: unknown;
};

type CompilerContract = {
  schema?: unknown;
  contractVersion?: unknown;
  library?: { name?: unknown; version?: unknown; namespace?: unknown };
  functionBlocks?: unknown;
  identity?: { algorithm?: unknown; payloadSha256?: unknown; payloadBytes?: unknown };
};

export type StandardFunctionBlockContractLoad = {
  contracts: StandardFunctionBlockContracts;
  path: string;
  fileSha256: string;
};

/**
 * The report shape stays present on failed preflight for contract stability,
 * but an all-zero identity can never be mistaken for qualified compiler data.
 */
export function unavailableStandardFunctionBlockContracts(): StandardFunctionBlockContracts {
  return {
    schemaVersion: 1,
    schema: standardFunctionBlockContractSchema,
    contractVersion: standardFunctionBlockContractVersion,
    library: {
      name: "iec-standard-fb",
      version: standardFunctionBlockLibraryVersion,
      namespace: "strucpp"
    },
    sha256: "0".repeat(64),
    payloadBytes: 0,
    functionBlocks: []
  };
}

export function copyStandardFunctionBlockContracts(
  source: StandardFunctionBlockContracts = unavailableStandardFunctionBlockContracts()
): StandardFunctionBlockContracts {
  return {
    ...source,
    library: { ...source.library },
    functionBlocks: source.functionBlocks.map(block => ({
      ...block,
      inputs: block.inputs.map(copyParameter),
      outputs: block.outputs.map(copyParameter),
      inouts: block.inouts.map(copyParameter)
    }))
  };
}

export async function loadStandardFunctionBlockContracts(
  candidates: readonly string[]
): Promise<StandardFunctionBlockContractLoad> {
  const uniqueCandidates = [...new Set(candidates.map(candidate => resolve(candidate)))];
  const failures: string[] = [];
  for (const path of uniqueCandidates) {
    try {
      const file = await readFile(path, "utf8");
      return {
        contracts: validateStandardFunctionBlockContracts(JSON.parse(file) as CompilerContract),
        path,
        fileSha256: sha256(file)
      };
    } catch (error) {
      failures.push(
        (error as NodeJS.ErrnoException)?.code === "ENOENT"
          ? "candidate sidecar is missing"
          : error instanceof SyntaxError
            ? "candidate sidecar is not valid JSON"
            : error instanceof Error
              ? error.message
              : "candidate sidecar could not be read"
      );
    }
  }
  throw new Error(
    uniqueCandidates.length === 0
      ? "no compiler contract path could be resolved"
      : `no qualified compiler contract was found (${[...new Set(failures)].join("; ")})`
  );
}

export function standardFunctionBlockContractCandidates(input: {
  executable: string;
  cwd?: string;
  packRoot?: string;
}): string[] {
  const executableDirectory = dirname(resolve(input.executable));
  const candidates = [
    ...(input.packRoot
      ? [join(resolve(input.packRoot), "backend", "libs", "iec-function-block-contracts.json")]
      : []),
    ...(input.cwd
      ? [
          join(resolve(input.cwd), "libs", "iec-function-block-contracts.json"),
          join(resolve(input.cwd), "iec-function-block-contracts.json")
        ]
      : []),
    join(executableDirectory, "libs", "iec-function-block-contracts.json"),
    join(executableDirectory, "..", "..", "libs", "iec-function-block-contracts.json")
  ];
  return [...new Set(candidates.map(candidate => resolve(candidate)))];
}

export async function standardFunctionBlockContractGeneration(
  candidates: readonly string[]
): Promise<string> {
  const entries: unknown[] = [];
  for (const path of [...new Set(candidates.map(candidate => resolve(candidate)))].sort()) {
    try {
      const fileStat = await stat(path);
      entries.push([path.toLowerCase(), fileStat.size, fileStat.mtimeMs, fileStat.ctimeMs]);
    } catch {
      entries.push([path.toLowerCase(), -1, -1, -1]);
    }
  }
  return sha256(JSON.stringify(entries));
}

export function validateStandardFunctionBlockContracts(
  raw: CompilerContract
): StandardFunctionBlockContracts {
  if (!raw || typeof raw !== "object") throw new Error("contract root is not an object");
  rejectUnknownKeys(raw, ["schema", "contractVersion", "library", "functionBlocks", "identity"], "contract root");
  if (raw.schema !== standardFunctionBlockContractSchema) {
    throw new Error(`schema '${String(raw.schema)}' is not ${standardFunctionBlockContractSchema}`);
  }
  if (raw.contractVersion !== standardFunctionBlockContractVersion) {
    throw new Error(
      `contract version '${String(raw.contractVersion)}' is not ${standardFunctionBlockContractVersion}`
    );
  }
  const library = raw.library;
  if (library && typeof library === "object") {
    rejectUnknownKeys(library, ["name", "version", "namespace"], "contract library");
  }
  if (
    library?.name !== "iec-standard-fb"
    || library.version !== standardFunctionBlockLibraryVersion
    || library.namespace !== "strucpp"
  ) {
    throw new Error(
      `library identity '${String(library?.name)}@${String(library?.version)}:${String(library?.namespace)}' is not the qualified iec-standard-fb@${standardFunctionBlockLibraryVersion}:strucpp contract`
    );
  }
  if (!Array.isArray(raw.functionBlocks) || raw.functionBlocks.length === 0) {
    throw new Error("functionBlocks must be a non-empty array");
  }

  const functionBlocks = raw.functionBlocks.map((value, index) =>
    validateFunctionBlock(value as CompilerFunctionBlock, index)
  );
  const blockNames = uniqueCaseInsensitive(
    functionBlocks.map(block => block.name),
    "function-block name"
  );
  if (blockNames.size !== functionBlocks.length) throw new Error("function-block names are not unique");
  validateQualifiedBistable(functionBlocks, "RS", "reset", [
    ["SET", "BOOL", ["S"]],
    ["RESET1", "BOOL", ["R1"]]
  ]);
  validateQualifiedBistable(functionBlocks, "SR", "set", [
    ["SET1", "BOOL", ["S1"]],
    ["RESET", "BOOL", ["R"]]
  ]);

  const payload = {
    schema: raw.schema,
    contractVersion: raw.contractVersion,
    library: {
      name: library.name,
      version: library.version,
      namespace: library.namespace
    },
    functionBlocks: raw.functionBlocks
  };
  const canonicalPayload = JSON.stringify(payload);
  const expectedHash = sha256(canonicalPayload);
  const expectedBytes = Buffer.byteLength(canonicalPayload, "utf8");
  if (raw.identity?.algorithm !== "SHA-256") {
    throw new Error("identity.algorithm must be SHA-256");
  }
  rejectUnknownKeys(
    raw.identity as Record<string, unknown>,
    ["algorithm", "payloadSha256", "payloadBytes"],
    "contract identity"
  );
  if (raw.identity.payloadSha256 !== expectedHash) {
    throw new Error("identity.payloadSha256 does not match the canonical compiler contract payload");
  }
  if (raw.identity.payloadBytes !== expectedBytes) {
    throw new Error("identity.payloadBytes does not match the canonical compiler contract payload");
  }

  return {
    schemaVersion: 1,
    schema: standardFunctionBlockContractSchema,
    contractVersion: standardFunctionBlockContractVersion,
    library: {
      name: "iec-standard-fb",
      version: standardFunctionBlockLibraryVersion,
      namespace: "strucpp"
    },
    sha256: expectedHash,
    payloadBytes: expectedBytes,
    functionBlocks
  };
}

function validateFunctionBlock(value: CompilerFunctionBlock, index: number): StandardFunctionBlockContract {
  if (!value || typeof value !== "object") {
    throw new Error(`functionBlocks[${index}] is not an object`);
  }
  rejectUnknownKeys(
    value,
    ["name", "inputs", "outputs", "inouts", "dominance"],
    `functionBlocks[${index}]`
  );
  const name = requiredIdentifier(value?.name, `functionBlocks[${index}].name`);
  const inputs = validateParameters(value?.inputs, `${name}.inputs`);
  const outputs = validateParameters(value?.outputs, `${name}.outputs`);
  const inouts = validateParameters(value?.inouts, `${name}.inouts`);
  const allNames = [
    ...inputs.flatMap(parameter => [parameter.name, ...parameter.aliases]),
    ...outputs.flatMap(parameter => [parameter.name, ...parameter.aliases]),
    ...inouts.flatMap(parameter => [parameter.name, ...parameter.aliases])
  ];
  uniqueCaseInsensitive(allNames, `${name} pin or alias`);
  const dominance = value?.dominance;
  if (dominance !== undefined && dominance !== "set" && dominance !== "reset") {
    throw new Error(`${name}.dominance must be 'set' or 'reset' when present`);
  }
  return {
    name,
    inputs,
    outputs,
    inouts,
    ...(dominance ? { dominance } : {})
  };
}

function validateParameters(value: unknown, location: string) {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  return value.map((raw, index) => {
    const parameter = raw as CompilerParameter;
    if (!parameter || typeof parameter !== "object") {
      throw new Error(`${location}[${index}] is not an object`);
    }
    rejectUnknownKeys(parameter, ["name", "type", "aliases"], `${location}[${index}]`);
    const name = requiredIdentifier(parameter?.name, `${location}[${index}].name`);
    const type = requiredIdentifier(parameter?.type, `${location}[${index}].type`);
    const aliases = parameter.aliases === undefined
      ? []
      : Array.isArray(parameter.aliases)
        ? parameter.aliases.map((alias, aliasIndex) =>
            requiredIdentifier(alias, `${location}[${index}].aliases[${aliasIndex}]`)
          )
        : (() => { throw new Error(`${location}[${index}].aliases must be an array`); })();
    uniqueCaseInsensitive([name, ...aliases], `${location}[${index}] canonical name or alias`);
    return { name, type, aliases };
  });
}

function validateQualifiedBistable(
  blocks: readonly StandardFunctionBlockContract[],
  name: "RS" | "SR",
  dominance: "set" | "reset",
  inputs: ReadonlyArray<readonly [string, string, readonly string[]]>
): void {
  const block = blocks.find(candidate => candidate.name.toUpperCase() === name);
  if (!block) throw new Error(`qualified ${name} signature is missing`);
  const expectedInputs = inputs.map(([pinName, type, aliases]) => ({
    name: pinName,
    type,
    aliases: [...aliases]
  }));
  if (JSON.stringify(block.inputs) !== JSON.stringify(expectedInputs)) {
    throw new Error(`${name} canonical inputs, aliases, types, or positional order do not match TwinCAT`);
  }
  if (JSON.stringify(block.outputs) !== JSON.stringify([{ name: "Q1", type: "BOOL", aliases: [] }])) {
    throw new Error(`${name} output signature does not match TwinCAT`);
  }
  if (block.inouts.length !== 0) throw new Error(`${name} must not declare VAR_IN_OUT pins`);
  if (block.dominance !== dominance) {
    throw new Error(`${name} dominance '${String(block.dominance)}' is not '${dominance}'`);
  }
}

function requiredIdentifier(value: unknown, location: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${location} is not a valid identifier`);
  }
  return value;
}

function uniqueCaseInsensitive(values: readonly string[], location: string): Set<string> {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) throw new Error(`${location} '${value}' collides case-insensitively`);
    seen.add(normalized);
  }
  return seen;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter(key => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`${location} contains unsupported field(s): ${unknown.join(", ")}`);
  }
}

function copyParameter<T extends { aliases: string[] }>(parameter: T): T {
  return { ...parameter, aliases: [...parameter.aliases] };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
