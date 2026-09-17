import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildCanvasHtml, generateCanvasFile } from "./generate.mjs";
import { createSnapshotCapturePool } from "./capture.mjs";
import { canvasDataPaths, fail, readJson, readUtf8, sha256, shortHash, writeJson } from "./common.mjs";
import { normalizeManifest, validateManifest } from "./manifest-v2.mjs";

export function createOrResumeSession({ sourceFile, manifestPath, sessionId = null }) {
  const sourceHtml = readUtf8(sourceFile);
  const sourceHash = sha256(sourceHtml);
  const paths = canvasDataPaths(sourceFile, sourceHash);
  const resolvedManifestPath = path.resolve(manifestPath || paths.manifestPath);
  if (!fs.existsSync(resolvedManifestPath)) fail("找不到 Canvas Manifest。", resolvedManifestPath);
  fs.mkdirSync(paths.sessionsDir, { recursive: true });

  const index = fs.existsSync(paths.indexPath) ? readJson(paths.indexPath) : { format: "prototype-canvas-session-index@1", activeSessionId: null, sessions: [] };
  const requestedId = sessionId || index.activeSessionId;
  if (requestedId) {
    const existingPath = path.join(paths.sessionsDir, `${requestedId}.json`);
    if (fs.existsSync(existingPath)) {
      const existing = readJson(existingPath);
      if (existing.status === "pending" && existing.sourceHash === sourceHash) return { session: existing, sessionPath: existingPath, paths };
    }
    if (sessionId) fail("找不到可恢复的编辑 Session。", requestedId);
  }

  const manifest = normalizeManifest(readJson(resolvedManifestPath));
  const validation = validateManifest(manifest);
  if (!validation.ok) fail("Manifest 校验失败。", validation.errors.join("\n"));
  if (manifest.prototype.sourceHash !== sourceHash) fail("Manifest 与源 HTML Hash 不一致，禁止启动编辑。");
  const id = `session-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${shortHash(crypto.randomBytes(12), 8)}`;
  const now = new Date().toISOString();
  const session = {
    format: "prototype-canvas-session@1",
    id,
    status: "pending",
    sourcePath: path.resolve(sourceFile),
    sourceHash,
    baseManifestPath: resolvedManifestPath,
    baseManifestHash: manifestHash(manifest),
    createdAt: now,
    updatedAt: now,
    manifest,
    operations: []
  };
  const sessionPath = path.join(paths.sessionsDir, `${id}.json`);
  writeJson(sessionPath, session);
  index.activeSessionId = id;
  index.sessions = [...new Set([...(index.sessions || []), id])];
  writeJson(paths.indexPath, index);
  return { session, sessionPath, paths };
}

export function saveSessionPatch({ sessionPath, payload }) {
  const session = readJson(sessionPath);
  if (session.status !== "pending") fail("当前 Session 已应用，不能继续编辑。");
  if (payload.sessionId !== session.id) fail("Session ID 不匹配。");
  const manifest = normalizeManifest(payload.manifest);
  const validation = validateManifest(manifest);
  if (!validation.ok) fail("编辑结果校验失败。", validation.errors.join("\n"));
  if (manifest.prototype.sourceHash !== session.sourceHash) fail("编辑结果与源 HTML Hash 不一致。");
  session.manifest = manifest;
  session.operations = Array.isArray(payload.operations) ? payload.operations.slice(-500) : session.operations;
  session.lastOperation = String(payload.lastOperation || "编辑画布").slice(0, 160);
  session.updatedAt = new Date().toISOString();
  writeJson(sessionPath, session);
  return session;
}

