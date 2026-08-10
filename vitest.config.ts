import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-argocd-external",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
