import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadStandardFunctionBlockContracts,
  unavailableStandardFunctionBlockContracts,
  validateStandardFunctionBlockContracts
} from "../src/backends/StandardFunctionBlockContracts.js";
import { StrucppBackend, testedStrucppVersion } from "../src/backends/StrucppBackend.js";
import { qualifiedCompilerContractFixture, withEnv } from "./helpers.js";

describe("qualified standard function-block contracts", () => {
  it("loads a compiler-contract sidecar and validates its own payload identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcgen-standard-fb-contract-"));
    const path = join(root, "iec-function-block-contracts.json");
    await writeFile(path, JSON.stringify(qualifiedCompilerContractFixture()), "utf8");
    try {
      const loaded = await loadStandardFunctionBlockContracts([path]);
      const contract = loaded.contracts;

      expect(contract.schema).toBe("tcgen-iec-function-block-contracts-v1");
      expect(contract.contractVersion).toBe("1.0.0");
      expect(contract.library).toEqual({
        name: "iec-standard-fb",
        version: "1.1.0",
        namespace: "strucpp"
      });
      expect(contract.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(contract.payloadBytes).toBeGreaterThan(0);
      expect(contract.functionBlocks.length).toBeGreaterThanOrEqual(2);
      expect(contract.functionBlocks.find(block => block.name === "RS")).toEqual({
        name: "RS",
        inputs: [
          { name: "SET", type: "BOOL", aliases: ["S"] },
          { name: "RESET1", type: "BOOL", aliases: ["R1"] }
        ],
        outputs: [{ name: "Q1", type: "BOOL", aliases: [] }],
        inouts: [],
        dominance: "reset"
      });
      expect(contract.functionBlocks.find(block => block.name === "SR")?.dominance).toBe("set");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects altered hashes, aliases, and dominance semantics", () => {
    const fixture = qualifiedCompilerContractFixture() as any;
    expect(() => validateStandardFunctionBlockContracts({
      ...fixture,
      identity: { ...fixture.identity, payloadSha256: "0".repeat(64) }
    })).toThrow(/payloadSha256/);

    const aliasCollision = qualifiedCompilerContractFixture() as any;
    aliasCollision.functionBlocks[0].inputs[1].aliases = ["set"];
    expect(() => validateStandardFunctionBlockContracts(aliasCollision)).toThrow(/collides/i);

    const wrongDominance = qualifiedCompilerContractFixture() as any;
    wrongDominance.functionBlocks[0].dominance = "set";
    expect(() => validateStandardFunctionBlockContracts(wrongDominance)).toThrow(/RS dominance/);
  });

  it("returns an unmistakably unqualified identity when preflight fails closed", async () => {
    await withEnv({
      STRUCPP_PATH: resolve("missing-strucpp.exe"),
      STRUCPP_GPP_PATH: process.execPath
    }, async () => {
      const check = await new StrucppBackend().check();
      expect(check.testedVersion).toBe("0.5.13-tcgen.7");
      expect(testedStrucppVersion).toBe("0.5.13-tcgen.7");
      expect(check.standardFunctionBlockContracts).toEqual(
        unavailableStandardFunctionBlockContracts()
      );
      expect(check.standardFunctionBlockContractQualified).toBe(false);
    });
  });
});
