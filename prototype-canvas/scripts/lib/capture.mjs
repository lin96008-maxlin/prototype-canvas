import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { bindingForProfile, normalizeManifest, validateManifest } from "./manifest-v2.mjs";
import { readJson, sha256, writeJson } from "./common.mjs";
import { createPrototypeReplayRuntime } from "./prototype-replay.mjs";

const DEFAULT_CONCURRENCY = 3;
const OVERLAY_TYPES = new Set(["drawer", "modal", "dialog", "sheet", "popover", "overlay"]);
const OVERLAY_VISIBLE_SCRIPT = () => {
  const selector = '[role="dialog"],dialog,[aria-modal="true"],[class*="modal"],[class*="drawer"],[class*="overlay"],[class*="sheet"]';
  return [...document.querySelectorAll(selector)].some(element => {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
  });
};

export async function captureSnapshots({ sourceFile, manifestPath, quality = 74, timeout = 5000, force = false, concurrency = DEFAULT_CONCURRENCY }) {
  const manifest = normalizeManifest(readJson(manifestPath));
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new Error(`Manifest 校验失败：\n${validation.errors.join("\n")}`);
  const sourceHash = sha256(fs.readFileSync(sourceFile));
  if (manifest.prototype.sourceHash !== sourceHash) throw new Error("Manifest 与源 HTML Hash 不一致，禁止采集快照。");

  const viewport = {
    width: Math.max(320, Number(manifest.prototype.viewport?.width || 1440)),
    height: Math.max(568, Number(manifest.prototype.viewport?.height || 900))
  };
  const profiles = manifest.profiles.length
    ? manifest.profiles
    : manifest.canvases.map(canvas => ({ id: "all", name: canvas.name, attributes: {}, canvasId: canvas.id, source: "canvas" }));
  const report = { browser: null, captured: 0, reused: 0, skipped: 0, unavailable: 0, failed: 0, retried: 0, concurrency: 1, elapsedMs: 0, averageMs: 0, items: [] };
  const stamp = () => new Date().toISOString();

  // 先规划：没有关联的标记不可用，已就绪的跳过，剩下的才进入采集。
  const tasks = [];
  for (const profile of profiles) {
    for (const node of manifest.nodes.filter(item => item.canvasId === profile.canvasId)) {
      const key = `${node.id}::${profile.id}`;
      const binding = bindingForProfile(node, profile.id);
      if (!binding) {
        manifest.snapshots[key] = { sourceHash, capturedAt: stamp(), status: "unavailable", error: "节点尚未关联原型页面" };
        report.unavailable += 1;
        report.items.push({ key, status: "unavailable", error: "节点尚未关联原型页面" });
        continue;
      }
      const existing = manifest.snapshots[key];
      if (!force && existing?.sourceHash === sourceHash && ["ready", "unavailable"].includes(existing.status)) {
        report.skipped += 1;
        report.items.push({ key, status: existing.status, skipped: true });
        continue;
      }
      tasks.push({ index: tasks.length, key, profile, node: { ...node, ...binding } });
    }
  }

  // 同一画布下的节点互不依赖，按轮转切分给多个隔离上下文并行采集。
  const workerCount = Math.max(1, Math.min(Math.round(Number(concurrency) || DEFAULT_CONCURRENCY), tasks.length || 1));
  const groups = Array.from({ length: workerCount }, () => []);
  tasks.forEach((task, index) => groups[index % workerCount].push(task));

  const { browser, browserName } = await launchBrowser();
  report.browser = browserName;
  report.concurrency = workerCount;
  let finished = 0;
  const progress = message => {
    if (process.env.PROTOTYPE_CANVAS_PROGRESS === "0") return;
    process.stderr.write(`${message}\n`);
  };
  progress(`[原型画布] 待采集 ${tasks.length} 个节点，并行 ${workerCount} 路；跳过 ${report.skipped} 个，未关联 ${report.unavailable} 个。`);
  const startedAt = Date.now();
  try {
    const outputs = (await Promise.all(groups.map(group => runCaptureWorker({
      browser,
      tasks: group,
      sourceFile,
      dimensions: manifest.dimensions || [],
      viewport,
      quality,
      timeout,
      onProgress: () => {
        finished += 1;
        if (finished % 10 === 0 || finished === tasks.length) progress(`[原型画布] 已完成 ${finished}/${tasks.length}`);
      }
    })))).flat();

    const assetHashes = new Set(Object.keys(manifest.snapshotAssets || {}));
    for (const output of outputs.sort((left, right) => left.index - right.index)) {
      if (!output.ok) {
        manifest.snapshots[output.key] = { sourceHash, capturedAt: stamp(), status: "failed", error: output.error };
        report.failed += 1;
        report.items.push({ key: output.key, status: "failed", error: output.error });
        continue;
      }
      const reused = assetHashes.has(output.hash);
      if (reused) report.reused += 1;
      else {
        assetHashes.add(output.hash);
        manifest.snapshotAssets[output.hash] = output.asset;
      }
      manifest.snapshots[output.key] = {
        hash: output.hash,
        assetHash: output.hash,
        width: output.width,
        height: output.height,
        sourceHash,
        capturedAt: stamp(),
        status: "ready"
      };
      report.captured += 1;
      if (output.retried) report.retried += 1;
      report.items.push({ key: output.key, status: "ready", hash: output.hash, reused, ms: output.ms });
    }
  } finally {
    await browser.close();
  }
  report.elapsedMs = Date.now() - startedAt;
  report.averageMs = tasks.length ? Math.round(report.elapsedMs / tasks.length) : 0;
  progress(`[原型画布] 采集结束：成功 ${report.captured}，失败 ${report.failed}，重试 ${report.retried}，耗时 ${(report.elapsedMs / 1000).toFixed(1)} 秒。`);

  const referencedAssets = new Set(
    Object.values(manifest.snapshots)
      .filter(snapshot => snapshot?.status === "ready")
      .map(snapshot => snapshot.assetHash || snapshot.hash)
      .filter(Boolean)
  );
  manifest.snapshotAssets = Object.fromEntries(
    Object.entries(manifest.snapshotAssets || {}).filter(([hash]) => referencedAssets.has(hash))
  );
  writeJson(manifestPath, manifest);
  return { manifestPath, snapshotCount: Object.keys(manifest.snapshots).length, ...report };
}

