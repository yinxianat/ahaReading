import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    exclude: ["e2e/**", "node_modules/**", ".claude/**"],
    setupFiles: ["tests/setup.js"],
    fileParallelism: false,
  },
});
