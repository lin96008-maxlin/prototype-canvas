import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { captureSnapshots } from "./lib/capture.mjs";
import { writeJson } from "./lib/common.mjs";
import { createNode, normalizeManifest } from "./lib/manifest-v2.mjs";
import { startEditorServer } from "./lib/session.mjs";
import { dynamicRolePrototypeHtml } from "../tests/fixtures.mjs";

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "prototype-canvas-dynamic-binding-"));
const sourceFile = path.join(outputDir, "异步权限原型.html");
const manifestPath = path.join(outputDir, "manifest.json");
fs.writeFileSync(sourceFile, dynamicRolePrototypeHtml, "utf8");

const profileId = "profile-auditor";
const canvasId = "canvas-auditor";
const robustBinding = {
  actions: [
    {
      type: "click",
      selector: "nav#top-nav > button:nth-of-type(4)",
      locator: { tag: "button", role: "button", text: "业务中心", attributes: { "data-module": "business" } },
      delay: 120
    },
    {
      type: "click",
      selector: '[data-page="ticketQuality"]',
      locator: { tag: "button", role: "button", text: "工单质检", attributes: { "data-page": "ticketQuality" } },
      delay: 120
    }
  ],
  target: { selector: "#ticket-panel", locator: { tag: "section", role: "tabpanel", text: "工单质检", attributes: {} } },
  evidence: ["异步角色页面通用回归"],
  confidence: 1
};
const robustNode = createNode({
  id: "node-ticket-quality",
  canvasId,
  type: "page",
  title: "工单质检",
  descriptionHtml: "<p>质检人员核查工单标签并提交处理结论。</p>",
  descriptionSource: "user",
  bindings: { [profileId]: robustBinding },
  source: "test"
});
const manifest = normalizeManifest({
  format: "prototype-canvas@2",
  prototype: { name: "异步权限业务系统", sourceHash: "", viewport: { width: 1440, height: 900 } },
  dimensions: [{ id: "role", name: "角色", values: [{ id: "auditor", name: "质检人员", sourceValue: "auditor" }] }],
  profiles: [{ id: profileId, name: "质检人员", attributes: { role: "auditor" }, sourceAttributes: { role: "auditor" }, canvasId }],
  canvases: [{ id: canvasId, profileId, name: "质检人员" }],
  audience: { rootId: "audience-root", nodes: [{ id: "audience-root", title: "质检人员", type: "role", parentId: null, order: 0, profileId, canvasId }] },
  nodes: [robustNode],
  edges: [],
  snapshots: {},
  snapshotAssets: {},
  viewState: { activeProfileId: profileId, defaultCanvasId: canvasId }
});
manifest.prototype.sourceHash = await sha256File(sourceFile);
writeJson(manifestPath, manifest);

const capture = await captureSnapshots({ sourceFile, manifestPath, quality: 58, timeout: 7000, force: true });
assert.equal(capture.failed, 0, `动态角色页面应完成回放：${JSON.stringify(capture.items)}`);
assert.equal(capture.captured, 1, "动态角色页面应生成一张快照");

const capturedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const staleNode = createNode({
  id: "node-stale-binding",
  canvasId,
  type: "page",
  title: "待重新关联",
  descriptionHtml: "<p>用于验证失效旧路径不会污染新关联。</p>",
  descriptionSource: "user",
  bindings: {
    [profileId]: {
      actions: [{ type: "click", selector: "#missing-old-entry" }],
      target: { selector: "#missing-old-target" },
      evidence: ["失效旧路径"],
      confidence: 1
    }
  },
  source: "test"
});
capturedManifest.nodes.push(staleNode);
writeJson(manifestPath, normalizeManifest(capturedManifest));

const editor = await startEditorServer({ sourceFile, manifestPath, port: 0 });
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.message));

try {
  await page.goto(editor.editUrl, { waitUntil: "load" });
  await page.locator('[data-runtime-status="ready"]').waitFor({ timeout: 12000 });

  const robust = page.locator(`[data-node-id="${robustNode.id}"]`);
  await robust.dblclick({ position: { x: 40, y: 48 } });
  await page.locator(".pc-live-frame.is-overlay.is-ready").waitFor({ state: "attached", timeout: 12000 });
  const liveText = await page.frameLocator(".pc-live-frame.is-overlay iframe").locator("body").innerText();
  assert.match(liveText, /工单质检/, "实时 HTML 应按当前用户类型打开异步页面");
  await page.locator('[data-action="prototype-back"]').click();

  const stale = page.locator(`[data-node-id="${staleNode.id}"]`);
  await stale.click();
  await page.locator('[data-action="locate"]').click();
  const frame = page.frameLocator(".pc-live-frame.is-overlay iframe");
  await frame.locator('[data-module="business"]').waitFor({ timeout: 8000 });
  await frame.locator('[data-module="business"]').click();
  await frame.locator('[data-page="ticketQuality"]').waitFor({ timeout: 8000 });
  await frame.locator('[data-page="ticketQuality"]').click();
  await frame.locator("#ticket-panel").waitFor({ timeout: 8000 });
  await page.locator('[data-action="locate-confirm"]:not([disabled])').click();
  await page.locator("[data-prototype-overlay]").waitFor({ state: "hidden", timeout: 15000 });

  const session = JSON.parse(fs.readFileSync(editor.sessionPath, "utf8"));
  const repaired = session.manifest.nodes.find(node => node.id === staleNode.id).bindings[profileId];
  assert.equal(repaired.actions.some(action => action.selector === "#missing-old-entry"), false, "重新关联必须替换失效旧路径");
  assert.equal(session.manifest.snapshots[`${staleNode.id}::${profileId}`]?.status, "ready", "验证成功后才保存关联和快照");
  assert.equal(pageErrors.length, 0, `动态关联验收出现页面错误：${pageErrors.join("\n")}`);
  process.stdout.write(`${JSON.stringify({ status: "ok", capture, repairedActionCount: repaired.actions.length, pageErrors, temporaryArtifactsCleaned: true }, null, 2)}\n`);
} finally {
  await page.close();
  await browser.close();
  await new Promise(resolve => editor.server.close(resolve));
  fs.rmSync(outputDir, { recursive: true, force: true });
}

async function sha256File(file) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function launchBrowser() {
  for (const options of [{ channel: "chrome", headless: true }, { channel: "msedge", headless: true }, { headless: true }]) {
    try { return await chromium.launch(options); } catch {}
  }
  throw new Error("没有可用的 Chromium 浏览器。");
}