async function runCaptureWorker({ browser, tasks, sourceFile, dimensions, viewport, quality, timeout, onProgress }) {
  if (!tasks.length) return [];
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "zh-CN" });
  const page = await context.newPage();
  await installReplayRuntime(page);
  const outputs = [];
  // 第一次从整页初始状态开始。之后只要上一次没有留下浮层就复用当前页面，失败时退回整页重载再试一次。
  let reloadRequired = true;
  try {
    for (const task of tasks) {
      const startedAt = Date.now();
      let outcome = await captureOne(page, { sourceFile, dimensions, profile: task.profile, node: task.node, quality, timeout, reload: reloadRequired });
      if (!outcome.ok && !reloadRequired) {
        outcome = await captureOne(page, { sourceFile, dimensions, profile: task.profile, node: task.node, quality, timeout, reload: true, retried: true });
      }
      outputs.push({ index: task.index, key: task.key, ms: Date.now() - startedAt, ...outcome });
      reloadRequired = outcome.ok ? Boolean(outcome.overlayVisible) || OVERLAY_TYPES.has(task.node.type) : true;
      onProgress?.();
    }
  } finally {
    await context.close();
  }
  return outputs;
}

async function captureOne(page, { sourceFile, dimensions, profile, node, quality, timeout, reload, retried = false }) {
  try {
    if (reload) {
      await page.goto(pathToFileURL(sourceFile).href, { waitUntil: "load", timeout });
      await page.waitForTimeout(100);
    }
    const result = await prepareSnapshot(page, { dimensions }, profile, node, timeout);
    if (!result.ok) return { ok: false, error: result.error, retried, overlayVisible: true };
    const image = await captureImage(page, quality);
    const overlayVisible = await hasVisibleOverlay(page);
    return {
      ok: true,
      retried,
      overlayVisible,
      hash: sha256(image.buffer),
      width: image.width,
      height: image.height,
      asset: {
        dataUri: `data:${image.mimeType};base64,${image.buffer.toString("base64")}`,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height
      }
    };
  } catch (error) {
    return { ok: false, error: error.message, retried, overlayVisible: true };
  }
}

async function hasVisibleOverlay(page) {
  try {
    return await page.evaluate(OVERLAY_VISIBLE_SCRIPT);
  } catch {
    return true;
  }
}

