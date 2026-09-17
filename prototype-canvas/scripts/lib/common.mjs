import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(SCRIPT_DIR, "../..");

export function fail(message, detail = "") {
  const error = new Error(detail ? `${message}\n${detail}` : message);
  error.isUserError = true;
  throw error;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function shortHash(value, length = 10) {
  return sha256(String(value)).slice(0, length);
}

export function normalizeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

export function slug(value, fallback = "item") {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return normalized || `${fallback}-${shortHash(value, 8)}`;
}

export function readUtf8(file) {
  return fs.readFileSync(file, "utf8");
}

export function readJson(file) {
  return JSON.parse(readUtf8(file));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function resolveHtmlInput(input) {
  if (!input) fail("缺少原型 HTML 路径。");
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) fail("找不到原型 HTML。", resolved);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || path.extname(resolved).toLowerCase() !== ".html") {
    fail("输入必须是单个 .html 文件。", resolved);
  }
  return resolved;
}

export function prototypeNameFromPath(file) {
  return path.basename(file, path.extname(file))
    .replace(/^\d{8}-（画布）/, "")
    .replace(/-v\d+$/i, "")
    .trim();
}

export function dateStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return `${values.year}${values.month}${values.day}`;
}

export function nextOutputPath(sourceFile, outputDir = path.dirname(sourceFile)) {
  const baseName = `20260901-（画布）${prototypeNameFromPath(sourceFile)}`;
  let candidate = path.join(outputDir, `${baseName}.html`);
  let version = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outputDir, `${baseName}-v${version}.html`);
    version += 1;
  }
  return candidate;
}

export function canvasDataPaths(sourceFile, sourceHash) {
  const prototypeKey = shortHash(`${path.resolve(sourceFile).toLowerCase()}::${sourceHash}`, 16);
  const root = path.join(path.dirname(sourceFile), ".prototype-canvas", prototypeKey);
  return {
    prototypeKey,
    root,
    manifestPath: path.join(root, "manifest.json"),
    sessionsDir: path.join(root, "sessions"),
    indexPath: path.join(root, "index.json")
  };
}

export function escapeAttributeValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function jsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function parseCliArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const [rawKey, inlineValue] = item.slice(2).split(/=(.*)/s, 2);
    if (inlineValue !== undefined) {
      options[rawKey] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[rawKey] = next;
      index += 1;
    } else {
      options[rawKey] = true;
    }
  }
  return { positional, options };
}
