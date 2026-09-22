import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["core/**/*.test.ts", "adapters/**/*.test.ts", "eval/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
});
