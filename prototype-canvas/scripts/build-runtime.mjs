import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { SKILL_ROOT } from "./lib/common.mjs";

const outputDir = path.join(SKILL_ROOT, "dist");
fs.mkdirSync(outputDir, { recursive: true });

await build({
  entryPoints: [path.join(SKILL_ROOT, "assets", "canvas-runtime-v2.entry.js")],
  outfile: path.join(outputDir, "canvas-runtime.js"),
  bundle: true,
  minify: true,
  format: "iife",
  target: ["chrome110"],
  legalComments: "inline",
  define: { "process.env.NODE_ENV": '"production"' }
});

console.log(JSON.stringify({ status: "ok", runtime: path.join(outputDir, "canvas-runtime.js") }));
