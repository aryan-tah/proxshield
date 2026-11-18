import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

export default defineConfig([
  {
    entry: { index: "src/index.ts", "ai-sdk": "src/ai-sdk.ts" },
    format: ["esm"],
    target: "node20",
    dts: true,
    sourcemap: true,
    external: ["@ai-sdk/provider"],
    define: { __VERSION__: JSON.stringify(version) },
  },
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    define: { __VERSION__: JSON.stringify(version) },
  },
]);
