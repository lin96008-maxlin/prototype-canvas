import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { analyzePrototype } from "./lib/analyze.mjs";
import { captureSnapshots } from "./lib/capture.mjs";
import { createEdge, createNode, normalizeManifest } from "./lib/manifest-v2.mjs";
import { writeJson } from "./lib/common.mjs";
import { startEditorServer } from "./lib/session.mjs";
import { genericBindingPrototypeHtml } from "../tests/fixtures.mjs";

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "prototype-canvas-binding-"));
const sourceFile = path.join(outputDir, "通用页面关联原型.html");
const manifestPath = path.join(outputDir, "manifest.json");
fs.writeFileSync(sourceFile, genericBindingPrototypeHtml, "utf8");

const analyzed = analyzePrototype(sourceFile, { manifestPath, preservePrevious: false }).manifest;
const canvasId = "canvas-global";
const start = createNode({ id: "node-start", canvasId, type: "start", title: "通用页面关联验收", source: "test" });
const pageNode = createNode({ id: "node-workbench", canvasId, type: "page", title: "工作台", parentId: start.id, order: 0, source: "test" });
const plain = createNode({
  id: "node-plain-dialog",
  canvasId,
  type: "dialog",
  title: "偏好设置",
  parentId: pageNode.id,
  order: 0,
  bindings: {
    global: {
      target: { selector: "#preferences-panel" },
      actions: [
        { type: "click", selector: "#open-preferences" },
        { type: "wait-visible", selector: "#preferences-panel" }
      ],
      evidence: ["通用 DOM 定位回归"],
      confidence: 1
    }
  },
  source: "test"
});
const shadow = createNode({
  id: "node-shadow-drawer",
  canvasId,
  type: "drawer",
  title: "Shadow 抽屉",
  parentId: pageNode.id,
  order: 1,
  bindings: {
    global: {
      target: { selector: "#shadow-shell >>> aside[role='dialog']" },
      actions: [
        { type: "click", selector: "#shadow-shell >>> [data-testid='open-shadow-drawer']" },
        { type: "wait-visible", selector: "#shadow-shell >>> aside[role='dialog']" }
      ],
      evidence: ["开放式 Shadow DOM 定位回归"],
      confidence: 1
    }
  },
  source: "test"
});
const manifest = normalizeManifest({
  ...analyzed,
  profiles: [],
  canvases: [{ id: canvasId, profileId: null, name: "未配置用户类型" }],
  audience: {
    rootId: "audience-root",
    nodes: [{ id: "audience-root", title: "用户类型", type: "user", parentId: null, order: 0, profileId: null, canvasId: null }]
  },
  nodes: [start, pageNode, plain, shadow],
  edges: [
    createEdge(start.id, pageNode.id, "hierarchy", "", { canvasId }),
    createEdge(pageNode.id, plain.id, "hierarchy", "", { canvasId }),
    createEdge(pageNode.id, shadow.id, "hierarchy", "", { canvasId })
  ],
  snapshots: {},
  snapshotAssets: {},
  viewState: { activeMode: "mindmap", activeProfileId: null, defaultCanvasId: canvasId }
});
writeJson(manifestPath, manifest);

const capture = await captureSnapshots({ sourceFile, manifestPath, quality: 58, timeout: 6000, force: true });
assert.equal(capture.failed, 0, `通用页面关联不应采集失败：${JSON.stringify(capture.items)}`);
assert.equal(capture.captured, 2, "普通 DOM 与开放式 Shadow DOM 页面均应成功生成快照");
const capturedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const nodeId of [plain.id, shadow.id]) {
  const snapshot = capturedManifest.snapshots[`${nodeId}::all`];
  assert.equal(snapshot?.status, "ready", `${nodeId} 应具有可用快照`);
  const asset = capturedManifest.snapshotAssets[snapshot.assetHash];
  assert.ok(asset?.width > 0 && asset?.height > 0, `${nodeId} 快照尺寸应有效`);
  assert.ok(Math.abs(asset.width / asset.height - 1440 / 900) < .01, `${nodeId} 快照应遵循原型视口比例`);
}

const editor = await startEditorServer({ sourceFile, manifestPath, port: 0 });
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.message));