// 关联体检：每个已关联节点都从整页初始状态重放一次，只报告能不能走到目标，不生成截图。
// 这是"跑一次就对"的闸门：发布前跑一遍，不要把坏关联留到用户使用时才发现。
export async function verifyBindings({ sourceFile, manifestPath, timeout = 5000, concurrency = DEFAULT_CONCURRENCY }) {
  const manifest = normalizeManifest(readJson(manifestPath));
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new Error(`Manifest 校验失败：\n${validation.errors.join("\n")}`);
  const viewport = {
    width: Math.max(320, Number(manifest.prototype.viewport?.width || 1440)),
    height: Math.max(568, Number(manifest.prototype.viewport?.height || 900))
  };
  const profiles = manifest.profiles.length
    ? manifest.profiles
    : manifest.canvases.map(canvas => ({ id: "all", name: canvas.name, attributes: {}, canvasId: canvas.id, source: "canvas" }));
  const tasks = [];
  for (const profile of profiles) {
    for (const node of manifest.nodes.filter(item => item.canvasId === profile.canvasId)) {
      const binding = bindingForProfile(node, profile.id);
      if (!binding) continue;
      tasks.push({ index: tasks.length, profile, node: { ...node, ...binding } });
    }
  }
  const workerCount = Math.max(1, Math.min(Math.round(Number(concurrency) || DEFAULT_CONCURRENCY), tasks.length || 1));
  const groups = Array.from({ length: workerCount }, () => []);
  tasks.forEach((task, index) => groups[index % workerCount].push(task));
  const startedAt = Date.now();
  const progress = message => {
    if (process.env.PROTOTYPE_CANVAS_PROGRESS === "0") return;
    process.stderr.write(`${message}\n`);
  };
  progress(`[原型画布] 开始体检 ${tasks.length} 个已关联节点，并行 ${workerCount} 路。`);
  const { browser, browserName } = await launchBrowser();
  let outputs = [];
  try {
    outputs = (await Promise.all(groups.map(group => runVerifyWorker({ browser, tasks: group, sourceFile, dimensions: manifest.dimensions || [], viewport, timeout })))).flat();
  } finally {
    await browser.close();
  }
  outputs.sort((left, right) => left.index - right.index);
  const failed = outputs.filter(item => !item.ok).map(item => ({ key: item.key, title: item.title, step: item.step, error: item.error }));
  progress(`[原型画布] 体检结束：通过 ${outputs.length - failed.length}，失败 ${failed.length}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒。`);
  return {
    browser: browserName,
    concurrency: workerCount,
    checked: tasks.length,
    passed: outputs.length - failed.length,
    failed,
    elapsedMs: Date.now() - startedAt
  };
}

