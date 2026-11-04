import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig keeps jsx: "preserve" for Next; the tests need real JSX transformation.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    // .tsx files render components and say `@vitest-environment jsdom` at the top; plain .ts tests run in Node.
    include: ["tests/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
