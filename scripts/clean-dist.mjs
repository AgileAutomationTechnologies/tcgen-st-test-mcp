import { rmSync } from "node:fs";
import { resolve } from "node:path";

// TypeScript does not remove outputs for deleted source modules. Always build
// release artifacts from an empty directory so retired agent-facing contracts
// cannot remain in the package by accident.
rmSync(resolve("dist"), { recursive: true, force: true });
