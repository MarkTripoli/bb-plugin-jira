import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    testTimeout: 10_000,
    projects: [
      {
        extends: true,
        test: { name: "server", include: ["*.test.ts"], environment: "node" },
      },
      {
        extends: true,
        test: { name: "ui", include: ["*.test.tsx"], environment: "jsdom" },
      },
    ],
  },
});
