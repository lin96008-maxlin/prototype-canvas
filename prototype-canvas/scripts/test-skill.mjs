import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePrototype } from "./lib/analyze.mjs";
import { auditCanvasFile } from "./lib/audit.mjs";
import { captureSnapshots } from "./lib/capture.mjs";
import { nextOutputPath, readJson } from "./lib/common.mjs";
import { generateCanvasFile } from "./lib/generate.mjs";
import { normalizeManifest, validateManifest, validatePublicationManifest } from "./lib/manifest-v2.mjs";
import { applySession, startEditorServer } from "./lib/session.mjs";
import { layoutForest, resolveForestOverlaps } from "../assets/runtime/tree-layout.js";
import { basicPrototypeHtml } from "../tests/fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "prototype-canvas-test-"));
const sourceFile = path.join(outputDir, "测试原型.html");
fs.writeFileSync(sourceFile, basicPrototypeHtml, "utf8");
const manifestPath = path.join(outputDir, "manifest.json");
assert.match(path.basename(nextOutputPath(sourceFile, outputDir)), /^20260901-（画布）/, "自动输出名必须使用固定前缀");

const analysis = analyzePrototype(sourceFile, { manifestPath });
assert.ok(analysis.manifest.nodes.length >= 3, "应识别页面、Tab 与抽屉节点");
assert.ok(analysis.manifest.profiles.length >= 2, "应识别原型中的用户角色");
assert.ok(analysis.manifest.nodes.some(node => node.type === "tab"), "应保留业务状态 Tab");
assert.equal(analysis.manifest.nodes[0].type, "start", "应生成不绑定页面的系统起点");
assert.deepEqual(analysis.manifest.nodes[0].bindings, {}, "系统起点不得伪造页面关联");
assert.ok(analysis.manifest.edges.every(edge => ["hierarchy", "cross"].includes(edge.type)), "只允许层级和跨节点两类连线");
assert.ok(analysis.manifest.edges.some(edge => edge.type === "hierarchy"), "分析结果应形成导航层级");
assert.equal(analysis.manifest.nodes.some(node => /识别依据为|JavaScript|具体业务规则待/.test(node.descriptionHtml)), false, "页面说明不得暴露技术识别模板");

const normalized = normalizeManifest(analysis.manifest);
const detailNode = normalized.nodes.find(node => ["tab", "drawer", "modal", "dialog", "sheet", "popover", "overlay", "step", "state"].includes(node.type));
const invalidHierarchy = structuredClone(normalized);
invalidHierarchy.nodes.find(node => node.id === detailNode.id).parentId = null;
invalidHierarchy.edges = invalidHierarchy.edges.filter(edge => !(edge.type === "hierarchy" && edge.target === detailNode.id));
assert.equal(validateManifest(invalidHierarchy).ok, false, "下钻节点缺少所属页面时必须校验失败");
assert.equal(validatePublicationManifest(normalized).ok, false, "未复核业务说明且缺少快照时不得发布");
normalized.analysis.unresolved = [];
for (const node of normalized.nodes) node.descriptionSource = "ai-reviewed";
normalized.nodes[0].layouts.mindmap.x = 120;
normalized.nodes[0].layouts.snapshot.x = 520;
assert.notEqual(normalized.nodes[0].layouts.mindmap.x, normalized.nodes[0].layouts.snapshot.x, "双模式坐标必须独立");
const noProfile = normalizeManifest({ ...analysis.manifest, profiles: [], nodes: analysis.manifest.nodes.map(node => ({ ...node, profileIds: [] })) });
assert.equal(noProfile.profiles.length, 0, "未识别身份时不得生成默认视角");
assert.equal(noProfile.viewState.activeProfileId, null, "没有用户类型时活动身份应为空");
assert.ok(normalized.audience.nodes.every(node => node.type && node.typeLabel && node.descriptionHtml), "用户类型节点必须包含名称、类型和说明所需字段");

const layoutNodes = [
  testLayoutNode("root", null, 0, 80, 120),
  testLayoutNode("branch-a", "root", 0),
  testLayoutNode("branch-b", "root", 1),
  testLayoutNode("leaf-a1", "branch-a", 0),
  testLayoutNode("leaf-a2", "branch-a", 1)
];
const layoutEdges = layoutNodes.filter(node => node.parentId).map(node => ({ id: `edge-${node.id}`, source: node.parentId, target: node.id, type: "hierarchy" }));
layoutForest(layoutNodes, layoutEdges, "mindmap");
const rootPosition = { x: layoutNodes[0].layouts.mindmap.x, y: layoutNodes[0].layouts.mindmap.y };
const branchA = layoutNodes.find(node => node.id === "branch-a").layouts.mindmap;
const branchB = layoutNodes.find(node => node.id === "branch-b").layouts.mindmap;
const branchABottom = Math.max(...layoutNodes.filter(node => ["branch-a", "leaf-a1", "leaf-a2"].includes(node.id)).map(node => node.layouts.mindmap.y + node.layouts.mindmap.height));
assert.ok(branchB.y - branchABottom >= 28, "同级节点间距必须从整棵子树边界计算");
assert.equal(branchA.x, branchB.x, "同一父节点的同级节点必须纵向排列在同一列");
layoutNodes.push(testLayoutNode("leaf-a3", "branch-a", 2));
layoutEdges.push({ id: "edge-leaf-a3", source: "branch-a", target: "leaf-a3", type: "hierarchy" });
const branchBBefore = branchB.y;
layoutForest(layoutNodes, layoutEdges, "mindmap");
assert.ok(layoutNodes.find(node => node.id === "branch-b").layouts.mindmap.y > branchBBefore, "内部节点变化后必须自动重算同级子树位置");
assert.deepEqual({ x: layoutNodes[0].layouts.mindmap.x, y: layoutNodes[0].layouts.mindmap.y }, rootPosition, "自动排版不得改动根节点坐标");

