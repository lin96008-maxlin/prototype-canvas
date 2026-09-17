import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { analyzePrototype } from "./lib/analyze.mjs";
import { captureSnapshots } from "./lib/capture.mjs";
import { buildCanvasHtml } from "./lib/generate.mjs";
import { startEditorServer } from "./lib/session.mjs";
import { basicPrototypeHtml } from "../tests/fixtures.mjs";

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "prototype-canvas-browser-"));
const sourceFile = path.join(outputDir, "浏览器验收原型.html");
const manifestPath = path.join(outputDir, "manifest.json");
fs.writeFileSync(sourceFile, basicPrototypeHtml, "utf8");
analyzePrototype(sourceFile, { manifestPath, preservePrevious: false });
await captureSnapshots({ sourceFile, manifestPath, quality: 58, timeout: 6000, force: true });
const standaloneManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
standaloneManifest.analysis.unresolved = [];
for (const node of standaloneManifest.nodes) node.descriptionSource = "ai-reviewed";
const standaloneHtml = buildCanvasHtml({ sourceHtml: fs.readFileSync(sourceFile, "utf8"), manifest: standaloneManifest });
const standaloneFile = path.join(outputDir, "独立画布.html");
fs.writeFileSync(standaloneFile, standaloneHtml, "utf8");
const standaloneUrl = pathToFileURL(standaloneFile).href;
const editor = await startEditorServer({ sourceFile, manifestPath, port: 0 });
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.message));

