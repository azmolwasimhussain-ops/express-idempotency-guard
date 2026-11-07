import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  platform: "node",
  external: ["express"],
  outDir: "dist",
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  }
});
