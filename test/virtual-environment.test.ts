import { describe, expect, it } from "vitest";
import {
  validateVirtualEnvironment,
  virtualEnvironmentSha256,
} from "../src/domain/virtualEnvironment.js";
import { toolDefinitions, toolHandlers } from "../src/mcp/tools.js";
import { loadRequest } from "./helpers.js";

describe("Beckhoff virtual environment request contract", () => {
  it("validates the discriminated resources and hashes canonical content", () => {
    const first = validateVirtualEnvironment({
      schemaVersion: 1,
      profile: "beckhoff-virtual-v1",
      resources: [
        { kind: "sandboxFile", key: "C:\\tests\\input.txt", content: "hello" },
        { kind: "motionAxis", key: "axis:1001", ads: 1001, position: 2.5 },
      ],
      faults: [
        {
          target: "Tc2_MC2.MC_MoveAbsolute",
          delayScans: 2,
          errorId: 0xf0000005,
        },
      ],
    })!;
    const reordered = validateVirtualEnvironment({
      profile: "beckhoff-virtual-v1",
      schemaVersion: 1,
      faults: [
        {
          errorId: 0xf0000005,
          delayScans: 2,
          target: "Tc2_MC2.MC_MoveAbsolute",
        },
      ],
      resources: [
        { content: "hello", key: "C:\\tests\\input.txt", kind: "sandboxFile" },
        { position: 2.5, ads: 1001, key: "axis:1001", kind: "motionAxis" },
      ],
    })!;
    expect(virtualEnvironmentSha256(first)).toBe(
      virtualEnvironmentSha256(reordered),
    );
  });

  it("rejects traversal, network shares, duplicate keys and unknown kinds", () => {
    const fixture = (resource: Record<string, unknown>) => ({
      schemaVersion: 1,
      profile: "beckhoff-virtual-v1",
      resources: [resource],
    });
    expect(() =>
      validateVirtualEnvironment(
        fixture({ kind: "sandboxFile", key: "..\\secret" }),
      ),
    ).toThrow(/traverse/);
    expect(() =>
      validateVirtualEnvironment(
        fixture({ kind: "sandboxFile", key: "\\\\server\\share" }),
      ),
    ).toThrow(/network/);
    expect(() =>
      validateVirtualEnvironment(fixture({ kind: "process", key: "cmd" })),
    ).toThrow(/unsupported/);
    expect(() =>
      validateVirtualEnvironment({
        schemaVersion: 1,
        profile: "beckhoff-virtual-v1",
        resources: [
          { kind: "adsSymbol", key: "same" },
          { kind: "opcUaNode", key: "same" },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("publishes fixture provenance in generated reports and tool schemas", async () => {
    const request = loadRequest("adder");
    request.virtualEnvironment = {
      schemaVersion: 1,
      profile: "beckhoff-virtual-v1",
      resources: [{ kind: "adsSymbol", key: "local|MAIN.value", value: 4 }],
      faults: [],
    };
    const response = (await toolHandlers.tcgen_st_test_generate(
      request as unknown as Record<string, unknown>,
    )) as {
      subject: { virtualEnvironmentSha256?: string };
      hashes: { virtualEnvironmentSha256?: string };
    };
    expect(response.subject.virtualEnvironmentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(response.hashes.virtualEnvironmentSha256).toBe(
      response.subject.virtualEnvironmentSha256,
    );
    const runTool = toolDefinitions.find(
      (tool) => tool.name === "tcgen_st_test_run",
    ) as {
      inputSchema: { properties: Record<string, unknown> };
      metadata: { tcgen: { capabilities: string[] } };
    };
    expect(runTool.inputSchema.properties.virtualEnvironment).toBeDefined();
    expect(runTool.metadata.tcgen.capabilities).toContain(
      "beckhoffVirtualEnvironmentV1",
    );
  });
});
