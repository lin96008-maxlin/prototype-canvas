import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import { readUtf8 } from "./common.mjs";
import { validatePublicationManifest } from "./manifest-v2.mjs";

export function auditCanvasFile(file) {
  const html = readUtf8(file);
  const { document } = parseHTML(html);
  const errors = [];
  const warnings = [];
  const root = document.querySelector("[data-prototype-canvas-root]");
  const data = document.getElementById("prototypeCanvasData");
  const source = document.getElementById("prototypeCanvasSource");
  const config = document.getElementById("prototypeCanvasConfig");
  if (!root) errors.push("缺少画布根节点。");
  if (!data) errors.push("缺少 Canvas Manifest。");
  if (!source?.textContent?.trim()) errors.push("缺少内嵌原型源码。");
  if (!config) errors.push("缺少运行配置。");
  let manifest = null;
  if (data) {
    try {
      manifest = JSON.parse(data.textContent);
      const result = validatePublicationManifest(manifest);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    } catch (error) {
      errors.push(`Canvas Manifest 无法解析：${error.message}`);
    }
  }
  const resourceAttributes = [
    ["script[src]", "src"], ["link[href]", "href"], ["img[src]", "src"],
    ["iframe[src]", "src"], ["video[src]", "src"], ["audio[src]", "src"], ["source[src]", "src"]
  ];
  for (const [selector, attribute] of resourceAttributes) {
    for (const element of document.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute) || "";
      if (value && !/^(data:|blob:|#|about:blank)/i.test(value)) errors.push(`发现外部资源引用：${selector} ${value.slice(0, 140)}`);
    }
  }
  for (const style of document.querySelectorAll("style")) {
    const urls = [...String(style.textContent || "").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map(match => match[1]);
    const external = urls.find(value => !/^(data:|blob:|#)/i.test(value));
    if (external) errors.push(`发现样式外部资源引用：${external.slice(0, 140)}`);
  }
  if (!html.includes("prototype-canvas-runtime")) errors.push("缺少画布运行时标识。");
  if (source?.textContent?.trim()) {
    try {
      const prototypeHtml = Buffer.from(source.textContent.replace(/\s+/g, ""), "base64").toString("utf8");
      if (!prototypeHtml.includes("data-prototype-canvas-bridge")) errors.push("内嵌原型缺少通信桥。");
    } catch (error) {
      errors.push(`内嵌原型无法解码：${error.message}`);
    }
  }
  if (!/^20260901-（画布）/.test(path.basename(file))) warnings.push("文件名不符合 20260901-（画布）原型名称.html。");
  return {
    ok: errors.length === 0,
    file,
    bytes: fs.statSync(file).size,
    nodeCount: manifest?.nodes?.length || 0,
    profileCount: manifest?.profiles?.length || 0,
    snapshotCount: Object.keys(manifest?.snapshots || {}).length,
    snapshotAssetCount: Object.keys(manifest?.snapshotAssets || {}).length,
    errors,
    warnings
  };
}
