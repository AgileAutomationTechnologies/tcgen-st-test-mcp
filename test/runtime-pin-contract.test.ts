import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testedStrucppVersion } from "../src/backends/StrucppBackend.js";

const lockedStrucppCommit = "c79da8119301064db3614475dd8b237bdbfd1b16";

describe("native CI runtime pin", () => {
  it("builds and verifies the exact qualified downstream STruC++ runtime", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("repository: AgileAutomationTechnologies/STruCpp");
    expect(workflow).toContain(`STRUCPP_REF: ${lockedStrucppCommit}`);
    expect(workflow).toContain(`STRUCPP_DISTRIBUTION_VERSION: ${testedStrucppVersion}`);
    expect(workflow).toContain(`STRUCPP_EXPECTED_VERSION: ${testedStrucppVersion}`);
    expect(workflow).toContain("npm run build:pkg:win");
    expect(workflow).toContain("npm run smoke:bin -- dist/bin/strucpp-win.exe");
  });
});