try {
  await page.goto(editor.editUrl, { waitUntil: "load" });
  await page.locator('[data-runtime-status="ready"]').waitFor({ timeout: 12000 });
  const originalNodeCount = await page.locator(".pc-node").count();
  assert.equal(originalNodeCount, 4, "未配置用户类型的默认画布应保留原节点");
  assert.match(await page.locator("[data-profile-name]").textContent(), /未配置用户类型/, "默认画布应显示为未配置用户类型");

  const plainNode = page.locator(`[data-node-id="${plain.id}"]`);
  await plainNode.click();
  await page.locator('[data-action="locate"]').click();
  await page.locator(".pc-live-frame.is-overlay.is-ready").waitFor({ state: "attached", timeout: 8000 });
  assert.match(await page.frameLocator(".pc-live-frame.is-overlay iframe").locator("body").innerText(), /通用业务系统/, "脚本字符串含 body 标签时定位原型仍应正常加载");
  await page.frameLocator(".pc-live-frame.is-overlay iframe").locator("main").click();
  await page.waitForTimeout(220);
  assert.equal(await page.locator('[data-action="locate-confirm"]').isEnabled(), true, "点击原型内容区后应允许确定关联");
  await page.locator('[data-action="locate-cancel"]').click();

  await page.locator('[data-mode="snapshot"]').click();
  await page.keyboard.press("Home");
  const plainBox = await plainNode.boundingBox();
  await page.mouse.move(plainBox.x + plainBox.width / 2, plainBox.y + plainBox.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -1800);
  await page.keyboard.up("Control");
  await page.locator(".pc-live-frame.is-inline.is-ready.is-visible").waitFor({ state: "attached", timeout: 8000 });
  assert.match(await page.locator(".pc-live-frame.is-inline iframe").contentFrame().locator("body").innerText(), /通用业务系统/, "脚本字符串含 body 标签时实时 HTML 预览仍应正常加载");
  await page.locator('[data-mode="mindmap"]').click();
  await page.keyboard.press("Home");

  await page.locator('[data-action="audience"]').click();
  assert.equal(await page.locator(".pc-audience-node").count(), 1, "未配置用户类型时管理树只显示根节点");
  await page.locator('[data-audience-node="audience-root"]').click();
  await page.locator('[data-audience-action="add"]').click();
  await page.locator(".pc-dialog").waitFor({ state: "visible" });
  assert.match(await page.locator(".pc-dialog").textContent(), /画布会迁移/, "默认画布首次增加下级前应提示迁移");
  await page.locator("[data-dialog-cancel]").click();
  assert.equal(await page.locator(".pc-audience-node").count(), 1, "取消迁移不得新增用户类型");

  await page.locator('[data-audience-action="add"]').click();
  await page.locator("[data-dialog-confirm]").click();
  assert.equal(await page.locator(".pc-audience-node").count(), 2, "确认后应生成第一个末级用户类型");
  assert.equal(await page.locator("[data-switch-profile]").count(), 1, "迁移后的末级节点应提供画布入口");
  await page.locator(".pc-audience-node .pc-inline-name").waitFor({ state: "attached" });
  await page.locator(".pc-audience-node .pc-inline-name").press("Enter");
  await page.keyboard.press("Control+z");
  assert.equal(await page.locator(".pc-audience-node").count(), 1, "撤销首次下级应恢复单一根节点");
  await page.locator('.pc-audience-dialog [data-audience-action="close"]').click();
  assert.equal(await page.locator(".pc-node").count(), originalNodeCount, "撤销后一级画布节点不得丢失");
  assert.match(await page.locator("[data-profile-name]").textContent(), /未配置用户类型/, "撤销后工具栏不得残留新用户类型");
  assert.equal(pageErrors.length, 0, `专项验收出现页面错误：${pageErrors.join("\n")}`);

  const session = JSON.parse(fs.readFileSync(editor.sessionPath, "utf8"));
  assert.equal(session.manifest.profiles.length, 0, "撤销后不得残留用户类型数据");
  assert.equal(session.manifest.nodes.filter(node => node.canvasId === canvasId).length, originalNodeCount, "撤销后默认画布数据应完整保留");
  process.stdout.write(`${JSON.stringify({ status: "ok", capture, pageErrors, temporaryArtifactsCleaned: true }, null, 2)}\n`);
} finally {
  await page.close();
  await browser.close();
  await new Promise(resolve => editor.server.close(resolve));
  fs.rmSync(outputDir, { recursive: true, force: true });
}

async function launchBrowser() {
  for (const options of [{ channel: "chrome", headless: true }, { channel: "msedge", headless: true }, { headless: true }]) {
    try { return await chromium.launch(options); } catch {}
  }
  throw new Error("没有可用的 Chromium 浏览器。");
}
