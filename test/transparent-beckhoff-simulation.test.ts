import { describe, expect, it } from "vitest";
import {
  expectedTransparentBeckhoffSimulation,
  testedBeckhoffSimulationIdentity,
} from "../src/backends/StrucppBackend.js";
import { toolDefinitions, toolHandlers } from "../src/mcp/tools.js";
import { loadRequest } from "./helpers.js";

describe("transparent Beckhoff simulation contract", () => {
  it("keeps fixtures and simulator controls out of the advertised tools", () => {
    for (const name of ["tcgen_st_test_generate", "tcgen_st_test_run"]) {
      const definition = toolDefinitions.find((tool) => tool.name === name) as {
        inputSchema: { properties: Record<string, unknown> };
        metadata: { tcgen: { capabilities: string[] } };
      };
      expect(definition.inputSchema.properties.virtualEnvironment).toBeUndefined();
      expect(definition.inputSchema.properties.virtualFixture).toBeUndefined();
      expect(definition.inputSchema.properties.simulationPolicy).toBeUndefined();
      expect(definition.metadata.tcgen.capabilities).toContain(
        "beckhoffVirtualTransparentExecutionV1",
      );
      expect(definition.metadata.tcgen.capabilities).not.toContain(
        "beckhoffVirtualEnvironmentV1",
      );
    }
  });

  it("binds generated evidence to the qualified internal simulator identity", async () => {
    const response = (await toolHandlers.tcgen_st_test_generate(
      loadRequest("adder") as unknown as Record<string, unknown>,
    )) as {
      subject: { beckhoffSimulationIdentity: string };
      hashes: { beckhoffSimulationIdentity: string };
      backend: {
        beckhoffSimulation: ReturnType<
          typeof expectedTransparentBeckhoffSimulation
        >;
      };
    };
    expect(response.subject.beckhoffSimulationIdentity).toBe(
      testedBeckhoffSimulationIdentity,
    );
    expect(response.hashes.beckhoffSimulationIdentity).toBe(
      testedBeckhoffSimulationIdentity,
    );
    expect(response.backend.beckhoffSimulation).toEqual(
      expectedTransparentBeckhoffSimulation(),
    );
  });
});
