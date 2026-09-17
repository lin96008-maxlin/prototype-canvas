import { pathToFileURL } from "node:url";
import { installReplayRuntime, launchBrowser } from "./capture.mjs";

// 结构探查：不依赖任何原型专属属性，靠真实点击结果判定"哪个入口能走到哪个页面/浮层"。
// 每个入口都在全新页面里从初始状态单独试一次，互不影响；有时间预算与入口数量上限。
const ENTRY_SELECTOR = 'button,a[href],[role="button"],[role="menuitem"],[role="tab"],[role="option"],input[type="button"],input[type="submit"],summary';

export const DEFAULT_PROBE_ENTRIES = 48;
export const DEFAULT_PROBE_BUDGET_MS = 180000;

// 展开默认收起的导航分组：只点开带 aria-expanded="false" 的折叠控件，不触发页面跳转。
// 探查和每个探测页面都要做同一步，否则展开后才出现的入口在新页面里根本点不到。
async function expandNavigation(page) {
  try {
    const count = await page.evaluate(() => {
      const runtime = globalThis.__PrototypeCanvasReplay;
      const scope = 'nav,aside,header,[role="navigation"],[class*="menu"],[class*="sidebar"]';
      const toggles = [...document.querySelectorAll('[aria-expanded="false"]')]
        .filter(element => element.closest(scope) && runtime.visible(element));
      for (const toggle of toggles.slice(0, 16)) runtime.activate(toggle);
      return toggles.length;
    });
    if (count) await page.waitForTimeout(280);
    return count;
  } catch {
    return 0;
  }
}

export async function probePrototype({ sourceFile, viewport, maxEntries = DEFAULT_PROBE_ENTRIES, concurrency = 3, timeout = 5000, budgetMs = DEFAULT_PROBE_BUDGET_MS }) {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(15000, Number(budgetMs) || DEFAULT_PROBE_BUDGET_MS);
  const size = {
    width: Math.max(320, Number(viewport?.width || 1440)),
    height: Math.max(568, Number(viewport?.height || 900))
  };
  const progress = message => {
    if (process.env.PROTOTYPE_CANVAS_PROGRESS === "0") return;
    process.stderr.write(`${message}\n`);
  };
  const { browser, browserName } = await launchBrowser();
  let candidates = [];
  let selects = [];
  let baseline = null;
  try {
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, locale: "zh-CN" });
    const page = await context.newPage();
    page.on("dialog", dialog => dialog.dismiss().catch(() => {}));
    await installReplayRuntime(page);
    await page.goto(pathToFileURL(sourceFile).href, { waitUntil: "load", timeout });
    await page.waitForTimeout(300);
    await expandNavigation(page);
    const survey = await page.evaluate(selector => {
      const runtime = globalThis.__PrototypeCanvasReplay;
      const items = [];
      const seen = new Set();
      for (const element of document.querySelectorAll(selector)) {
        if (!runtime.visible(element)) continue;
        const locator = runtime.locatorFor(element);
        const text = String(locator.locator?.text || "").replace(/\s+/g, " ").trim().slice(0, 40);
        if (!text || !locator.selector) continue;
        const signature = JSON.stringify([locator.selector, text]);
        if (seen.has(signature)) continue;
        seen.add(signature);
        const rect = element.getBoundingClientRect();
        items.push({
          locator,
          text,
          role: locator.locator?.role || element.localName,
          inNav: Boolean(element.closest('nav,aside,header,[role="navigation"],[role="menubar"],[class*="menu"],[class*="sidebar"]')),
          area: Math.round(rect.width * rect.height)
        });
      }
      items.sort((left, right) => (Number(right.inNav) - Number(left.inNav)) || (left.area - right.area));
      const selects = [...document.querySelectorAll("select")].map(element => ({
        selector: runtime.locatorFor(element).selector,
        label: element.getAttribute("aria-label") || element.id || element.name || "",
        options: [...element.options].map(option => ({ value: option.value, text: String(option.textContent || "").trim() })).slice(0, 12)
      })).filter(item => item.options.length > 1);
      return { entries: items, selects, baseline: runtime.surfaceState() };
    }, ENTRY_SELECTOR);
    candidates = survey.entries.slice(0, Math.max(1, Number(maxEntries) || DEFAULT_PROBE_ENTRIES));
    selects = survey.selects;
    baseline = survey.baseline;
    await context.close();
  } finally {
    // 候选枚举阶段结束；下面按候选逐个开新页面探测。
  }
  progress(`[原型画布] 结构探查：发现 ${candidates.length} 个可点入口（上限 ${maxEntries}），并行 ${concurrency} 路。`);

  const tasks = candidates.map((candidate, index) => ({ index, candidate }));
  const workerCount = Math.max(1, Math.min(Math.round(Number(concurrency) || 3), tasks.length || 1));
  const groups = Array.from({ length: workerCount }, () => []);
  tasks.forEach((task, index) => groups[index % workerCount].push(task));
  let outputs = [];
  try {
    outputs = (await Promise.all(groups.map(group => runProbeWorker({ browser, tasks: group, sourceFile, viewport: size, timeout, deadline })))).flat();
  } finally {
    await browser.close();
  }
  outputs.sort((left, right) => left.index - right.index);

  const probed = outputs.filter(item => !item.skipped);
  const changed = probed.filter(item => item.ok && item.changed);
  const pages = [];
  const overlays = [];
  const states = [];
  for (const item of changed) {
    const reached = item.reached;
    if (!reached?.selector) continue;
    const bucket = reached.kind === "overlay" ? overlays : reached.kind === "page" ? pages : states;
    let group = bucket.find(entry => entry.selector === reached.selector);
    if (!group) {
      group = { selector: reached.selector, label: reached.label || "", entries: [] };
      bucket.push(group);
    }
    group.entries.push({ text: item.candidate.text, selector: item.candidate.locator.selector, actions: item.actions });
  }
  progress(`[原型画布] 结构探查结束：页面 ${pages.length} 个，浮层 ${overlays.length} 个，无效入口 ${probed.length - changed.length}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒。`);
  return {
    format: "prototype-canvas-probe@1",
    browser: browserName,
    viewport: size,
    counts: {
      entries: candidates.length,
      probed: probed.length,
      changed: changed.length,
      pages: pages.length,
      overlays: overlays.length,
      states: states.length,
      dead: probed.filter(item => item.ok && !item.changed).length,
      failed: probed.filter(item => !item.ok).length,
      skipped: outputs.filter(item => item.skipped).length
    },
    baseline: baseline ? { pages: baseline.regions, overlays: baseline.overlays, tabs: baseline.activeTabs } : null,
    pages,
    overlays,
    states,
    selects,
    deadEntries: probed.filter(item => item.ok && !item.changed).map(item => ({ text: item.candidate.text, selector: item.candidate.locator.selector })),
    failedEntries: probed.filter(item => !item.ok).map(item => ({ text: item.candidate.text, selector: item.candidate.locator.selector, error: item.error })),
    elapsedMs: Date.now() - startedAt
  };
}

