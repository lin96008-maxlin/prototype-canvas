#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { analyzePrototype } from "./lib/analyze.mjs";
import { auditCanvasFile } from "./lib/audit.mjs";
import { captureSnapshots, verifyBindings } from "./lib/capture.mjs";
import { applyBindings, applyDescriptions, buildReviewBundle } from "./lib/review.mjs";
import { probePrototype } from "./lib/probe.mjs";
import { canvasDataPaths, parseCliArgs, readJson, readUtf8, resolveHtmlInput, sha256 } from "./lib/common.mjs";
import { generateCanvasFile } from "./lib/generate.mjs";
import { applySession, startEditorServer } from "./lib/session.mjs";

const { positional, options } = parseCliArgs(process.argv.slice(2));
const command = positional[0];

try {
  if (!command || options.help || command === "help") {
    printHelp();
    process.exit(0);
  }
  if (command === "analyze") {
    const sourceFile = resolveHtmlInput(positional[1]);
    const manifestPath = options.manifest ? path.resolve(String(options.manifest)) : undefined;
    const result = analyzePrototype(sourceFile, { manifestPath });
    output({ status: "ok", command, sourceFile, manifestPath: result.manifestPath, nodes: result.manifest.nodes.length, profiles: result.manifest.profiles.length, warnings: [...new Set([...result.validation.warnings, ...result.manifest.analysis.warnings])].length, unresolved: result.manifest.analysis.unresolved });
  } else if (command === "capture") {
    const sourceFile = resolveHtmlInput(positional[1]);
    const manifestPath = resolveManifestPath(sourceFile, options.manifest, true);
    output({ status: "ok", command, ...(await captureSnapshots({ sourceFile, manifestPath, quality: options.quality, timeout: options.timeout, force: Boolean(options.force), concurrency: options.concurrency })) });
  } else if (command === "probe") {
    const sourceFile = resolveHtmlInput(positional[1]);
    const manifestPath = options.manifest ? path.resolve(String(options.manifest)) : null;
    const viewport = manifestPath && fs.existsSync(manifestPath) ? readJson(manifestPath)?.prototype?.viewport : null;
    const result = await probePrototype({
      sourceFile,
      viewport,
      maxEntries: options["max-entries"],
      concurrency: options.concurrency,
      timeout: options.timeout,
      budgetMs: options.budget
    });
    if (options.output) fs.writeFileSync(path.resolve(String(options.output)), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    output({ status: "ok", command, sourceFile, output: options.output ? path.resolve(String(options.output)) : null, ...result });
  } else if (command === "bind") {
    const sourceFile = resolveHtmlInput(positional[1]);
    const manifestPath = resolveManifestPath(sourceFile, options.manifest, false);
    if (!options.patch) throw new Error("bind 需要 --patch <关联.json>。");
    const result = applyBindings({ manifestPath, patchPath: path.resolve(String(options.patch)), force: Boolean(options.force) });
    output({ status: "ok", command, sourceFile, manifestPath, ...result });
  } else if (command === "verify") {
    const sourceFile = resolveHtmlInput(positional[1]);
    const manifestPath = resolveManifestPath(sourceFile, options.manifest, true);
    const result = await verifyBindings({ sourceFile, manifestPath, timeout: options.timeout, concurrency: options.concurrency });
    output({ status: result.failed.length ? "error" : "ok", command, sourceFile, manifestPath, ...result });
    if (result.failed.length) process.exitCode = 3;
  } else if (command === "review") {
    const sourceFile = resolveHtmlInput(positional[1]);
    const manifestPath = resolveManifestPath(sourceFile, options.manifest, false);
    const bundle = buildReviewBundle(manifestPath);
    if (options.output) fs.writeFileSync(path.resolve(String(options.output)), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    output({ status: "ok", command, sourceFile, manifestPath, output: options.output ? path.resolve(String(options.output)) : null, counts: bundle.counts, unresolved: bundle.unresolved, items: bundle.items });
  } else if (command === "describe") {
    const sourceFile = resolveHtmlInput(positional[1]);
    const manifestPath = resolveManifestPath(sourceFile, options.manifest, false);
    if (!options.patch) throw new Error("describe 需要 --patch <说明.json>。");
    const result = applyDescriptions({ manifestPath, patchPath: path.resolve(String(options.patch)) });
    output({ status: "ok", command, sourceFile, manifestPath, ...result });
  } else if (command === "generate") {
    const sourceFile = resolveHtmlInput(positional[1]);
    const manifestPath = resolveManifestPath(sourceFile, options.manifest, true);
    const generated = generateCanvasFile({ sourceFile, manifest: readJson(manifestPath), outputPath: options.output ? path.resolve(String(options.output)) : null, outputDir: options["output-dir"] ? path.resolve(String(options["output-dir"])) : null });
    output({ status: "ok", command, sourceFile, manifestPath, ...generated });
  } else if (command === "audit") {
    const file = resolveHtmlInput(positional[1]);
    const result = auditCanvasFile(file);
    output({ status: result.ok ? "ok" : "error", command, ...result });
    if (!result.ok) process.exitCode = 2;
  } else if (command === "serve") {
    const sourceFile = resolveHtmlInput(positional[1]);
    const manifestPath = resolveManifestPath(sourceFile, options.manifest, true);
    const editor = await startEditorServer({ sourceFile, manifestPath, sessionId: options.session ? String(options.session) : null, port: options.port });
    output({ status: "ready", command, sourceFile, manifestPath, editUrl: editor.editUrl, sessionId: editor.sessionId, sessionPath: editor.sessionPath });
    await new Promise(resolve => {
      const close = () => editor.server.close(resolve);
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
  } else if (command === "apply") {
    const sourceFile = resolveHtmlInput(positional[1]);
    const result = applySession({ sourceFile, sessionId: options.session ? String(options.session) : null, outputPath: options.output ? path.resolve(String(options.output)) : null, outputDir: options["output-dir"] ? path.resolve(String(options["output-dir"])) : null });
    output({ status: "ok", command, sourceFile, ...result });
  } else {
    throw new Error(`未知命令：${command}`);
  }
} catch (error) {
  output({ status: "error", command: command || null, message: error.message });
  process.exitCode = 1;
}

function resolveManifestPath(sourceFile, requested, createWhenMissing) {
  if (requested) {
    const resolved = path.resolve(String(requested));
    if (!fs.existsSync(resolved)) throw new Error(`找不到 Canvas Manifest：${resolved}`);
    return resolved;
  }
  const sourceHash = sha256(readUtf8(sourceFile));
  const paths = canvasDataPaths(sourceFile, sourceHash);
  if (fs.existsSync(paths.manifestPath)) return paths.manifestPath;
  if (!createWhenMissing) throw new Error(`找不到 Canvas Manifest：${paths.manifestPath}`);
  return analyzePrototype(sourceFile).manifestPath;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`原型画布 CLI\n\n用法：\n  prototype-canvas analyze <原型.html> [--manifest <manifest.json>]\n  prototype-canvas probe <原型.html> [--manifest <manifest.json>] [--output <探查.json>] [--max-entries 48] [--budget 180000]\n  prototype-canvas review <原型.html> [--manifest <manifest.json>] [--output <复核包.json>]\n  prototype-canvas describe <原型.html> [--manifest <manifest.json>] --patch <说明.json>\n  prototype-canvas bind <原型.html> [--manifest <manifest.json>] --patch <关联.json> [--force]\n  prototype-canvas verify <原型.html> [--manifest <manifest.json>] [--concurrency 3]\n  prototype-canvas capture <原型.html> [--manifest <manifest.json>] [--quality 74] [--concurrency 3] [--force]\n  prototype-canvas generate <原型.html> [--manifest <manifest.json>] [--output <画布.html>]\n  prototype-canvas serve <原型.html> [--manifest <manifest.json>] [--port 端口]\n  prototype-canvas apply <原型.html> [--session <id>] [--output <画布.html>]\n  prototype-canvas audit <画布.html>\n`);
}