const overlapNodes = [testLayoutNode("root-a", null, 0, 80, 80), testLayoutNode("root-b", null, 1, 110, 92)];
resolveForestOverlaps(overlapNodes, [], "mindmap", ["root-b"]);
const overlapA = overlapNodes[0].layouts.mindmap;
const overlapB = overlapNodes[1].layouts.mindmap;
assert.equal(rectsOverlap(overlapA, overlapB, 40), false, "独立节点树不得重叠，并应自动排斥到安全间距");

const outputPath = path.join(outputDir, "20260901-（画布）测试原型.html");
await captureSnapshots({ sourceFile, manifestPath, quality: 55, timeout: 6000, force: true });
const publishable = normalizeManifest(readJson(manifestPath));
publishable.analysis.unresolved = [];
for (const node of publishable.nodes) node.descriptionSource = "ai-reviewed";
fs.writeFileSync(manifestPath, `${JSON.stringify(publishable, null, 2)}\n`, "utf8");
assert.equal(validatePublicationManifest(publishable).ok, true, validatePublicationManifest(publishable).errors.join("\n"));
const generated = generateCanvasFile({ sourceFile, manifest: publishable, outputPath });
assert.ok(generated.bytes > fs.statSync(sourceFile).size, "画布应包含原型与运行时");
const runtimeSource = fs.readFileSync(path.join(root, "assets", "canvas-runtime-v2.entry.js"), "utf8");
const layoutSource = fs.readFileSync(path.join(root, "assets", "runtime", "tree-layout.js"), "utf8");
assert.match(runtimeSource, /新增节点/, "localhost 运行时应包含明确的新增节点入口");
assert.match(runtimeSource, /<span>联系<\/span>/, "运行时应包含独立的联系入口");
assert.match(runtimeSource, /pc-edge-hit/, "联系线应提供可选择的命中区域");
assert.doesNotMatch(runtimeSource, /data-edge-id[^\n]+pc-hierarchy-line/, "层级线不得提供选择交互");
assert.match(layoutSource, /const childHeight/, "自动布局应按整棵子树占用高度计算同级间距");
const audit = auditCanvasFile(outputPath);
assert.equal(audit.ok, true, audit.errors.join("\n"));

const editor = await startEditorServer({ sourceFile, manifestPath, port: 0 });
try {
  const health = await fetch(editor.editUrl.replace("/edit", "/health")).then(response => response.json());
  assert.equal(health.ok, true, "localhost 健康检查应成功");
  const session = readJson(editor.sessionPath);
  session.manifest.nodes[0].title = "人工修订名称";
  const response = await fetch(editor.apiUrl, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-prototype-canvas-token": editor.token },
    body: JSON.stringify({ sessionId: editor.sessionId, manifest: session.manifest, operations: [{ label: "测试修改" }], lastOperation: "测试修改" })
  });
  assert.equal(response.ok, true, await response.text());
  const boundNode = session.manifest.nodes.find(node => Object.keys(node.bindings || {}).length);
  const profileId = session.manifest.profiles.find(profile => profile.canvasId === boundNode.canvasId)?.id || null;
  const captureResponse = await fetch(editor.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-prototype-canvas-token": editor.token },
    body: JSON.stringify({ nodeId: boundNode.id, profileId, quality: 55, timeout: 6000 })
  });
  const captureResult = await captureResponse.json();
  assert.equal(captureResponse.ok, true, captureResult.error || "单节点预览接口应成功");
  assert.equal(captureResult.snapshot.status, "ready", "关联页面后应生成 ready 状态预览");
  assert.match(captureResult.asset.dataUri, /^data:image\//, "单节点预览接口应返回可内嵌图片");
} finally {
  await new Promise(resolve => editor.server.close(resolve));
}

const appliedPath = path.join(outputDir, "20260901-（画布）测试原型-v2.html");
const applied = applySession({ sourceFile, sessionId: editor.sessionId, outputPath: appliedPath });
assert.equal(applied.outputPath, appliedPath, "Session 应生成新画布文件");
assert.equal(auditCanvasFile(appliedPath).ok, true, "应用后的画布应通过审计");
assert.equal(readJson(manifestPath).nodes[0].title, "人工修订名称", "应用后应更新基线 Manifest，供后续编辑继续使用");

const summary = { status: "ok", nodeCount: analysis.manifest.nodes.length, profileCount: analysis.manifest.profiles.length, generatedBytes: generated.bytes, temporaryArtifactsCleaned: true };
fs.rmSync(outputDir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function testLayoutNode(id, parentId, order, x = 0, y = 0) {
  return { id, parentId, order, collapsed: false, layouts: { mindmap: { x, y, width: 220, height: 58 }, snapshot: { x, y, width: 360, height: 278 } } };
}

function rectsOverlap(left, right, gap = 0) {
  return left.x < right.x + right.width + gap && left.x + left.width + gap > right.x && left.y < right.y + right.height + gap && left.y + left.height + gap > right.y;
}
