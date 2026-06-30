import { describe, expect, it } from "vitest";
import { TcGenBundleParser } from "../src/parser/TcGenBundleParser.js";

describe("TcGen ST parser", () => {
  it("parses owner-qualified and nested children", () => {
    const source = `
FUNCTION_BLOCK FB_Axis
VAR
    xBusy : BOOL;
END_VAR

METHOD PRIVATE Reset : BOOL
Reset := TRUE;
END_METHOD

xBusy := FALSE;
END_FUNCTION_BLOCK

METHOD PUBLIC FB_Axis.Start : BOOL
FB_Axis.Start := TRUE;
END_METHOD
`;
    const document = new TcGenBundleParser().parseSources([{ path: "axis.st", content: source }]);
    expect(document.diagnostics.filter(item => item.blocking)).toEqual([]);
    expect(document.objects.map(item => item.qualifiedName)).toContain("FB_Axis");
    expect(document.objects.map(item => item.qualifiedName)).toContain("FB_Axis.Reset");
    expect(document.objects.map(item => item.qualifiedName)).toContain("FB_Axis.Start");
    const owner = document.objects.find(item => item.qualifiedName === "FB_Axis");
    expect(owner?.implementationText).toContain("xBusy := FALSE");
    expect(owner?.implementationText).not.toContain("METHOD PRIVATE Reset");
  });
});