async function runProbeWorker({ browser, tasks, sourceFile, viewport, timeout, deadline }) {
  if (!tasks.length) return [];
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "zh-CN" });
  const outputs = [];
  try {
    for (const task of tasks) {
      if (Date.now() > deadline) {
        outputs.push({ index: task.index, candidate: task.candidate, skipped: true });
        continue;
      }
      const page = await context.newPage();
      page.on("dialog", dialog => dialog.dismiss().catch(() => {}));
      await installReplayRuntime(page);
      try {
        // 每个入口都从整页初始状态开始，避免前一次点击影响判断。
        await page.goto(pathToFileURL(sourceFile).href, { waitUntil: "load", timeout });
        await page.waitForTimeout(150);
        await expandNavigation(page);
        const result = await page.evaluate(async record => {
          const runtime = globalThis.__PrototypeCanvasReplay;
          const before = runtime.surfaceState();
          const element = runtime.find(record, { visibleOnly: true });
          if (!element) return { ok: false, error: "入口不可见或已失效" };
          runtime.activate(element);
          await new Promise(resolve => setTimeout(resolve, 420));
          const after = runtime.surfaceState();
          const target = runtime.locateTarget(element, before);
          const locator = target ? runtime.locatorFor(target) : null;
          const key = target ? runtime.surfaceKey(target) : null;
          return {
            ok: true,
            changed: !runtime.sameSurface(before, after),
            reached: locator ? {
              selector: locator.selector,
              label: runtime.labelFor(target),
              // 只有真的出现了页面容器或浮层才算"到达页面"，其余只是界面状态变化（展开菜单、翻页、切标签）。
              kind: after.overlays.includes(key) ? "overlay" : after.regions.includes(key) ? "page" : "state"
            } : null,
            actions: locator ? [{ type: "click", ...record, delay: 120 }] : []
          };
        }, task.candidate.locator);
        outputs.push({ index: task.index, candidate: task.candidate, ...result });
      } catch (error) {
        outputs.push({ index: task.index, candidate: task.candidate, ok: false, error: String(error?.message || error).slice(0, 120) });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await context.close();
  }
  return outputs;
}