async function runVerifyWorker({ browser, tasks, sourceFile, dimensions, viewport, timeout }) {
  if (!tasks.length) return [];
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "zh-CN" });
  const outputs = [];
  try {
    for (const task of tasks) {
      const page = await context.newPage();
      await installReplayRuntime(page);
      try {
        // 体检必须从整页初始状态开始，不能复用上一节点留下的页面状态。
        await page.goto(pathToFileURL(sourceFile).href, { waitUntil: "load", timeout });
        await page.waitForTimeout(100);
        const result = await prepareSnapshot(page, { dimensions }, task.profile, task.node, timeout);
        outputs.push({
          index: task.index,
          key: `${task.node.id}::${task.profile.id}`,
          title: task.node.title,
          ok: Boolean(result.ok),
          step: result.step || null,
          error: result.error || null,
          expected: task.node.target?.selector || null,
          reached: result.target?.selector || null
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
  }
  return outputs;
}

export async function captureSnapshotForNode({ sourceFile, manifest: rawManifest, nodeId, profileId = null, quality = 74, timeout = 5000, browserHandle = null }) {
  const manifest = normalizeManifest(rawManifest);
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new Error(`Manifest 校验失败：\n${validation.errors.join("\n")}`);
  const sourceHash = sha256(fs.readFileSync(sourceFile));
  if (manifest.prototype.sourceHash !== sourceHash) throw new Error("Manifest 与源 HTML Hash 不一致，禁止采集快照。");
  const node = manifest.nodes.find(item => item.id === nodeId);
  if (!node) throw new Error("找不到需要生成预览的节点。");
  const keyProfileId = profileId || "all";
  const profile = manifest.profiles.find(item => item.id === profileId) || {
    id: keyProfileId,
    name: manifest.canvases.find(item => item.id === node.canvasId)?.name || "当前用户类型",
    attributes: {},
    canvasId: node.canvasId,
    source: "canvas"
  };
  const binding = bindingForProfile(node, profileId || keyProfileId);
  if (!binding) throw new Error("节点尚未关联原型页面。");
  const ownsBrowser = !browserHandle;
  const { browser, browserName } = browserHandle || await launchBrowser();
  const viewport = {
    width: Math.max(320, Number(manifest.prototype.viewport?.width || 1440)),
    height: Math.max(568, Number(manifest.prototype.viewport?.height || 900))
  };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "zh-CN" });
  const page = await context.newPage();
  await installReplayRuntime(page);
  try {
    await page.goto(pathToFileURL(sourceFile).href, { waitUntil: "load", timeout });
    await page.waitForTimeout(100);
    const result = await prepareSnapshot(page, manifest, profile, { ...node, ...binding }, timeout);
    if (!result.ok) throw new Error(result.error);
    const image = await captureImage(page, quality);
    const hash = sha256(image.buffer);
    return {
      browser: browserName,
      key: `${node.id}::${keyProfileId}`,
      snapshot: {
        hash,
        assetHash: hash,
        width: image.width,
        height: image.height,
        sourceHash,
        capturedAt: new Date().toISOString(),
        status: "ready"
      },
      asset: {
        dataUri: `data:${image.mimeType};base64,${image.buffer.toString("base64")}`,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height
      }
    };
  } finally {
    await context.close();
    if (ownsBrowser) await browser.close();
  }
}

export function createSnapshotCapturePool() {
  let browserHandlePromise = null;
  let queue = Promise.resolve();
  let closed = false;

  const getBrowserHandle = async () => {
    if (closed) throw new Error("预览采集服务已经关闭。");
    if (!browserHandlePromise) browserHandlePromise = launchBrowser();
    const handle = await browserHandlePromise;
    if (!handle.browser.isConnected()) {
      browserHandlePromise = launchBrowser();
      return browserHandlePromise;
    }
    return handle;
  };

  return {
    warm() {
      return getBrowserHandle();
    },
    capture(options) {
      const task = queue.then(async () => captureSnapshotForNode({ ...options, browserHandle: await getBrowserHandle() }));
      queue = task.catch(() => {});
      return task;
    },
    async close() {
      closed = true;
      await queue.catch(() => {});
      const handle = await browserHandlePromise?.catch(() => null);
      browserHandlePromise = null;
      if (handle?.browser?.isConnected()) await handle.browser.close();
    }
  };
}

export async function launchBrowser() {
  const candidates = [
    { name: "Google Chrome", options: { channel: "chrome", headless: true } },
    { name: "Microsoft Edge", options: { channel: "msedge", headless: true } },
    { name: "Playwright Chromium", options: { headless: true } }
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      return { browser: await chromium.launch(candidate.options), browserName: candidate.name };
    } catch (error) {
      errors.push(`${candidate.name}: ${firstLine(error.message)}`);
    }
  }
  throw new Error(`没有可用的 Chromium 浏览器。\n${errors.join("\n")}`);
}

export async function installReplayRuntime(page) {
  await page.addInitScript({
    content: `globalThis.__PrototypeCanvasReplay = (${createPrototypeReplayRuntime.toString()})();`
  });
}

async function prepareSnapshot(page, manifest, profile, node, timeout) {
  return page.evaluate(async ({ profile, dimensions, node, timeout }) => {
    const runtime = globalThis.__PrototypeCanvasReplay;
    if (!runtime) return { ok: false, error: "原型关联回放内核未加载" };
    try {
      const result = await runtime.replay(node.actions || [], node.target, {
        profile,
        dimensions,
        timeout: Math.max(1200, Number(timeout || 5000)),
        allowSurfaceFallback: false
      });
      return { ok: true, completedActions: result.completedActions, target: result.target, fingerprint: result.fingerprint };
    } catch (error) {
      const step = Number.isInteger(error.stepIndex) ? `第 ${error.stepIndex + 1} 步：` : "";
      return { ok: false, error: `${step}${error.message}`, completedActions: error.completedActions || [] };
    }
  }, { profile, dimensions: manifest.dimensions || [], node, timeout });
}

async function captureImage(page, quality) {
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  const imageScale = Math.min(1, 720 / viewport.width);
  const width = Math.round(viewport.width * imageScale);
  const height = Math.round(viewport.height * imageScale);
  try {
    const session = await page.context().newCDPSession(page);
    const result = await session.send("Page.captureScreenshot", {
      format: "webp",
      quality: Math.max(35, Math.min(88, Number(quality))),
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: imageScale }
    });
    await session.detach();
    return { buffer: Buffer.from(result.data, "base64"), mimeType: "image/webp", width, height };
  } catch {
    return { buffer: await page.screenshot({ type: "jpeg", quality: Math.max(35, Math.min(88, Number(quality))), fullPage: false }), mimeType: "image/jpeg", width: viewport.width, height: viewport.height };
  }
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/)[0];
}
