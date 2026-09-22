import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

/**
 * OXC (Vitest 5's default transformer) does not handle shebangs (#!) on the
 * first line of TypeScript source files. cli/index.ts carries one because it
 * is also the installed binary. This plugin strips the shebang before the
 * transform runs so tests that import cli/index.ts are not broken.
 */
const stripShebang: Plugin = {
  name: "strip-shebang",
  transform(code, id) {
    if (id.endsWith(".ts") && code.startsWith("#!")) {
      return { code: "//" + code.slice(2), map: null };
    }
  },
};

export default defineConfig({
  plugins: [stripShebang],
  test: {
    include: ["core/**/*.test.ts", "adapters/**/*.test.ts", "eval/**/*.test.ts", "cli/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
});
