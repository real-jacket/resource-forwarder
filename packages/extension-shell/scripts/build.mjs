import { build, context } from "esbuild";
import { mkdir, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const isWatch = process.argv.includes("--watch");
const currentDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(currentDir, "..");
const distDir = join(rootDir, "dist");
const publicDir = join(rootDir, "public");

const shared = {
  bundle: true,
  sourcemap: true,
  target: ["chrome120"],
  logLevel: "info",
  absWorkingDir: rootDir,
};

async function copyPublicAssets() {
  await mkdir(distDir, { recursive: true });
  await cp(publicDir, distDir, { recursive: true });
}

async function main() {
  await copyPublicAssets();

  const builds = [
    {
      ...shared,
      entryPoints: ["src/background.ts"],
      outfile: "dist/background.js",
      format: "esm",
      platform: "browser",
    },
    {
      ...shared,
      entryPoints: ["src/content-script.ts"],
      outfile: "dist/content-script.js",
      format: "iife",
      platform: "browser",
    },
    {
      ...shared,
      entryPoints: ["src/page-bridge.ts"],
      outfile: "dist/page-bridge.js",
      format: "iife",
      globalName: "ResourceForwarderPageBridge",
      platform: "browser",
    },
    {
      ...shared,
      entryPoints: ["src/options/main.tsx"],
      outfile: "dist/options.js",
      format: "iife",
      globalName: "ResourceForwarderOptions",
      platform: "browser",
    },
    {
      ...shared,
      entryPoints: ["src/sidepanel/main.tsx"],
      outfile: "dist/sidepanel.js",
      format: "iife",
      globalName: "ResourceForwarderSidepanel",
      platform: "browser",
    },
  ];

  if (isWatch) {
    const contexts = await Promise.all(builds.map((item) => context(item)));
    await Promise.all(contexts.map((item) => item.watch()));
    console.log("Watching extension sources...");
    return;
  }

  await Promise.all(builds.map((item) => build(item)));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
