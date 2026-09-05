/**
 * build.js — esbuild bundler for the Chrome extension
 *
 * Usage:
 *   node build.js          → single build
 *   node build.js --watch  → rebuild on file changes
 *
 * Outputs:
 *   background.js   ← src/background.js  (ESM, Chrome SW module)
 *   offscreen.js    ← src/offscreen.js   (ESM, hidden extension page)
 *   popup.js        ← src/popup.js       (ESM, popup page)
 *   wasm/           ← ONNX Runtime WASM binaries (copied from node_modules)
 */

import esbuild from "esbuild";
import { cpSync, mkdirSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes("--watch");

// ---------------------------------------------------------------------------
// 1. Copy ONNX Runtime WASM files → extension/wasm/
//    These are fetched at runtime by onnxruntime-web; they can't be bundled.
// ---------------------------------------------------------------------------
const wasmSrc = join(__dirname, "node_modules", "onnxruntime-web", "dist");
const wasmDst = join(__dirname, "wasm");

mkdirSync(wasmDst, { recursive: true });

if (existsSync(wasmSrc)) {
  const wasmFiles = readdirSync(wasmSrc).filter(
    (f) => f.endsWith(".wasm") || f.endsWith(".mjs") || f.endsWith(".js")
  );
  for (const file of wasmFiles) {
    cpSync(join(wasmSrc, file), join(wasmDst, file));
  }
  console.log(`[Build] Copied ${wasmFiles.length} ONNX RT files → wasm/`);
} else {
  console.warn("[Build] ⚠ onnxruntime-web dist not found — run npm install first.");
}

// ---------------------------------------------------------------------------
// 2. Bundle JS entry points
// ---------------------------------------------------------------------------
const shared = {
  bundle: true,
  format: "esm",
  target: ["chrome116"],   // Offscreen Document API requires Chrome 116+
  minify: false,           // keep readable for debugging
  sourcemap: "inline",
  logLevel: "info",
};

const entryPoints = [
  { in: "src/background.js", out: "background" },
  { in: "src/offscreen.js",  out: "offscreen"  },
  { in: "src/popup.js",      out: "popup"      },
];

if (isWatch) {
  const ctx = await esbuild.context({ ...shared, entryPoints, outdir: "." });
  await ctx.watch();
  console.log("[Build] Watching for changes…");
} else {
  await esbuild.build({ ...shared, entryPoints, outdir: "." });
  console.log("[Build] ✓ Done.");
}
