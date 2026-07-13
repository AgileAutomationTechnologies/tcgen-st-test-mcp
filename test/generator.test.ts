import { describe, expect, it } from "vitest";
import { TcGenTestSpec } from "../src/domain/models.js";
import { StrucppTestGenerator } from "../src/testspec/StrucppTestGenerator.js";

describe("STruC++ test generator", () => {
  it("emits function block tests from JSON steps", () => {
    const generated = new StrucppTestGenerator().generate({
      schemaVersion: 1,
      name: "adder",
      target: { pouName: "FB_Adder", kind: "FUNCTION_BLOCK", instanceName: "dut" },
      tests: [
        {
          name: "adds",
          steps: [
            { kind: "call", arguments: { A: 2, B: 3 }, cycles: 2 },
            { kind: "expectEquals", path: "$target.Sum", value: 5, message: "sum should match" }
          ]
        }
      ]
    });
    expect(generated.diagnostics).toEqual([]);
    expect(generated.generatedTestNames).toEqual(["adds"]);
    expect(generated.coveredExecutableObjects).toEqual(["FB_Adder"]);
    expect(generated.content).toContain("TEST 'adds'");
    expect(generated.content).toContain("dut : FB_Adder;");
    expect(generated.content.match(/dut\(A := 2, B := 3\);/g)?.length).toBe(2);
    expect(generated.content).toContain("ASSERT_EQ(dut.Sum, 5, 'sum should match');");
  });

  it("rejects invalid schema-shaped input", () => {
    const generated = new StrucppTestGenerator().generate({
      schemaVersion: 1,
      name: "bad",
      target: { pouName: "FB_Bad", kind: "FUNCTION_BLOCK" },
      tests: [{ name: "bad", steps: [{ kind: "advanceTime", nanoseconds: -1 }] }]
    } as TcGenTestSpec);
    expect(generated.content).toBe("");
    expect(generated.generatedTestNames).toEqual([]);
    expect(generated.coveredExecutableObjects).toEqual([]);
    expect(generated.diagnostics.map(item => item.code)).toContain("TCTEST_ADVANCE_TIME");
  });

  it("rejects duplicate test names ignoring case and surrounding whitespace", () => {
    const generated = new StrucppTestGenerator().generate({
      schemaVersion: 1,
      name: "ambiguous",
      target: { pouName: "FB_Adder", kind: "FUNCTION_BLOCK" },
      tests: [
        { name: "Adds values", steps: [{ kind: "call" }] },
        { name: "  adds VALUES  ", steps: [{ kind: "call" }] }
      ]
    });

    expect(generated.content).toBe("");
    expect(generated.generatedTestNames).toEqual([]);
    expect(generated.diagnostics).toContainEqual(expect.objectContaining({ code: "TCTEST_DUPLICATE_NAME", blocking: true }));
  });
});
