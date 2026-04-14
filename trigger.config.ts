import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  // TODO: Replace with your new trigger.dev project ID
  project: "proj_REPLACE_ME",
  runtime: "node",
  logLevel: "log",
  maxDuration: 14400, // 4 hours — larger report than PC version
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
    },
  },
  dirs: ["src/jobs"],
});
