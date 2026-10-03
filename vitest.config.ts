import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/deny-network.ts"],
    include: ["test/**/*.test.ts"],
  },
});
