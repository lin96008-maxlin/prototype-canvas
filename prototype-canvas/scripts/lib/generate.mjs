import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  SKILL_ROOT,
  escapeHtml,
  jsonForInlineScript,
  nextOutputPath,
  readUtf8,
  sha256
} from "./common.mjs";
import { normalizeManifest, validateManifest, validatePublicationManifest } from "./manifest-v2.mjs";
import { createPrototypeReplayRuntime } from "./prototype-replay.mjs";

export function ensureRuntimeBuilt() {
  const entry = path.join(SKILL_ROOT, "assets", "canvas-runtime-v2.entry.js");
  const output = path.join(SKILL_ROOT, "dist", "canvas-runtime.js");
  if (!fs.existsSync(entry)) throw new Error(`缺少画布运行时入口：${entry}`);
  const runtimeFiles = [entry, ...fs.readdirSync(path.join(SKILL_ROOT, "assets", "runtime")).filter(name => name.endsWith(".js")).map(name => path.join(SKILL_ROOT, "assets", "runtime", name))];
  const newestRuntime = Math.max(...runtimeFiles.map(file => fs.statSync(file).mtimeMs));
  const needsBuild = !fs.existsSync(output) || fs.statSync(output).mtimeMs < newestRuntime;
  if (needsBuild) {
    const result = spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts", "build-runtime.mjs")], { cwd: SKILL_ROOT, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`画布运行时构建失败：\n${result.stderr || result.stdout}`);
  }
  return output;
}

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]);

function tagEndIndex(html, start) {
  let quote = null;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

export function findClosingBodyTagIndex(sourceHtml) {
  const lowerHtml = sourceHtml.toLowerCase();
  let index = 0;
  let rawTextElement = null;
  while (index < sourceHtml.length) {
    if (rawTextElement) {
      const closingStart = lowerHtml.indexOf(`</${rawTextElement}`, index);
      if (closingStart < 0) return -1;
      const boundary = lowerHtml[closingStart + rawTextElement.length + 2];
      if (boundary && !/[\s>]/.test(boundary)) {
        index = closingStart + rawTextElement.length + 2;
        continue;
      }
      const closingEnd = tagEndIndex(sourceHtml, closingStart);
      if (closingEnd < 0) return -1;
      rawTextElement = null;
      index = closingEnd + 1;
      continue;
    }

    const tagStart = sourceHtml.indexOf("<", index);
    if (tagStart < 0) return -1;
    if (sourceHtml.startsWith("<!--", tagStart)) {
      const commentEnd = sourceHtml.indexOf("-->", tagStart + 4);
      index = commentEnd < 0 ? sourceHtml.length : commentEnd + 3;
      continue;
    }
    const tagEnd = tagEndIndex(sourceHtml, tagStart);
    if (tagEnd < 0) return -1;
    const token = sourceHtml.slice(tagStart + 1, tagEnd).trimStart();
    const closing = token.startsWith("/");
    const name = token.slice(closing ? 1 : 0).match(/^([a-zA-Z][\w:-]*)/)?.[1]?.toLowerCase();
    if (closing && name === "body") return tagStart;
    if (!closing && name && RAW_TEXT_ELEMENTS.has(name) && !token.trimEnd().endsWith("/")) rawTextElement = name;
    index = tagEnd + 1;
  }
  return -1;
}

export function injectPrototypeBridge(sourceHtml, token) {
  const template = readUtf8(path.join(SKILL_ROOT, "assets", "prototype-bridge-v3.js"));
  const script = template
    .replace("__PC_BRIDGE_TOKEN__", JSON.stringify(token))
    .replace("__PC_REPLAY_RUNTIME__", createPrototypeReplayRuntime.toString())
    .replace(/<\/script/gi, "<\\/script");
  const block = `<script data-prototype-canvas-bridge>\n${script}\n</script>`;
  const bodyCloseIndex = findClosingBodyTagIndex(sourceHtml);
  if (bodyCloseIndex >= 0) return `${sourceHtml.slice(0, bodyCloseIndex)}${block}\n${sourceHtml.slice(bodyCloseIndex)}`;
  return `${sourceHtml}\n${block}`;
}

export function buildCanvasHtml({ sourceHtml, manifest: rawManifest, editConfig = null }) {
  const manifest = normalizeManifest(rawManifest);
  const validation = editConfig ? validateManifest(manifest) : validatePublicationManifest(manifest);
  if (!validation.ok) throw new Error(`Manifest 校验失败：\n${validation.errors.join("\n")}`);
  if (manifest.prototype.sourceHash !== sha256(sourceHtml)) throw new Error("Manifest 与源 HTML Hash 不一致，禁止生成。");
  const runtimePath = ensureRuntimeBuilt();
  const token = crypto.randomBytes(18).toString("hex");
  const bridgedSource = injectPrototypeBridge(sourceHtml, token);
  const shell = readUtf8(path.join(SKILL_ROOT, "assets", "canvas-shell.html"));
  const css = readUtf8(path.join(SKILL_ROOT, "assets", "canvas-v2.css"));
  const runtime = readUtf8(runtimePath).replace(/<\/script/gi, "<\\/script");
  const collapseDefaults = {
    nodes: manifest.nodes.map(node => [node.canvasId, node.id, Boolean(node.collapsed)]),
    audienceNodes: manifest.audience.nodes.map(node => [node.id, Boolean(node.collapsed)])
  };
  const config = {
    editMode: Boolean(editConfig),
    bridgeToken: token,
    collapseStorageKey: `prototype-canvas:collapse:${manifest.prototype.sourceHash}:${sha256(JSON.stringify(collapseDefaults)).slice(0, 16)}`,
    apiUrl: editConfig?.apiUrl || null,
    captureUrl: editConfig?.captureUrl || null,
    apiToken: editConfig?.apiToken || null,
    sessionId: editConfig?.sessionId || null
  };
  return shell
    .replace("__PC_TITLE__", escapeHtml(`（画布）${manifest.prototype.name}`))
    .replace("__PC_CSS__", css)
    .replace("__PC_MANIFEST__", jsonForInlineScript(manifest))
    .replace("__PC_SOURCE__", Buffer.from(bridgedSource, "utf8").toString("base64"))
    .replace("__PC_CONFIG__", jsonForInlineScript(config))
    .replace("__PC_RUNTIME__", runtime);
}

export function generateCanvasFile({ sourceFile, manifest, outputPath, outputDir }) {
  const sourceHtml = readUtf8(sourceFile);
  const target = outputPath || nextOutputPath(sourceFile, outputDir || path.dirname(sourceFile));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buildCanvasHtml({ sourceHtml, manifest }), "utf8");
  return { outputPath: target, bytes: fs.statSync(target).size, hash: sha256(readUtf8(target)) };
}