try {
  await page.goto(editor.editUrl, { waitUntil: "load" });
  await page.locator('[data-runtime-status="ready"]').waitFor({ timeout: 12000 });
  await page.waitForTimeout(250);
  assert.equal(pageErrors.length, 0, `页面运行错误：${pageErrors.join("\n")}`);
  const expiredResponse = await page.evaluate(async () => {
    const config = JSON.parse(document.querySelector("#prototypeCanvasConfig").textContent);
    const response = await fetch(config.apiUrl, { method: "PUT", headers: { "content-type": "application/json", "x-prototype-canvas-token": "expired" }, body: "{}" });
    return { status: response.status, payload: await response.json() };
  });
  assert.equal(expiredResponse.status, 403, "失效的编辑页面应返回明确状态");
  assert.match(expiredResponse.payload.error, /服务已经重启.*刷新浏览器页面/, "失效凭证不得显示 Token 等技术提示");
  assert.equal(await page.locator('[data-action="add"]').count(), 1, "应显示新增节点入口");
  assert.equal(await page.locator('[data-action="connect"]').count(), 1, "应显示联系入口");
  assert.equal(await page.locator('[data-action="shortcuts"]').count(), 1, "工具栏应显示快捷键入口");
  await page.locator('[data-action="shortcuts"]').click();
  assert.match(await page.locator(".pc-shortcut-dialog").textContent(), /Ctrl \+ Z \/ Ctrl \+ Y/, "快捷键弹窗应说明撤销和重做操作");
  await page.locator("[data-dialog-close]").last().click();
  assert.equal(await page.locator('[data-action="delete-selection"]').count(), 0, "顶部不得显示删除按钮");
  assert.equal(await page.locator('[data-action="fit"]').count(), 0, "顶部不得显示适应画布按钮");
  assert.equal(await page.locator(".pc-node").count() > 1, true, "初始化后应显示节点树");
  assert.equal(await page.locator("[data-mini-viewport]").count(), 1, "初次进入画布时鸟瞰图必须立即显示视口框");
  assert.equal((await page.locator(".pc-type").allTextContents()).some(label => /[A-Za-z]/.test(label)), false, "节点类型不得显示英文");
  const initialCenterDelta = await graphCenterDelta(page, "[data-viewport]", ".pc-node");
  assert.ok(initialCenterDelta < 5, `初始导图整体应位于画布正中央：偏移=${initialCenterDelta.toFixed(2)}px`);
  assert.equal(await page.locator(".pc-hierarchy-line").count() > 0, true, "应显示层级线");
  assert.equal(await page.locator(".pc-hierarchy-line").first().evaluate(node => getComputedStyle(node).pointerEvents), "none", "层级线不得可选");
  const layerOrder = await page.evaluate(() => ({
    hierarchy: Number(getComputedStyle(document.querySelector("[data-hierarchy-edges]")).zIndex),
    nodes: Number(getComputedStyle(document.querySelector("[data-nodes]")).zIndex),
    relationship: Number(getComputedStyle(document.querySelector("[data-edges]")).zIndex)
  }));
  assert.ok(layerOrder.hierarchy < layerOrder.nodes && layerOrder.relationship > layerOrder.nodes, "层级线应位于节点下方，联系线应位于节点上方");
  const firstOrder = await page.locator(".pc-node>header").first().locator(":scope > *").evaluateAll(nodes => nodes.slice(0, 2).map(node => node.className || node.localName));
  assert.equal(String(firstOrder[0]).includes("pc-type"), true, "节点类型必须位于标题前");
  assert.equal(await page.locator(".pc-node [data-node-description]").count(), 0, "思维导图节点不得显示说明");

  const world = page.locator("[data-world]");
  const beforeWheel = await world.getAttribute("style");
  const stageBox = await page.locator("[data-viewport]").boundingBox();
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  const wheelTarget = await page.evaluate(() => { const rect = document.querySelector("[data-viewport]").getBoundingClientRect(); const node = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return { tag: node?.tagName, className: String(node?.className || "") }; });
  await page.mouse.wheel(30, 120);
  await page.waitForTimeout(80);
  assert.notEqual(await world.getAttribute("style"), beforeWheel, `滚轮应移动画布；命中=${JSON.stringify(wheelTarget)}；错误=${pageErrors.join(" | ")}`);
  const afterWheel = await world.getAttribute("style");
  await page.keyboard.down("Shift"); await page.mouse.wheel(0, 100); await page.keyboard.up("Shift");
  assert.notEqual(await world.getAttribute("style"), afterWheel, "Shift+滚轮应横向移动画布");

  await page.keyboard.press("Home");
  const anchorBefore = await nearestCenterNode(page);
  await page.locator('[data-mode="snapshot"]').click();
  await page.waitForTimeout(120);
  const anchorAfter = await centerForNode(page, anchorBefore.id);
  const anchorDelta = Math.hypot(anchorAfter.x - anchorBefore.x, anchorAfter.y - anchorBefore.y);
  assert.ok(anchorDelta < 4, `切换模式应保留中心附近节点位置；节点=${anchorBefore.id}；偏移=${anchorDelta.toFixed(2)}px`);
  await page.locator('[data-mode="mindmap"]').click();

  const start = page.locator('.pc-node[data-type="start"]').first();
  const startId = await start.getAttribute("data-node-id");
  await page.keyboard.press("Home");
  const fittedViewport = await page.locator("[data-viewport]").boundingBox();
  assert.ok(await graphCenterDelta(page, "[data-viewport]", ".pc-node") < 5, "Home 应将完整导图居中显示");
  const embedded = await page.locator("#prototypeCanvasData").evaluate(node => JSON.parse(node.textContent));
  const childId = embedded.edges.find(edge => edge.type === "hierarchy" && edge.source === startId)?.target;
  const child = page.locator(`.pc-node[data-node-id="${childId}"]`);
  const rootBefore = await start.boundingBox();
  const childBefore = await child.boundingBox();
  const hierarchyBeforeDrag = await page.locator(".pc-hierarchy-line").count();
  await page.mouse.move(rootBefore.x + rootBefore.width / 2, rootBefore.y + rootBefore.height / 2);
  await page.mouse.down();
  await page.mouse.move(rootBefore.x + rootBefore.width / 2 + 52, rootBefore.y + rootBefore.height / 2 + 34, { steps: 8 });
  assert.ok(await page.locator(".pc-drag-placeholder").count() > 1, "拖拽节点树时应保留原位占位预览");
  assert.ok(await page.locator(".pc-hierarchy-line").count() < hierarchyBeforeDrag, "拖拽预览时应隐藏被拖子树的旧层级线，避免出现多条重影");
  await page.mouse.up();
  const rootAfter = await start.boundingBox();
  const childAfter = await child.boundingBox();
  assert.ok(Math.abs((rootAfter.x - rootBefore.x) - (childAfter.x - childBefore.x)) < 3, "移动根节点时整棵子树应同步移动");
  assert.ok(Math.abs((rootAfter.y - rootBefore.y) - (childAfter.y - childBefore.y)) < 3, "移动根节点时子树纵向位移应一致");

  const countBeforeCollapse = await page.locator(".pc-node").count();
  const startCollapse = page.locator(`[data-collapse="${startId}"]`);
  await startCollapse.click();
  const countAfterCollapse = await page.locator(".pc-node").count();
  const collapseText = await startCollapse.textContent();
  assert.ok(countAfterCollapse < countBeforeCollapse, `应收起整棵下级；收起前=${countBeforeCollapse}；收起后=${countAfterCollapse}；标识=${collapseText}`);
  assert.equal(await startCollapse.textContent() !== "", true, "收起后应显示下级数量");
  await waitForSession(editor.sessionPath, current => current.nodes.find(node => node.id === startId)?.collapsed === true);
  await page.reload({ waitUntil: "load" });
  await page.locator('[data-runtime-status="ready"]').waitFor({ timeout: 12000 });
  assert.equal(await page.locator(".pc-node").count(), countAfterCollapse, "localhost 刷新后应恢复节点收起状态");
  await startCollapse.click();
  assert.equal(await page.locator(".pc-node").count(), countBeforeCollapse, "应重新展开下级");

  const originalStartTitle = await start.locator("[data-node-title]").textContent();
  await start.locator("[data-node-title]").dblclick();
  await page.locator(".pc-inline-name").fill("重命名即时刷新");
  await page.locator(".pc-inline-name").press("Enter");
  assert.equal(await start.locator("[data-node-title]").textContent(), "重命名即时刷新", "双击重命名后节点应立即显示新名称");
  await page.keyboard.press("Control+z");
  assert.equal(await start.locator("[data-node-title]").textContent(), originalStartTitle, "撤销应恢复节点名称");

  const blank = await blankPoint(page);
  const beforeAdd = await page.locator(".pc-node").count();
  await page.mouse.dblclick(blank.x, blank.y);
  await page.locator(".pc-inline-name").fill("浏览器验收情形");
  await page.locator(".pc-inline-name").press("Enter");
  assert.equal(await page.locator(".pc-node").count(), beforeAdd + 1, "双击空白处应新增根节点");
  const scenario = page.locator(".pc-node", { hasText: "浏览器验收情形" });
  assert.equal(await scenario.getAttribute("data-type"), "page", "新节点默认应为页面类型");
  const scenarioId = await scenario.getAttribute("data-node-id");
  const scenarioRootBox = await scenario.boundingBox();
  const startDropBox = await start.boundingBox();
  await page.mouse.move(scenarioRootBox.x + scenarioRootBox.width / 2, scenarioRootBox.y + scenarioRootBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(startDropBox.x + startDropBox.width / 2, startDropBox.y + startDropBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await waitForSession(editor.sessionPath, current => current.nodes.find(node => node.id === scenarioId)?.parentId === startId);
  assert.equal(JSON.parse(fs.readFileSync(editor.sessionPath, "utf8")).manifest.nodes.find(node => node.id === scenarioId).parentId, startId, "独立根节点应能拖入其他节点树");
  await page.keyboard.press("Control+z");

  await page.keyboard.press("Home");
  await start.click();
  await page.locator("[data-inspector]").waitFor({ state: "visible" });
  const inspectorBefore = await page.locator("[data-inspector]").boundingBox();
  const resizerBox = await page.locator("[data-inspector-resizer]").boundingBox();
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 120);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x - 64, resizerBox.y + 120, { steps: 6 });
  await page.mouse.up();
  const inspectorAfter = await page.locator("[data-inspector]").boundingBox();
  assert.ok(inspectorAfter.width > inspectorBefore.width + 40, `节点详情应支持拖拽调整宽度：${inspectorBefore.width} -> ${inspectorAfter.width}`);
  await page.locator('[data-action="add"]').click();
  await page.locator(".pc-inline-name").waitFor({ state: "attached" });
  assert.equal(await page.locator(".pc-inline-name").count(), 1, "一级画布新增节点后应直接进入名称编辑态");
  await page.locator(".pc-inline-name").fill("新增下级节点");
  await page.locator(".pc-inline-name").press("Enter");
  const addedChild = page.locator(".pc-node", { hasText: "新增下级节点" });
  assert.equal(await addedChild.count(), 1, "选中节点后新增按钮应创建下级");

  const mainViewportBox = await page.locator("[data-viewport]").boundingBox();
  await page.mouse.move(mainViewportBox.x + mainViewportBox.width / 2, mainViewportBox.y + mainViewportBox.height / 2);
  await page.mouse.wheel(37, 83);
  await page.waitForTimeout(40);
  const mainViewBeforeUndo = await world.getAttribute("style");
  await page.keyboard.press("Control+z");
  assert.equal(await world.getAttribute("style"), mainViewBeforeUndo, "撤销节点操作不得改变一级画布位置");
  await page.keyboard.press("Control+y");
  assert.equal(await world.getAttribute("style"), mainViewBeforeUndo, "重做节点操作不得改变一级画布位置");

  await waitForSession(editor.sessionPath, current => current.nodes.some(node => node.title === "新增下级节点"));
  await page.keyboard.press("Home");
  const currentManifest = JSON.parse(fs.readFileSync(editor.sessionPath, "utf8")).manifest;
  const siblingIds = currentManifest.edges.filter(edge => edge.type === "hierarchy" && edge.source === startId).map(edge => edge.target);
  const branchBoxes = (await Promise.all(siblingIds.map(async id => {
    const ids = subtreeNodeIds(id, currentManifest.edges);
    const boxes = (await Promise.all(ids.map(nodeId => page.locator(`[data-node-id="${nodeId}"]`).boundingBox()))).filter(Boolean);
    if (!boxes.length) return null;
    const left = Math.min(...boxes.map(box => box.x)); const top = Math.min(...boxes.map(box => box.y));
    const right = Math.max(...boxes.map(box => box.x + box.width)); const bottom = Math.max(...boxes.map(box => box.y + box.height));
    return { id, box: await page.locator(`[data-node-id="${id}"]`).boundingBox(), branch: { left, top, right, bottom } };
  }))).filter(Boolean).sort((left, right) => left.branch.top - right.branch.top);
  const gapPair = branchBoxes.slice(1).map((item, index) => ({ previous: branchBoxes[index], next: item, gap: item.branch.top - branchBoxes[index].branch.bottom })).find(item => item.gap > 4);
  assert.ok(gapPair, "应找到同级节点之间的插入区域");
  const scenarioGapBox = await scenario.boundingBox();
  const gapPoint = { x: gapPair.next.box.x + gapPair.next.box.width / 2, y: gapPair.previous.branch.bottom + gapPair.gap / 2 };
  await page.mouse.move(scenarioGapBox.x + scenarioGapBox.width / 2, scenarioGapBox.y + scenarioGapBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gapPoint.x, gapPoint.y, { steps: 8 });
  assert.equal(await page.locator(".pc-drop-marker").count(), 1, "两个同级节点之间的整段空白区域应显示插入位置");
  await page.mouse.up();
  await waitForSession(editor.sessionPath, current => current.nodes.find(node => node.id === scenarioId)?.parentId === startId);
  const inserted = JSON.parse(fs.readFileSync(editor.sessionPath, "utf8")).manifest.nodes.find(node => node.id === scenarioId);
  const nextSibling = JSON.parse(fs.readFileSync(editor.sessionPath, "utf8")).manifest.nodes.find(node => node.id === gapPair.next.id);
  assert.ok(inserted.order <= nextSibling.order, "松开后应插入目标同级位置附近");
  await page.keyboard.press("Control+z");
  await waitForSession(editor.sessionPath, current => !current.nodes.find(node => node.id === scenarioId)?.parentId);

  await scenario.click();
  assert.equal(await scenario.evaluate(node => node.classList.contains("is-selected")), true, "建立联系前应选中开始节点");
  await page.locator('[data-action="connect"]').click();
  assert.equal(await page.locator('[data-action="connect"]').evaluate(node => node.classList.contains("is-active")), true, "点击联系后应进入联系模式");
  await addedChild.evaluate(node => node.click());
  const relationCount = await page.locator(".pc-relationship").count();
  const selectedAfterRelation = await page.locator(".pc-node.is-selected").evaluateAll(nodes => nodes.map(node => node.dataset.nodeId));
  const connectActiveAfter = await page.locator('[data-action="connect"]').evaluate(node => node.classList.contains("is-active"));
  assert.equal(relationCount, 1, `联系入口应建立独立联系线；选中=${selectedAfterRelation.join(",")}；联系模式=${connectActiveAfter}；错误=${pageErrors.join(" | ")}`);
  assert.equal(await page.locator(".pc-edge-anchor").count(), 2, "选中联系线后应显示两个边界锚点");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".pc-edge-anchor").count(), 0, "取消选择后联系线编辑点应隐藏");
  await clickSvgPathAtMiddle(page, page.locator(".pc-edge-hit"));
  assert.equal(await page.locator(".pc-edge-anchor").count(), 2, "真实鼠标点击应选中联系线");
  const relationPathBefore = await page.locator(".pc-relationship-line").getAttribute("d");
  const controlBox = await page.locator('[data-edge-control="source"]').boundingBox();
  await page.mouse.move(controlBox.x + controlBox.width / 2, controlBox.y + controlBox.height / 2);
  await page.mouse.down(); await page.mouse.move(controlBox.x + controlBox.width / 2 + 28, controlBox.y + controlBox.height / 2 + 18, { steps: 5 }); await page.mouse.up();
  assert.notEqual(await page.locator(".pc-relationship-line").getAttribute("d"), relationPathBefore, "拖拽控制点应编辑联系线形状");
  await page.keyboard.press("Delete");
  assert.equal(await page.locator(".pc-relationship").count(), 0, "Delete 应直接删除选中的联系线");
  await page.keyboard.press("Control+z");
  assert.equal(await page.locator(".pc-relationship").count(), 1, "撤销应恢复联系线");

  await page.keyboard.press("Home");
  const firstRect = await start.boundingBox();
  const secondRect = await child.boundingBox();
  const selectStart = { x: Math.min(firstRect.x, secondRect.x) - 10, y: Math.min(firstRect.y, secondRect.y) - 10 };
  const selectEnd = { x: Math.max(firstRect.x + firstRect.width, secondRect.x + secondRect.width) + 10, y: Math.max(firstRect.y + firstRect.height, secondRect.y + secondRect.height) + 10 };
  await page.mouse.move(selectStart.x, selectStart.y); await page.mouse.down(); await page.mouse.move(selectEnd.x, selectEnd.y, { steps: 6 }); await page.mouse.up();
  assert.ok(await page.locator(".pc-node.is-selected").count() >= 2, "框选应一次选中多个节点");
  const multiRootBefore = await start.boundingBox();
  const multiChildBefore = await child.boundingBox();
  await drag(page, start, 36, 26);
  const multiRootAfter = await start.boundingBox();
  const multiChildAfter = await child.boundingBox();
  assert.ok(Math.abs((multiRootAfter.x - multiRootBefore.x) - (multiChildAfter.x - multiChildBefore.x)) < 3, "框选多个节点后拖拽应让选中分支整体移动");
  await page.keyboard.press("Control+z");
  const clear = await blankPoint(page);
  await page.mouse.click(clear.x, clear.y);
  assert.equal(await page.locator(".pc-node.is-selected").count(), 0, "点击空白处应取消全部选择");

  await page.keyboard.press("Home");
  for (let index = 0; index < 16; index += 1) await page.locator('[data-action="zoom-out"]').click();
  const lowScaleMarker = page.locator("[data-mini-viewport]");
  const lowScaleMarkerBefore = await lowScaleMarker.boundingBox();
  assert.ok(lowScaleMarkerBefore, "低缩放倍率下鸟瞰图视口框仍应显示");
  const lowScaleWorldBefore = await world.getAttribute("style");
  await page.mouse.move(lowScaleMarkerBefore.x + lowScaleMarkerBefore.width / 2, lowScaleMarkerBefore.y + lowScaleMarkerBefore.height / 2);
  await page.mouse.down();
  await page.mouse.move(lowScaleMarkerBefore.x + lowScaleMarkerBefore.width / 2 + 30, lowScaleMarkerBefore.y + lowScaleMarkerBefore.height / 2 + 18, { steps: 6 });
  const lowScaleMarkerAfter = await lowScaleMarker.boundingBox();
  assert.ok(Math.hypot(lowScaleMarkerAfter.x - lowScaleMarkerBefore.x, lowScaleMarkerAfter.y - lowScaleMarkerBefore.y) > 4, "低缩放倍率下鸟瞰图视口框应实时跟随鼠标");
  assert.notEqual(await world.getAttribute("style"), lowScaleWorldBefore, "低缩放倍率下拖动鸟瞰图应实时移动主画布");
  await page.mouse.up();
  await page.keyboard.press("Home");

  const miniBefore = await world.getAttribute("style");
  const mini = page.locator("[data-minimap-content]");
  const miniBox = await mini.boundingBox();
  await page.mouse.move(miniBox.x + miniBox.width * .3, miniBox.y + miniBox.height * .3);
  await page.mouse.down(); await page.mouse.move(miniBox.x + miniBox.width * .7, miniBox.y + miniBox.height * .65, { steps: 5 });
  assert.equal(await page.locator("[data-mini-viewport]").count(), 1, "拖动鸟瞰图时视口框不得消失");
  await page.mouse.up();
  assert.notEqual(await world.getAttribute("style"), miniBefore, "拖动鸟瞰图应实时移动主画布");
  for (let index = 0; index < 5; index += 1) await page.locator('[data-minimap="in"]').click();
  const miniOverflow = await page.locator("[data-minimap-scroll]").evaluate(node => ({ x: getComputedStyle(node).overflowX, y: getComputedStyle(node).overflowY, overflow: node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight }));
  assert.equal(miniOverflow.x, "auto"); assert.equal(miniOverflow.y, "auto"); assert.equal(miniOverflow.overflow, true, "放大鸟瞰图后应可滚动");
  const miniBounds = await page.locator("[data-minimap-scroll]").evaluate(node => ({ scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight, contentWidth: node.firstElementChild.offsetWidth, contentHeight: node.firstElementChild.offsetHeight }));
  assert.ok(miniBounds.scrollWidth <= miniBounds.contentWidth + 1 && miniBounds.scrollHeight <= miniBounds.contentHeight + 1, `鸟瞰图视口框不得撑出额外滚动空间：${JSON.stringify(miniBounds)}`);
  const miniViewportBox = await page.locator("[data-mini-viewport]").evaluate(node => ({ width: node.offsetWidth, height: node.offsetHeight, right: node.offsetLeft + node.offsetWidth, bottom: node.offsetTop + node.offsetHeight, parentWidth: node.parentElement.offsetWidth, parentHeight: node.parentElement.offsetHeight }));
  assert.ok(miniViewportBox.width <= 84 && miniViewportBox.height <= 62, `鸟瞰图视口框应保持可操作的小尺寸：${JSON.stringify(miniViewportBox)}`);
  assert.ok(miniViewportBox.right <= miniViewportBox.parentWidth - 2 && miniViewportBox.bottom <= miniViewportBox.parentHeight - 2, `鸟瞰图视口框不得被右侧或底部截断：${JSON.stringify(miniViewportBox)}`);
  for (let index = 0; index < 4; index += 1) await page.locator('[data-minimap="in"]').click();
  const minimapScroll = page.locator("[data-minimap-scroll]");
  const mainWorldBeforeMiniWheel = await world.getAttribute("style");
  await minimapScroll.hover();
  await page.mouse.wheel(0, 120);
  const miniVertical = await minimapScroll.evaluate(node => ({ top: node.scrollTop, max: node.scrollHeight - node.clientHeight }));
  assert.equal(await world.getAttribute("style"), mainWorldBeforeMiniWheel, "鸟瞰图滚轮不得移动主画布视口框");
  assert.ok(miniVertical.max <= 0 || miniVertical.top > 0, `鸟瞰图滚轮应移动内部纵向滚动条：${JSON.stringify(miniVertical)}`);
  await page.keyboard.down("Shift"); await page.mouse.wheel(0, 120); await page.keyboard.up("Shift");
  const miniHorizontal = await minimapScroll.evaluate(node => ({ left: node.scrollLeft, max: node.scrollWidth - node.clientWidth }));
  assert.ok(miniHorizontal.max <= 0 || miniHorizontal.left > 0, `Shift+滚轮应移动鸟瞰图内部横向滚动条：${JSON.stringify(miniHorizontal)}`);

  await page.keyboard.press("Home");
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await page.mouse.wheel(0, 100000);
  assert.equal(await hasVisibleNode(page, "[data-viewport]", ".pc-node"), true, "主画布移动到边界时仍应保留导图可见");
  await page.keyboard.press("Home");

  await page.locator('[data-action="audience"]').click();
  assert.equal((await page.locator(".pc-audience-dialog .pc-brand strong").textContent()).trim(), "用户类型管理", "用户类型弹窗标题应为用户类型管理");
  assert.ok(await page.locator(".pc-audience-node").count() >= 3, "用户类型管理应为多级思维导图");
  const renameAudience = page.locator(".pc-audience-node").nth(1);
  const originalAudienceTitle = await renameAudience.locator("strong").textContent();
  await renameAudience.locator("strong").dblclick();
  await page.locator(".pc-audience-node .pc-inline-name").fill("双击改名验收");
  await page.locator(".pc-audience-node .pc-inline-name").press("Enter");
  assert.equal(await page.locator(".pc-audience-node", { hasText: "双击改名验收" }).count(), 1, "用户类型管理应支持双击节点名称直接编辑");
  await page.waitForTimeout(30);
  const audienceViewportBeforeUndo = await page.locator("[data-audience-viewport]").boundingBox();
  await page.mouse.move(audienceViewportBeforeUndo.x + audienceViewportBeforeUndo.width / 2, audienceViewportBeforeUndo.y + audienceViewportBeforeUndo.height / 2);
  await page.mouse.wheel(31, 67);
  await page.waitForTimeout(40);
  const audienceViewBeforeUndo = await page.locator("[data-audience-world]").getAttribute("style");
  await page.keyboard.press("Control+z");
  assert.equal(await page.locator("[data-audience-world]").getAttribute("style"), audienceViewBeforeUndo, "撤销节点操作不得改变用户类型画布位置");
  const audienceTitlesAfterUndo = await page.locator(".pc-audience-node strong").allTextContents();
  assert.equal(audienceTitlesAfterUndo.includes(originalAudienceTitle), true, `用户类型改名应支持撤销：原名称=${originalAudienceTitle}；当前=${audienceTitlesAfterUndo.join("|")}`);
  await page.keyboard.press("Control+y");
  assert.equal(await page.locator("[data-audience-world]").getAttribute("style"), audienceViewBeforeUndo, "重做节点操作不得改变用户类型画布位置");
  await page.keyboard.press("Control+z");
  await page.locator(".pc-audience-node").first().click();
  assert.equal(await page.locator("[data-audience-edit-name]").count(), 1, "用户类型详情应提供名称字段");
  assert.equal(await page.locator("[data-audience-edit-type]").count(), 1, "用户类型详情应提供预设类型字段");
  assert.equal(await page.locator("[data-audience-edit-description]").count(), 1, "用户类型详情应提供说明字段");
  assert.equal(await page.locator("[data-audience-inspector] [data-action='locate']").count(), 0, "用户类型详情不得出现页面关联");
  const audienceDialogBox = await page.locator(".pc-audience-dialog").boundingBox();
  assert.ok(audienceDialogBox.width < 1440 && audienceDialogBox.height < 900, "用户类型管理应显示为大弹窗而非全屏页");
  assert.equal(await page.locator(".pc-audience-minimap").count(), 1, "用户类型管理应提供鸟瞰图");
  const audienceMiniBounds = await page.locator("[data-audience-minimap-scroll]").evaluate(node => ({ scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight, contentWidth: node.firstElementChild.offsetWidth, contentHeight: node.firstElementChild.offsetHeight }));
  assert.ok(audienceMiniBounds.scrollWidth <= audienceMiniBounds.contentWidth + 1 && audienceMiniBounds.scrollHeight <= audienceMiniBounds.contentHeight + 1, `用户类型鸟瞰图不得产生额外空白滚动范围：${JSON.stringify(audienceMiniBounds)}`);
  const audienceTypeColors = await page.locator(".pc-audience-node").evaluateAll(nodes => new Set(nodes.map(node => getComputedStyle(node.querySelector(".pc-audience-type")).backgroundColor)).size);
  assert.ok(audienceTypeColors >= 2, "不同用户类型标签应使用不同语义颜色");
  for (let index = 0; index < 4; index += 1) await page.locator('[data-audience-minimap="in"]').click();
  const audienceMiniScroll = page.locator("[data-audience-minimap-scroll]");
  const audienceWorldBeforeMiniWheel = await page.locator("[data-audience-world]").getAttribute("style");
  await audienceMiniScroll.hover();
  await page.mouse.wheel(0, 120);
  assert.equal(await page.locator("[data-audience-world]").getAttribute("style"), audienceWorldBeforeMiniWheel, "用户类型鸟瞰图滚轮不得移动用户类型画布");
  const audienceWorld = page.locator("[data-audience-world]");
  const audienceBefore = await audienceWorld.getAttribute("style");
  const audienceViewport = await page.locator("[data-audience-viewport]").boundingBox();
  await page.mouse.move(audienceViewport.x + audienceViewport.width / 2, audienceViewport.y + audienceViewport.height / 2);
  await page.mouse.wheel(0, 120);
  assert.notEqual(await audienceWorld.getAttribute("style"), audienceBefore, "用户类型管理应支持滚轮移动");
  await page.mouse.wheel(0, 100000);
  assert.equal(await hasVisibleNode(page, "[data-audience-viewport]", ".pc-audience-node"), true, "用户类型画布移动到边界时仍应保留导图可见");
  await page.keyboard.press("Home");
  const audienceTotal = await page.locator(".pc-audience-node").count();
  await page.locator("[data-audience-search]").fill("不存在的用户类型");
  assert.equal(await page.locator(".pc-audience-node").count(), 1, "用户类型搜索无匹配时应仅保留结构根节点");
  await page.locator("[data-audience-search]").fill("");
  assert.equal(await page.locator(".pc-audience-node").count(), audienceTotal, "清空搜索应恢复用户类型树");
  await page.locator("[data-audience-search]").evaluate(input => input.blur());
  const reorderSource = page.locator("[data-switch-profile]").nth(0).locator("xpath=..");
  const reorderTarget = page.locator("[data-switch-profile]").nth(1).locator("xpath=..");
  const reorderSourceBox = await reorderSource.boundingBox();
  const reorderTargetBox = await reorderTarget.boundingBox();
  await page.mouse.move(reorderSourceBox.x + reorderSourceBox.width / 2, reorderSourceBox.y + reorderSourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(reorderTargetBox.x + reorderTargetBox.width / 2, reorderTargetBox.y + reorderTargetBox.height * .92, { steps: 8 });
  assert.equal(await page.locator(".pc-drop-marker").count(), 1, "用户类型同级排序时应显示插入位置");
  await page.mouse.up();
  await page.keyboard.press("Control+z");
  const rootAudience = page.locator(`[data-audience-node="${embedded.audience.rootId}"]`);
  await rootAudience.click();
  const audienceCount = await page.locator(".pc-audience-node").count();
  await page.locator('[data-audience-action="add"]').click();
  assert.equal(await page.locator(".pc-audience-node").count(), audienceCount + 1, "用户类型管理应支持新增下级");
  await page.locator(".pc-audience-node .pc-inline-name").waitFor({ state: "attached" });
  assert.equal(await page.locator(".pc-audience-node .pc-inline-name").count(), 1, "用户类型管理新增节点后应直接进入名称编辑态");
  await page.locator(".pc-audience-node .pc-inline-name").fill("新增用户类型验收");
  await page.locator(".pc-audience-node .pc-inline-name").press("Enter");
  const canvasLeaf = page.locator(`[data-switch-profile="${embedded.viewState.activeProfileId}"]`).locator("xpath=..");
  const canvasLeafId = await canvasLeaf.getAttribute("data-audience-node");
  await canvasLeaf.click();
  await page.locator('[data-audience-action="add"]').click();
  await page.locator(".pc-dialog").waitFor({ state: "visible" });
  assert.match(await page.locator(".pc-dialog").textContent(), /画布会迁移/, "有内容的画布变为分类节点前必须提示迁移");
  await page.locator("[data-dialog-confirm]").click();
  assert.equal(await page.locator(`[data-audience-node="${canvasLeafId}"] [data-switch-profile]`).count(), 0, "迁移后原节点应变为分类节点");
  await page.locator(".pc-audience-node .pc-inline-name").waitFor({ state: "attached" });
  await page.locator(".pc-audience-node .pc-inline-name").press("Enter");
  const migratedLeaf = page.locator(`[data-parent-id="${canvasLeafId}"] [data-switch-profile]`).first();
  const migratedProfileId = await migratedLeaf.getAttribute("data-switch-profile");
  await migratedLeaf.locator("xpath=..").click();
  await page.keyboard.press("Delete");
  assert.equal(await page.locator(`[data-audience-node="${canvasLeafId}"] [data-switch-profile]`).count(), 1, "删除唯一子节点后，原节点应恢复画布入口");
  await page.keyboard.press("Control+z");
  await page.locator(`[data-switch-profile="${migratedProfileId}"]`).click();
  await page.locator('[data-audience-overlay]').waitFor({ state: "hidden" });

  await page.locator('[data-mode="snapshot"]').click();
  await page.keyboard.press("Home");
  const visibleBoundId = await page.evaluate(() => {
    const viewport = document.querySelector("[data-viewport]").getBoundingClientRect();
    const center = { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 };
    return [...document.querySelectorAll(".pc-node")].filter(node => node.querySelector(".pc-bound")).map(node => {
      const rect = node.getBoundingClientRect();
      return { id: node.dataset.nodeId, visible: rect.right > viewport.left && rect.left < viewport.right && rect.bottom > viewport.top && rect.top < viewport.bottom, distance: Math.hypot(rect.left + rect.width / 2 - center.x, rect.top + rect.height / 2 - center.y) };
    }).filter(item => item.visible).sort((a, b) => a.distance - b.distance)[0]?.id || null;
  });
  assert.ok(visibleBoundId, "快照视图应存在可见的已关联节点");
  const boundNode = page.locator(`.pc-node[data-node-id="${visibleBoundId}"]`);
  const draggableMedia = page.locator(".pc-node .pc-node-media").first();
  const draggedNodeId = await draggableMedia.locator("xpath=..").getAttribute("data-node-id");
  const draggedMediaBox = await draggableMedia.boundingBox();
  const scenarioBox = await scenario.boundingBox();
  await page.mouse.move(draggedMediaBox.x + draggedMediaBox.width / 2, draggedMediaBox.y + draggedMediaBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(scenarioBox.x + scenarioBox.width / 2, scenarioBox.y + scenarioBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await waitForSession(editor.sessionPath, manifest => manifest.nodes.find(node => node.id === draggedNodeId)?.parentId === scenarioId);
  await page.keyboard.press("Control+z");
  await page.locator('[data-action="zoom-reset"]').click();
  await page.waitForTimeout(260);
  assert.equal(await page.locator(".pc-live-frame.is-inline").count(), 0, "较小倍率下不应过早切换为 HTML 预览");
  await page.locator('[data-action="zoom-in"]').click();
  await page.locator('[data-action="zoom-in"]').click();
  await page.waitForTimeout(260);
  assert.equal(await page.locator(".pc-live-frame.is-inline").count(), 0, "135% 左右仍应保留轻量快照");
  await page.evaluate(() => {
    window.__prototypeCanvasStableMessages = [];
    window.addEventListener("message", event => {
      if (event.data?.__prototypeCanvas && event.data.type === "prototype:render-stable") {
        window.__prototypeCanvasStableMessages.push(event.data.requestId);
      }
    });
  });
  for (let index = 0; index < 4; index += 1) await page.locator('[data-action="zoom-in"]').click();
  await page.locator(".pc-live-frame.is-inline iframe").waitFor({ state: "attached", timeout: 8000 });
  await page.locator(".pc-live-frame.is-inline.is-ready.is-visible").waitFor({ state: "attached", timeout: 8000 });
  const stableMessages = await page.evaluate(() => window.__prototypeCanvasStableMessages);
  const latestStableRequest = stableMessages.at(-1);
  assert.equal(stableMessages.filter(requestId => requestId === latestStableRequest).length, 1, "每个 iframe 加载周期只能执行一次页面定位回放");
  assert.equal(await page.locator(".pc-live-frame.is-inline").count(), 1, "同一时间只能加载一个节点内真实预览");
  assert.equal(await page.locator("[data-live-layer] > .pc-live-frame.is-inline").count(), 1, "HTML 预览应固定挂载到画布预览层，不能再次嵌入节点造成偏移");
  const liveTargetBefore = await page.locator(".pc-live-frame.is-inline").getAttribute("data-node-id");
  const switchTarget = await page.evaluate(currentId => {
    const viewport = document.querySelector("[data-viewport]").getBoundingClientRect();
    const center = { x: (viewport.left + viewport.right) / 2, y: (viewport.top + viewport.bottom) / 2 };
    const candidates = [...document.querySelectorAll(".pc-node")].filter(node => node.dataset.nodeId !== currentId && node.querySelector(".pc-bound")).map(node => {
      const rect = node.getBoundingClientRect();
      const nodeCenter = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
      return { id: node.dataset.nodeId, dx: nodeCenter.x - center.x, dy: nodeCenter.y - center.y, distance: Math.hypot(nodeCenter.x - center.x, nodeCenter.y - center.y) };
    }).sort((left, right) => left.distance - right.distance);
    return candidates[0] || null;
  }, liveTargetBefore);
  if (switchTarget) {
    const switchStartedAt = Date.now();
    await page.mouse.move(mainViewportBox.x + mainViewportBox.width / 2, mainViewportBox.y + mainViewportBox.height / 2);
    await page.mouse.wheel(switchTarget.dx, switchTarget.dy);
    await page.waitForFunction(targetId => document.querySelector(".pc-live-frame.is-inline")?.dataset.nodeId === targetId, switchTarget.id, { timeout: 1000 });
    assert.ok(Date.now() - switchStartedAt < 650, "连续滚动画布后 HTML 预览应及时切换到新的中心节点");
    await page.mouse.wheel(-switchTarget.dx, -switchTarget.dy);
    await page.waitForFunction(targetId => document.querySelector(".pc-live-frame.is-inline")?.dataset.nodeId === targetId, liveTargetBefore, { timeout: 1000 });
    await page.locator(".pc-live-frame.is-inline.is-ready").waitFor({ state: "attached", timeout: 8000 });
  }
  const liveGeometry = await page.locator(".pc-live-frame.is-inline").evaluate(frame => {
    const frameRect = frame.getBoundingClientRect();
    const targetSlot = document.querySelector(".pc-node-media.is-live");
    const slotRect = targetSlot?.getBoundingClientRect();
    return { borderRadius: getComputedStyle(frame).borderRadius, delta: slotRect ? Math.max(Math.abs(frameRect.left - slotRect.left), Math.abs(frameRect.top - slotRect.top), Math.abs(frameRect.width - slotRect.width), Math.abs(frameRect.height - slotRect.height)) : 999 };
  });
  assert.ok(liveGeometry.delta < 2 && liveGeometry.borderRadius !== "0px", `HTML 预览应立即对齐节点媒体区并保留圆角边界：${JSON.stringify(liveGeometry)}`);
  await page.locator(".pc-live-frame.is-inline iframe").evaluate(frame => { frame.dataset.instance = "stable-preview"; });
  await boundNode.locator("header").click();
  await page.waitForTimeout(220);
  assert.equal(await page.locator('iframe[data-instance="stable-preview"]').count(), 1, "点击节点只应选中节点，不得把 HTML 预览切回快照");
  const liveBox = await page.locator(".pc-live-frame.is-inline").boundingBox();
  const viewportBox = await page.locator(".pc-viewport").boundingBox();
  const previewPoint = {
    x: (Math.max(liveBox.x, viewportBox.x) + Math.min(liveBox.x + liveBox.width, viewportBox.x + viewportBox.width)) / 2,
    y: (Math.max(liveBox.y, viewportBox.y) + Math.min(liveBox.y + liveBox.height, viewportBox.y + viewportBox.height)) / 2
  };
  await page.mouse.move(previewPoint.x, previewPoint.y);
  await page.mouse.wheel(0, 24);
  await page.waitForTimeout(320);
  assert.equal(await page.locator('iframe[data-instance="stable-preview"]').count(), 1, "小幅移动画布时不得重新加载同一 HTML 预览");
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -24); await page.keyboard.up("Control");
  await page.waitForTimeout(320);
  assert.equal(await page.locator('iframe[data-instance="stable-preview"]').count(), 1, "小幅缩放画布时不得重新加载同一 HTML 预览");
  const inlineFill = await page.locator(".pc-live-frame.is-inline iframe").evaluate(frame => ({ left: frame.style.left, top: frame.style.top, width: parseFloat(frame.style.width), renderedWidth: frame.getBoundingClientRect().width, slotWidth: frame.parentElement.getBoundingClientRect().width }));
  assert.equal(inlineFill.left, "0px"); assert.equal(inlineFill.top, "0px");
  assert.ok(Math.abs(inlineFill.renderedWidth - inlineFill.slotWidth) < 2, `HTML 预览应按宽度等比铺满：${JSON.stringify(inlineFill)}`);
  const ratio = await page.locator(".pc-live-frame.is-inline iframe").evaluate(frame => parseFloat(frame.style.width) / parseFloat(frame.style.height));
  assert.ok(Math.abs(ratio - 1440 / 900) < .001, "真实原型应按原始宽高等比缩放");
  const previewRatio = await boundNode.locator(".pc-node-media").evaluate(node => node.clientWidth / node.clientHeight);
  assert.ok(Math.abs(previewRatio - 1440 / 900) < .02, `预览卡片应与原型截图保持相同宽高比：${previewRatio}`);
  const currentViewportBox = await page.locator(".pc-viewport").boundingBox();
  await page.mouse.move(currentViewportBox.x + currentViewportBox.width / 2, currentViewportBox.y + currentViewportBox.height / 2);
  await page.keyboard.down("Control"); await page.mouse.wheel(0, 1800); await page.keyboard.up("Control");
  await page.waitForTimeout(320);
  assert.equal(await page.locator(".pc-live-frame.is-inline").count(), 0, "缩小后应卸载 HTML 预览");
  const restoredSnapshot = await boundNode.locator(".pc-snapshot").evaluate(image => {
    const imageRect = image.getBoundingClientRect(); const mediaRect = image.parentElement.getBoundingClientRect();
    return { complete: image.complete, naturalWidth: image.naturalWidth, opacity: getComputedStyle(image).opacity, objectFit: getComputedStyle(image).objectFit, mediaClass: image.parentElement.className, delta: Math.max(Math.abs(imageRect.left - mediaRect.left), Math.abs(imageRect.top - mediaRect.top), Math.abs(imageRect.width - mediaRect.width), Math.abs(imageRect.height - mediaRect.height)) };
  });
  assert.equal(restoredSnapshot.complete && restoredSnapshot.naturalWidth > 0 && Number(restoredSnapshot.opacity) > .9, true, `缩小后必须恢复已加载的快照图：${JSON.stringify(restoredSnapshot)}`);
  assert.equal(restoredSnapshot.objectFit, "contain", "缩小后快照应保持完整等比显示");
  assert.ok(restoredSnapshot.delta < 2, `缩小后快照应立即对齐媒体区域：${JSON.stringify(restoredSnapshot)}`);
  await page.keyboard.press("Home");
  await page.locator('[data-action="zoom-reset"]').click();
  for (let index = 0; index < 6; index += 1) await page.locator('[data-action="zoom-in"]').click();
  await page.locator(".pc-live-frame.is-inline.is-ready.is-visible").waitFor({ state: "attached", timeout: 8000 });
  assert.equal(await page.locator(".pc-live-frame.is-inline").count(), 1, "重新放大后应自动恢复 HTML 预览，无需点击节点");

  const reusedNodeId = await page.locator(".pc-live-frame.is-inline").getAttribute("data-node-id");
  const reusedNode = page.locator(`.pc-node[data-node-id="${reusedNodeId}"]`);
  await page.locator(".pc-live-frame.is-inline iframe").evaluate(frame => { frame.dataset.instance = "promote-without-reload"; });
  const reusedNodeBox = await reusedNode.boundingBox();
  await reusedNode.dblclick({ position: { x: reusedNodeBox.width / 2, y: reusedNodeBox.height / 2 } });
  await page.locator("[data-prototype-overlay]").waitFor({ state: "visible" });
  assert.equal(await page.locator('.pc-live-frame.is-overlay iframe[data-instance="promote-without-reload"]').count(), 1, "双击已加载节点时应直接复用实时 HTML，不得重新解析原型");
  await page.locator('[data-action="prototype-back"]').click();
  await page.locator("[data-prototype-overlay]").waitFor({ state: "hidden" });
  await page.locator(".pc-live-frame.is-inline.is-ready.is-visible").waitFor({ state: "attached", timeout: 8000 });

  await boundNode.evaluate(node => node.click());
  await page.locator('[data-action="locate"]').click();
  await page.locator("[data-prototype-overlay]").waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-action="locate-confirm"]').isVisible(), true, "编辑关联应进入原型定位模式");
  await page.locator('[data-action="locate-cancel"]').click();

  await scenario.evaluate(node => node.click());
  await page.locator('[data-action="locate"]').click();
  await page.locator("[data-prototype-overlay]").waitFor({ state: "visible" });
  await page.locator(".pc-live-frame.is-overlay.is-ready").waitFor({ state: "attached", timeout: 8000 });
  await page.frameLocator(".pc-live-frame.is-overlay iframe").locator("#openDetail").click();
  await page.frameLocator(".pc-live-frame.is-overlay iframe").locator("#detail").waitFor({ state: "visible" });
  await page.waitForTimeout(180);
  assert.equal(await page.locator('[data-action="locate-confirm"]').isEnabled(), true, "原型阻断后续点击监听时仍应完成定位");
  await page.route("**/api/session/*/capture", async route => {
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ ok: false, code: "EDITOR_PAGE_EXPIRED", error: "Token 无效。" }) });
  }, { times: 1 });
  await page.locator('[data-action="locate-confirm"]').click();
  await page.locator("[data-operation-mask]").waitFor({ state: "visible" });
  assert.match(await page.locator("[data-operation-mask]").textContent(), /正在确认页面关联.*不要刷新页面/s, "关联进行中必须显示明显的阻断式蒙层");
  await page.locator(".pc-dialog").waitFor({ state: "visible" });
  assert.match(await page.locator(".pc-dialog").textContent(), /服务已经重启.*刷新浏览器页面/s, "关联异常必须转换为普通用户能理解的处理建议");
  assert.equal((await page.locator(".pc-dialog").textContent()).includes("Token"), false, "异常弹窗不得泄露 Token 技术提示");
  await page.locator(".pc-dialog [data-dialog-confirm]").click();
  await page.route("**/api/session/*/capture", async route => {
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.continue();
  }, { times: 1 });
  await page.locator('[data-action="locate-confirm"]').click();
  await page.locator("[data-operation-mask]").waitFor({ state: "visible" });
  await page.locator("[data-operation-mask]").waitFor({ state: "hidden", timeout: 15000 });
  const scenarioPreview = page.locator(`.pc-node[data-node-id="${scenarioId}"]`);
  assert.equal(await scenarioPreview.locator(".pc-snapshot-loading,.pc-snapshot").count(), 1, "提交关联后应立即显示渲染反馈或快照");
  await scenarioPreview.locator(".pc-snapshot").waitFor({ state: "attached", timeout: 12000 });
  assert.equal(await scenarioPreview.locator(".pc-snapshot").evaluate(image => image.complete && image.naturalWidth > 0), true, "localhost 关联页面后应自动生成并显示快照");

  await page.locator('[data-action="export"]').click();
  assert.equal(await page.locator("[data-export-mode]").count(), 2, "导出弹窗应只保留两种 SVG 导出");
  assert.equal(await page.locator(".pc-dialog").getByText("PNG").count(), 0, "导出弹窗不得再显示 PNG");
  const downloadPromise = page.waitForEvent("download");
  await page.locator('[data-export-mode="snapshot"]').click();
  const download = await downloadPromise;
  const exported = path.join(outputDir, "页面快照导图.svg");
  await download.saveAs(exported);
  const exportedSvg = fs.readFileSync(exported, "utf8");
  assert.match(exportedSvg, /图例 · 页面快照/, "快照 SVG 应包含对应图例");
  assert.match(exportedSvg, /<image href="data:image\//, "快照 SVG 应内嵌原型图片");
  assert.equal((exportedSvg.match(/data-node-id=/g) || []).length, await page.locator(".pc-node").count(), "导出 SVG 应包含当前完整导图的每个可见节点");
  assert.equal((exportedSvg.match(/class="pc-node"/g) || []).length, 0, "导出 SVG 不应依赖运行时 DOM 类名");
  for (const title of await page.locator(".pc-node [data-node-title]").allTextContents()) assert.ok(exportedSvg.includes(title), `完整 SVG 应包含节点：${title}`);
  const mindmapDownloadPromise = page.waitForEvent("download");
  await page.locator('[data-action="export"]').click();
  await page.locator('[data-export-mode="mindmap"]').click();
  const mindmapDownload = await mindmapDownloadPromise;
  const mindmapExported = path.join(outputDir, "思维导图.svg");
  await mindmapDownload.saveAs(mindmapExported);
  assert.match(fs.readFileSync(mindmapExported, "utf8"), /图例 · 思维导图/, "思维导图 SVG 应包含对应图例");

  const screenshot = path.join(outputDir, "localhost-画布-v2.png");
  await page.screenshot({ path: screenshot, fullPage: true });

  const standalonePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await standalonePage.goto(standaloneUrl, { waitUntil: "load" });
  await standalonePage.locator('[data-runtime-status="ready"]').waitFor({ timeout: 12000 });
  const standaloneStartId = await standalonePage.locator('.pc-node[data-type="start"]').first().getAttribute("data-node-id");
  const standaloneCount = await standalonePage.locator(".pc-node").count();
  await standalonePage.locator(`[data-collapse="${standaloneStartId}"]`).click();
  const standaloneCollapsedCount = await standalonePage.locator(".pc-node").count();
  assert.ok(standaloneCollapsedCount < standaloneCount, "导出 HTML 应允许收起节点");
  await standalonePage.reload({ waitUntil: "load" });
  await standalonePage.locator('[data-runtime-status="ready"]').waitFor({ timeout: 12000 });
  assert.equal(await standalonePage.locator(".pc-node").count(), standaloneCollapsedCount, "导出 HTML 刷新后应恢复节点收起状态");
  await standalonePage.locator(`[data-collapse="${standaloneStartId}"]`).click();
  await standalonePage.locator('[data-mode="snapshot"]').click();
  await standalonePage.keyboard.press("Home");
  for (let index = 0; index < 14; index += 1) await standalonePage.locator('[data-action="zoom-in"]').click();
  const standaloneLiveFrame = standalonePage.locator(".pc-live-frame.is-inline.is-ready.is-visible");
  try {
    await standaloneLiveFrame.waitFor({ state: "attached", timeout: 10000 });
  } catch (error) {
    const debug = await standalonePage.evaluate(() => ({
      zoom: document.querySelector("[data-action='zoom-reset']")?.textContent,
      mode: document.querySelector("[data-mode].is-active")?.dataset.mode,
      boundNodes: [...document.querySelectorAll(".pc-node")].filter(node => node.querySelector(".pc-bound")).map(node => ({ id: node.dataset.nodeId, width: node.getBoundingClientRect().width })),
      frames: [...document.querySelectorAll(".pc-live-frame")].map(frame => ({ className: frame.className, nodeId: frame.dataset.nodeId, src: frame.querySelector("iframe")?.getAttribute("src"), srcdocLength: frame.querySelector("iframe")?.getAttribute("srcdoc")?.length || 0 }))
    }));
    throw new Error(`直接打开导出 HTML 后，高清预览未就绪：${JSON.stringify(debug)}`, { cause: error });
  }
  const standaloneIframe = standaloneLiveFrame.locator("iframe");
  assert.equal(await standaloneIframe.getAttribute("src"), null, "离线 HTML 的原型预览不得使用 blob:null 地址");
  assert.ok((await standaloneIframe.getAttribute("srcdoc"))?.includes("审核工作台"), "离线 HTML 应直接内嵌原型源码");
  assert.match(await standalonePage.frameLocator(".pc-live-frame.is-inline iframe").locator("body").innerText(), /待审核任务|审核通过|任务详情/, "直接打开导出 HTML 时应完成页面回放并显示真实原型");

  const standaloneLiveNodeId = await standaloneLiveFrame.getAttribute("data-node-id");
  await standaloneIframe.evaluate(frame => { frame.dataset.instance = "failed-offline-preview"; });
  const standaloneConfig = await standalonePage.evaluate(() => JSON.parse(document.querySelector("#prototypeCanvasConfig").textContent));
  await standalonePage.frameLocator(".pc-live-frame.is-inline iframe").locator("body").evaluate((body, token) => {
    body.ownerDocument.defaultView.parent.postMessage({ __prototypeCanvas: true, token, type: "prototype:render-error", error: "离线回归测试" }, "*");
  }, standaloneConfig.bridgeToken);
  await standalonePage.locator(".pc-live-frame.is-inline.is-error").waitFor({ state: "attached" });
  const standaloneLiveNode = standalonePage.locator(`.pc-node[data-node-id="${standaloneLiveNodeId}"]`);
  const standaloneLiveNodeBox = await standaloneLiveNode.boundingBox();
  await standaloneLiveNode.dblclick({ position: { x: standaloneLiveNodeBox.width / 2, y: standaloneLiveNodeBox.height / 2 } });
  await standalonePage.locator("[data-prototype-overlay]").waitFor({ state: "visible" });
  assert.equal(await standalonePage.locator('iframe[data-instance="failed-offline-preview"]').count(), 0, "失败的节点内预览不得被复用到全屏原型");
  await standalonePage.locator(".pc-live-frame.is-overlay.is-ready").waitFor({ state: "attached", timeout: 10000 });
  assert.match(await standalonePage.frameLocator(".pc-live-frame.is-overlay iframe").locator("body").innerText(), /待审核任务|审核通过|任务详情/, "离线 HTML 双击节点后应打开已关联页面");
  await standalonePage.close();
  process.stdout.write(`${JSON.stringify({ status: "ok", pageErrors, temporaryArtifactsCleaned: true }, null, 2)}\n`);
} finally {
  await page.close();
  await browser.close();
  await new Promise(resolve => editor.server.close(resolve));
  fs.rmSync(outputDir, { recursive: true, force: true });
}

