import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Les tests d'intégration partagent une base Postgres : pas de parallélisme entre fichiers.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
