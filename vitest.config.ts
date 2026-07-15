import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Native Framework fixtures spawn STruC++, g++, and test executables. Running
    // several files concurrently creates severe Windows CI contention and turns
    // successful semantic runs into arbitrary wall-clock timeouts.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