export async function startEditorServer({ sourceFile, manifestPath, sessionId = null, port = 0 }) {
  const opened = createOrResumeSession({ sourceFile, manifestPath, sessionId });
  const token = crypto.randomBytes(24).toString("hex");
  const capturePool = createSnapshotCapturePool();
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        return sendJson(response, 200, { ok: true, sessionId: opened.session.id });
      }
      if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/edit")) {
        const current = readJson(opened.sessionPath);
        const sourceHtml = readUtf8(sourceFile);
        const address = server.address();
        const apiUrl = `http://127.0.0.1:${address.port}/api/session/${opened.session.id}`;
        const captureUrl = `${apiUrl}/capture`;
        const html = buildCanvasHtml({ sourceHtml, manifest: current.manifest, editConfig: { apiUrl, captureUrl, apiToken: token, sessionId: opened.session.id } });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return response.end(html);
      }
      if (requestUrl.pathname === `/api/session/${opened.session.id}/capture`) {
        if (request.headers["x-prototype-canvas-token"] !== token) return sendJson(response, 403, { ok: false, code: "EDITOR_PAGE_EXPIRED", error: "本地编辑服务已经重启，当前页面已失效。请刷新浏览器页面后再试。" });
        if (request.method !== "POST") return sendJson(response, 405, { ok: false, code: "INVALID_REQUEST", error: "请求方式不正确，请刷新页面后重试。" });
        const payload = await readJsonBody(request, 2 * 1024 * 1024);
        const current = readJson(opened.sessionPath);
        const captureManifest = structuredClone(current.manifest);
        if (payload.binding) {
          const candidateNode = captureManifest.nodes.find(node => node.id === payload.nodeId);
          if (!candidateNode) return sendJson(response, 404, { ok: false, code: "NODE_NOT_FOUND", error: "这个节点已经不存在。请刷新页面后重新选择节点。" });
          candidateNode.bindings ||= {};
          candidateNode.bindings[payload.profileId || "global"] = payload.binding;
        }
        const captured = await capturePool.capture({
          sourceFile,
          manifest: captureManifest,
          nodeId: payload.nodeId,
          profileId: payload.profileId || null,
          quality: payload.quality || 68,
          timeout: payload.timeout || 7000
        });
        if (!payload.binding) {
          current.manifest.snapshots[captured.key] = captured.snapshot;
          current.manifest.snapshotAssets[captured.snapshot.assetHash] = captured.asset;
          current.updatedAt = new Date().toISOString();
          current.lastOperation = "生成节点预览";
          writeJson(opened.sessionPath, current);
        }
        return sendJson(response, 200, { ok: true, ...captured });
      }
      if (requestUrl.pathname === `/api/session/${opened.session.id}`) {
        if (request.headers["x-prototype-canvas-token"] !== token) return sendJson(response, 403, { ok: false, code: "EDITOR_PAGE_EXPIRED", error: "本地编辑服务已经重启，当前页面已失效。请刷新浏览器页面后再试。" });
        if (request.method === "GET") return sendJson(response, 200, readJson(opened.sessionPath));
        if (request.method === "PUT") {
          const payload = await readJsonBody(request, 80 * 1024 * 1024);
          const saved = saveSessionPatch({ sessionPath: opened.sessionPath, payload });
          return sendJson(response, 200, { ok: true, updatedAt: saved.updatedAt });
        }
      }
      sendJson(response, 404, { ok: false, code: "INVALID_REQUEST", error: "没有找到对应的本地编辑服务，请刷新页面后重试。" });
    } catch (error) {
      const friendly = userFacingServerError(error);
      if (!error.isUserError) console.error("[原型画布服务]", error);
      sendJson(response, error.isUserError ? 409 : 500, { ok: false, ...friendly });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port) || 0, "127.0.0.1", resolve);
  });
  capturePool.warm().catch(() => {});
  server.once("close", () => { capturePool.close().catch(() => {}); });
  const address = server.address();
  return {
    server,
    token,
    sessionId: opened.session.id,
    sessionPath: opened.sessionPath,
    editUrl: `http://127.0.0.1:${address.port}/edit`,
    apiUrl: `http://127.0.0.1:${address.port}/api/session/${opened.session.id}`,
    captureUrl: `http://127.0.0.1:${address.port}/api/session/${opened.session.id}/capture`
  };
}

