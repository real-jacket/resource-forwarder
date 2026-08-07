import { build, context } from "esbuild";
import { mkdir, cp, rm } from "node:fs/promises";
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
  minify: !isWatch,
  define: {
    "process.env.NODE_ENV": JSON.stringify(isWatch ? "development" : "production"),
  },
  target: ["chrome120"],
  logLevel: "info",
  absWorkingDir: rootDir,
};

async function copyPublicAssets() {
  await mkdir(distDir, { recursive: true });
  await cp(publicDir, distDir, { recursive: true });
}

async function main() {
  // Keep loaded unpacked extensions alive while rebuilding. Removing the whole
  // directory briefly deletes background.js and leaves Chrome with an invalid
  // service worker until the extension is manually reloaded.
  await rm(join(distDir, "chunks"), { recursive: true, force: true });
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
    // Keep each React surface self-contained. The sidepanel is opened and
    // destroyed frequently, so avoiding an extra shared-chunk import matters
    // more than saving one duplicate React copy in the unpacked extension.
    {
      ...shared,
      entryPoints: {
        options: "src/options/main.tsx",
        sidepanel: "src/sidepanel/main.tsx",
      },
      outdir: "dist",
      format: "esm",
      splitting: false,
      entryNames: "[name]",
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