async function drag(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

function subtreeNodeIds(rootId, edges) {
  const result = [rootId];
  for (let index = 0; index < result.length; index += 1) {
    edges.filter(edge => edge.type === "hierarchy" && edge.source === result[index]).forEach(edge => result.push(edge.target));
  }
  return result;
}

async function clickSvgPathAtMiddle(page, locator) {
  const point = await locator.evaluate(pathElement => {
    const point = pathElement.getPointAtLength(pathElement.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(pathElement.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y);
}

async function hasVisibleNode(page, viewportSelector, nodeSelector) {
  return page.evaluate(({ viewportSelector, nodeSelector }) => {
    const viewport = document.querySelector(viewportSelector)?.getBoundingClientRect();
    if (!viewport) return false;
    return [...document.querySelectorAll(nodeSelector)].some(node => {
      const rect = node.getBoundingClientRect();
      return rect.right > viewport.left && rect.left < viewport.right && rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
  }, { viewportSelector, nodeSelector });
}

async function nearestCenterNode(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector("[data-viewport]").getBoundingClientRect();
    const center = { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 };
    return [...document.querySelectorAll(".pc-node")].map(node => {
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
      return { id: node.dataset.nodeId, x: x - viewport.left, y: y - viewport.top, d: Math.hypot(x - center.x, y - center.y) };
    }).sort((a, b) => a.d - b.d)[0];
  });
}

async function centerForNode(page, id) {
  return page.locator(`[data-node-id="${id}"]`).evaluate(node => {
    const viewport = document.querySelector("[data-viewport]").getBoundingClientRect(); const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2 - viewport.left, y: rect.top + rect.height / 2 - viewport.top };
  });
}

async function graphCenterDelta(page, viewportSelector, nodeSelector) {
  return page.evaluate(({ viewportSelector, nodeSelector }) => {
    const viewport = document.querySelector(viewportSelector).getBoundingClientRect();
    const boxes = [...document.querySelectorAll(nodeSelector)].map(node => node.getBoundingClientRect());
    const left = Math.min(...boxes.map(box => box.left));
    const top = Math.min(...boxes.map(box => box.top));
    const right = Math.max(...boxes.map(box => box.right));
    const bottom = Math.max(...boxes.map(box => box.bottom));
    return Math.hypot((left + right) / 2 - (viewport.left + viewport.right) / 2, (top + bottom) / 2 - (viewport.top + viewport.bottom) / 2);
  }, { viewportSelector, nodeSelector });
}

async function blankPoint(page) {
  const point = await page.evaluate(() => {
    const viewport = document.querySelector("[data-viewport]").getBoundingClientRect();
    for (const [rx, ry] of [[.04,.92],[.06,.16],[.88,.16],[.5,.92],[.85,.75]]) {
      const x = viewport.left + viewport.width * rx; const y = viewport.top + viewport.height * ry;
      const target = document.elementFromPoint(x, y);
      if (target?.closest("[data-viewport]") && !target.closest(".pc-node,.pc-minimap,.pc-inspector")) return { x, y };
    }
    return null;
  });
  assert.ok(point, "应找到画布空白区域"); return point;
}

async function waitForSession(sessionPath, predicate) {
  for (let index = 0; index < 40; index += 1) {
    const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    if (predicate(session.manifest)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail("等待编辑结果保存超时");
}

async function launchBrowser() {
  for (const options of [{ channel: "chrome", headless: true }, { channel: "msedge", headless: true }, { headless: true }]) {
    try { return await chromium.launch(options); } catch {}
  }
  throw new Error("没有可用的 Chromium 浏览器。");
}