export function applySession({ sourceFile, sessionId = null, outputPath = null, outputDir = null }) {
  const sourceHash = sha256(readUtf8(sourceFile));
  const paths = canvasDataPaths(sourceFile, sourceHash);
  if (!fs.existsSync(paths.indexPath)) fail("没有可应用的编辑 Session。");
  const index = readJson(paths.indexPath);
  const pending = (index.sessions || []).map(id => {
    const file = path.join(paths.sessionsDir, `${id}.json`);
    return fs.existsSync(file) ? readJson(file) : null;
  }).filter(item => item?.status === "pending");
  let session;
  if (sessionId) session = pending.find(item => item.id === sessionId);
  else if (pending.length === 1) session = pending[0];
  else if (pending.length > 1) fail("存在多份待应用 Session，请使用 --session 指定。", pending.map(item => item.id).join("\n"));
  if (!session) fail("找不到待应用的编辑 Session。", sessionId || "");
  if (session.sourceHash !== sourceHash) fail("源 HTML 已变化，停止应用以避免覆盖错误版本。");
  if (!fs.existsSync(session.baseManifestPath)) fail("Session 的基线 Manifest 已不存在，停止应用。", session.baseManifestPath);
  const currentBase = normalizeManifest(readJson(session.baseManifestPath));
  if (manifestHash(currentBase) !== session.baseManifestHash) fail("基线 Manifest 已变化，停止应用并保留当前 Session。");

  const generated = generateCanvasFile({ sourceFile, manifest: session.manifest, outputPath, outputDir });
  writeJson(session.baseManifestPath, normalizeManifest(session.manifest));
  session.status = "applied";
  session.appliedAt = new Date().toISOString();
  session.outputPath = generated.outputPath;
  writeJson(path.join(paths.sessionsDir, `${session.id}.json`), session);
  index.activeSessionId = null;
  writeJson(paths.indexPath, index);
  return { sessionId: session.id, ...generated };
}

function manifestHash(manifest) {
  return sha256(JSON.stringify(normalizeManifest(manifest)));
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`请求内容超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB 限制。`);
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求内容无法解析。");
    error.code = "INVALID_REQUEST";
    throw error;
  }
}

function userFacingServerError(error) {
  const raw = String(error?.message || "");
  if (error?.code === "REQUEST_TOO_LARGE" || /请求内容超过/.test(raw)) return { code: "REQUEST_TOO_LARGE", error: "本次保存的数据量过大，浏览器无法提交。请减少一次操作的内容后重试。" };
  if (error?.code === "INVALID_REQUEST" || /无法解析|JSON/.test(raw)) return { code: "INVALID_REQUEST", error: "本次请求内容不完整。请刷新页面后重新操作。" };
  if (/Session ID|当前 Session 已应用|找不到可恢复的编辑 Session/.test(raw)) return { code: "EDITOR_SESSION_CLOSED", error: "当前编辑会话已经结束。请重新打开本地编辑地址后再操作。" };
  if (/Hash|源 HTML|源文件已变化/.test(raw)) return { code: "SOURCE_CHANGED", error: "原型文件已经发生变化，当前画布不能继续保存。请重新分析原型后再编辑。" };
  if (/Manifest|节点类型无效|连线类型无效|不能直接归属于/.test(raw)) return { code: "INVALID_CANVAS_DATA", error: "画布数据不完整，暂时无法保存。请撤销最近一次操作；如果仍未恢复，请刷新页面。" };
  if (/没有可用的 Chromium/.test(raw)) return { code: "BROWSER_UNAVAILABLE", error: "电脑上没有找到可用的 Chrome 或 Edge，暂时不能生成页面预览。" };
  if (/预览采集服务已经关闭/.test(raw)) return { code: "LOCAL_SERVICE_STOPPED", error: "本地预览服务已经停止。请重新启动 localhost 后再试。" };
  if (/找不到交互入口|等待入口超时|找不到点击入口/.test(raw)) return { code: "PROTOTYPE_ENTRY_NOT_FOUND", error: "没有在原型中找到需要点击的入口。页面可能尚未加载完成，或原型结构已经变化，请重新定位这个节点。" };
  if (/找不到关联页面|找不到关联目标|找不到目标/.test(raw)) return { code: "PROTOTYPE_TARGET_NOT_FOUND", error: "没有找到之前关联的页面。原型内容可能已经变化，请重新定位这个节点。" };
  if (/定位超时|回放内核未加载/.test(raw)) return { code: "PROTOTYPE_TIMEOUT", error: "原型页面加载时间过长。请稍后重试；如果仍然失败，请重新打开本地预览。" };
  if (/节点尚未关联原型页面/.test(raw)) return { code: "NODE_NOT_BOUND", error: "这个节点还没有关联原型页面，请先完成页面关联。" };
  if (/找不到需要生成预览的节点|找不到需要验证的节点/.test(raw)) return { code: "NODE_NOT_FOUND", error: "这个节点已经不存在。请刷新页面后重新选择节点。" };
  if (/预览未生成|截图/.test(raw)) return { code: "SNAPSHOT_FAILED", error: "页面已经定位，但预览图片没有生成成功。请稍后重新关联。" };
  return { code: "LOCAL_SERVICE_ERROR", error: "本地编辑服务处理失败。请刷新页面后重试；如果仍然失败，请重新启动 localhost。" };
}
