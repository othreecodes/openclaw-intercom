import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

/**
 * Locate the installed OpenClaw SDK `dist` directory.
 *
 * The SDK is a peer dependency, so where it lives depends on how the plugin was
 * set up: `npm install openclaw`, a pnpm store, or the symlink that
 * `openclaw plugins install --link` creates. Resolving it at runtime keeps the
 * suite runnable on any machine and in CI, instead of assuming one local path.
 */
function resolveSdkDist(): string {
  const fromEnv = process.env.OPENCLAW_SDK_DIST;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  try {
    // .../openclaw/dist/plugin-sdk/core.js -> .../openclaw/dist
    const entry = require.resolve("openclaw/plugin-sdk/core");
    return path.dirname(path.dirname(entry));
  } catch {
    // Fall through to the global-install guesses below.
  }

  const globals = [
    "/opt/homebrew/lib/node_modules/openclaw/dist",
    "/usr/local/lib/node_modules/openclaw/dist",
    path.join(process.env.HOME ?? "", ".npm-global/lib/node_modules/openclaw/dist"),
  ];
  const found = globals.find((candidate) => fs.existsSync(candidate));
  if (found) return found;

  throw new Error(
    "Could not locate the OpenClaw SDK. Install it with `npm install openclaw`, " +
      "or set OPENCLAW_SDK_DIST to the package's dist directory.",
  );
}

const SDK_DIST = resolveSdkDist();

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
    // entry.test.ts loads the real SDK module graph and takes a few seconds;
    // under parallel load that can brush the 5s default and flake.
    testTimeout: 20_000,
  },
});
