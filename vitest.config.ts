import { defineConfig } from "vitest/config";

const SDK_DIST = "/opt/homebrew/lib/node_modules/openclaw/dist";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^openclaw\/plugin-sdk\/(.*)$/,
        replacement: `${SDK_DIST}/plugin-sdk/$1.js`,
      },
    ],
  },
  test: {
    environment: "node",
  },
});
