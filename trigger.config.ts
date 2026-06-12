import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_xtftaswjunfdksyaqstl",
  runtime: "node",
  logLevel: "log",
  maxDuration: 86400, // 24 hours — large 40k+ record dataset
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
