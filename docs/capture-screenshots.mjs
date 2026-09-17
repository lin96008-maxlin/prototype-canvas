// 生成 README 功能截图（1920×1080），输出到 docs/images。
// 用法：node docs/capture-screenshots.mjs [编辑地址]
// 需要先按 README 的说明启动 localhost 编辑模式。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const SKILL_HOME = process.env.PROTOTYPE_CANVAS_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex", "skills", "prototype-canvas");
const require = createRequire(path.join(SKILL_HOME, "package.json"));
const { chromium } = require("playwright");

const url = process.argv[2] || "http://127.0.0.1:8788/edit";
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "images");
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: "zh-CN" });
const page = await context.newPage();
page.on("dialog", dialog => dialog.dismiss().catch(() => {}));

const waitReady = async () => {
  await page.waitForFunction(() => document.getElementById("prototypeCanvasRoot")?.dataset.runtimeStatus === "ready", null, { timeout: 60000 });
  await page.waitForTimeout(2500);
};
const openFresh = async () => {
  await page.reload({ waitUntil: "load", timeout: 90000 });
  await waitReady();
  await page.click('[data-mode="mindmap"]').catch(() => {});
  await page.waitForTimeout(600);
};
// 自动适配后整棵树可能只有 20% 左右，节点文字不可读；先放大到可读比例再截图。
const zoomTo = async (targetPercent) => {
  for (let index = 0; index < 16; index += 1) {
    const current = Number.parseInt(await page.textContent('[data-action="zoom-reset"]'), 10);
    if (Number.isFinite(current) && current >= targetPercent) break;
    await page.click('[data-action="zoom-in"]');
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);
};
// 放大后视野落在树的中部，用鸟瞰图把视野拖到左上角（根节点与一级导航所在的区域）。
const panViaMinimap = async (fractionX, fractionY) => {
  const content = await page.locator("[data-minimap-content]").boundingBox();
  const marker = await page.locator("[data-mini-viewport]").first().boundingBox();
  if (!content || !marker) return;
  await page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2);
  await page.mouse.down();
  await page.mouse.move(content.x + content.width * fractionX, content.y + content.height * fractionY, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(700);
};
const shot = async (name, label) => {
  await page.screenshot({ path: path.join(outDir, name), type: "png" });
  console.log(`已生成 ${name}（${label}）`);
};

await page.goto(url, { waitUntil: "load", timeout: 90000 });
await waitReady();
await page.click('[data-mode="mindmap"]').catch(() => {});
await page.keyboard.press("Escape");
await page.keyboard.press("Home");
await page.waitForTimeout(700);
await zoomTo(70);
await panViaMinimap(0.2, 0.14);
await shot("01-mindmap.png", "思维导图模式");

await page.click('[data-mode="snapshot"]');
await page.waitForTimeout(800);
await zoomTo(58);
await panViaMinimap(0.3, 0.1);
await page.waitForFunction(() => document.querySelectorAll(".pc-node-media img").length > 0, null, { timeout: 30000 }).catch(() => {});
await page.waitForSelector(".pc-live-frame.is-ready", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
await shot("02-snapshot.png", "快照模式");

await openFresh();
await zoomTo(80);
await panViaMinimap(0.2, 0.14);
// 挑一个当前确实在视口内的节点（放大后很多节点在视口外，直接点会点不到）。
const selected = await page.evaluate(() => {
  const viewportRect = document.querySelector("[data-viewport]").getBoundingClientRect();
  const center = { x: viewportRect.left + viewportRect.width / 2, y: viewportRect.top + viewportRect.height / 2 };
  const candidates = [...document.querySelectorAll("[data-node-id]")]
    .map(node => ({ node, rect: node.getBoundingClientRect() }))
    .filter(item => item.rect.width > 80
      && item.rect.right > viewportRect.left + 40 && item.rect.left < viewportRect.right - 40
      && item.rect.bottom > viewportRect.top + 80 && item.rect.top < viewportRect.bottom - 40)
    .sort((left, right) => Math.hypot(left.rect.left + left.rect.width / 2 - center.x, left.rect.top + left.rect.height / 2 - center.y)
      - Math.hypot(right.rect.left + right.rect.width / 2 - center.x, right.rect.top + right.rect.height / 2 - center.y));
  const pick = candidates[0];
  return pick ? { id: pick.node.dataset.nodeId, x: pick.rect.left + pick.rect.width * 0.3, y: pick.rect.top + pick.rect.height / 2 } : null;
});
if (selected) {
  await page.mouse.click(selected.x, selected.y);
  await page.waitForTimeout(1500);
}
await shot("03-node-editing.png", "节点编辑");

await openFresh();
await page.click('[data-action="audience"]');
await page.waitForTimeout(2000);
await shot("04-audience.png", "用户类型");

await openFresh();
await page.click('[data-action="shortcuts"]');
await page.waitForTimeout(1500);
await shot("05-shortcuts.png", "快捷键");

// 放大到节点足够大时，画布会自动在该节点位置加载真实原型（无需选中）。
await openFresh();
await page.click('[data-mode="snapshot"]');
await page.waitForTimeout(800);
await zoomTo(190);
await panViaMinimap(0.3, 0.1);
const liveReady = await page.waitForSelector(".pc-live-frame.is-ready", { timeout: 45000 }).then(() => true).catch(() => false);
if (!liveReady) {
  await zoomTo(230);
  await panViaMinimap(0.3, 0.1);
  await page.waitForSelector(".pc-live-frame.is-ready", { timeout: 45000 }).catch(() => {});
}
await page.waitForTimeout(3000);
await shot("06-live-prototype.png", "放大自动加载真实原型");

// 双击节点直接进入该节点关联的页面。未关联的节点不会打开原型，所以逐个试到打开为止。
await openFresh();
await zoomTo(120);
const candidates = await page.evaluate(() => {
  const viewportRect = document.querySelector("[data-viewport]").getBoundingClientRect();
  return [...document.querySelectorAll("[data-node-id]")]
    .map(node => ({ node, rect: node.getBoundingClientRect() }))
    .filter(item => item.rect.width > 90
      && item.rect.left > viewportRect.left + 30 && item.rect.right < viewportRect.right - 30
      && item.rect.top > viewportRect.top + 60 && item.rect.bottom < viewportRect.bottom - 30)
    // 优先挑已关联的节点（未关联的节点双击不会打开原型）；双击位置取标题以下的主体，避免触发"双击标题改名"。
    .sort((left, right) => Number(Boolean(right.node.querySelector(".pc-bound"))) - Number(Boolean(left.node.querySelector(".pc-bound"))) || left.rect.top - right.rect.top)
    .slice(0, 8)
    .map(item => ({ id: item.node.dataset.nodeId, x: item.rect.left + item.rect.width * 0.4, y: item.rect.top + item.rect.height * 0.85 }));
});
let opened = false;
for (const candidate of candidates) {
  await page.mouse.dblclick(candidate.x, candidate.y);
  await page.waitForTimeout(1800);
  opened = await page.evaluate(() => !document.querySelector("[data-prototype-overlay]")?.hidden);
  if (opened) {
    console.log(`双击打开原型：${candidate.id}`);
    break;
  }
}
if (opened) {
  await page.waitForTimeout(7000);
  await shot("07-open-prototype.png", "双击进入原型页面");
} else {
  console.log("未找到可打开原型的节点，跳过 07");
}

await browser.close();
