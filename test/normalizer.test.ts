import { describe, expect, it } from "vitest";
import { TcGenToStrucppNormalizer } from "../src/normalizer/TcGenToStrucppNormalizer.js";
import { exampleNames, loadRequest } from "./helpers.js";

describe("TcGen to STruC++ normalizer", () => {
  it.each(exampleNames)("normalizes %s fixture without blocking diagnostics", name => {
    const result = new TcGenToStrucppNormalizer().normalize(loadRequest(name));
    const content = result.normalizedFiles[0]?.content ?? "";
    expect(result.normalization.status).not.toBe("blocked");
    expect(result.normalization.diagnostics.filter(item => item.blocking)).toEqual([]);
    expect(content).toContain("FUNCTION_BLOCK");
  });

  it("injects external methods and rewrites owner-qualified returns", () => {
    const result = new TcGenToStrucppNormalizer().normalize(loadRequest("external-method"));
    const content = result.normalizedFiles[0].content;
    expect(content).toContain("METHOD PUBLIC Start : BOOL");
    expect(content).toContain("Start := TRUE;");
    expect(content).not.toContain("FB_Axis.Start");
    expect(result.normalization.rewrites.map(item => item.ruleId)).toContain("NormalizeChildObjects");
  });

  it("injects external properties", () => {
    const result = new TcGenToStrucppNormalizer().normalize(loadRequest("external-property"));
    const content = result.normalizedFiles[0].content;
    expect(content).toContain("PROPERTY PUBLIC Position : DINT");
    expect(content).toContain("END_GET");
    expect(content).toContain("END_SET");
  });

  it("flattens GVL and parameter-list references outside strings", () => {
    const globals = new TcGenToStrucppNormalizer().normalize(loadRequest("gvl-reference"));
    expect(globals.normalizedFiles[0].content).toContain("GVL_Config__xEnable : BOOL := TRUE;");
    expect(globals.normalizedFiles[0].content).toContain("xOut := GVL_Config__xEnable;");

    const parameters = new TcGenToStrucppNormalizer().normalize(loadRequest("parameter-list"));
    expect(parameters.normalizedFiles[0].content).toContain("PL_Machine__cMaxAxes : DINT := 4;");
    expect(parameters.normalizedFiles[0].content).toContain("nMax := PL_Machine__cMaxAxes;");
  });

  it("blocks selected unsupported syntax and unsafe paths", () => {
    const result = new TcGenToStrucppNormalizer().normalize({
      sources: [
        {
          path: "../unsafe.st",
          content: "FUNCTION_BLOCK FB_Bad\nVAR_CONFIG\nEND_VAR\nEND_FUNCTION_BLOCK\n"
        }
      ]
    });
    expect(result.normalization.status).toBe("blocked");
    expect(result.normalization.diagnostics.map(item => item.code)).toContain("SANDBOX_INVALID_SOURCE_PATH");
    expect(result.normalization.diagnostics.map(item => item.code)).toContain("TCCOMPAT_VAR_CONFIG_UNSUPPORTED");
  });

  it("blocks missing child owners and unknown pragmas in strict mode", () => {
    const result = new TcGenToStrucppNormalizer().normalize({
      sources: [
        {
          path: "bad.st",
          content: "METHOD PUBLIC FB_Missing.Start : BOOL\n{unknown 'pragma'}\nStart := TRUE;\nEND_METHOD\n"
        }
      ]
    });
    expect(result.normalization.status).toBe("blocked");
    expect(result.normalization.diagnostics.map(item => item.code)).toContain("TCRESOLVE_MISSING_OWNER");
    expect(result.normalization.diagnostics.map(item => item.code)).toContain("TCCOMPAT_UNKNOWN_PRAGMA");
  });

  it("blocks selected ACTION and graphical language bodies", () => {
    const result = new TcGenToStrucppNormalizer().normalize({
      sources: [
        {
          path: "unsupported.st",
          content: [
            "FUNCTION_BLOCK FB_Bad LANGUAGE FBD",
            "VAR",
            "END_VAR",
            "END_FUNCTION_BLOCK",
            "",
            "ACTION FB_Bad.Step",
            "END_ACTION"
          ].join("\n")
        }
      ]
    });
    expect(result.normalization.status).toBe("blocked");
    expect(result.normalization.diagnostics.map(item => item.code)).toContain("TCCOMPAT_ACTION_TRANSITION_UNSUPPORTED");
    expect(result.normalization.diagnostics.map(item => item.code)).toContain("TCCOMPAT_LANGUAGE_UNSUPPORTED");
  });
});
