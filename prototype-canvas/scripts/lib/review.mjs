import { readJson, writeJson } from "./common.mjs";
import { bindingForProfile, normalizeManifest } from "./manifest-v2.mjs";

// 精简复核包：把整个 Manifest 压成"一个业务页面一条"的清单，
// 供 AI 一次读完并写回说明，不需要读取内嵌快照和完整节点数据。
export function buildReviewBundle(manifestPath) {
  const manifest = normalizeManifest(readJson(manifestPath));
  const byId = new Map(manifest.nodes.map(node => [node.id, node]));
  const canvasName = id => manifest.canvases.find(canvas => canvas.id === id)?.name || id;
  const groups = new Map();
  for (const node of manifest.nodes) {
    const key = identityOf(node);
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        title: node.title,
        type: node.type,
        parentTitle: node.parentId ? byId.get(node.parentId)?.title || null : null,
        childTitles: [],
        canvases: [],
        nodeIds: [],
        evidence: node.evidence || [],
        descriptionHtml: node.descriptionHtml || "",
        descriptionSource: node.descriptionSource || "unreviewed",
        bound: false,
        target: null
      });
    }
    const group = groups.get(key);
    group.canvases.push(canvasName(node.canvasId));
    group.nodeIds.push(node.id);
    if (!group.childTitles.length) {
      group.childTitles = manifest.nodes.filter(item => item.parentId === node.id).map(item => item.title).slice(0, 8);
    }
    const profile = manifest.profiles.find(item => item.canvasId === node.canvasId);
    const binding = bindingForProfile(node, profile?.id || null);
    if (binding) {
      group.bound = true;
      group.target ||= binding.target?.selector || null;
    }
  }
  const items = [...groups.values()];
  return {
    format: "prototype-canvas-review@1",
    prototype: {
      name: manifest.prototype.name,
      sourceHash: manifest.prototype.sourceHash,
      viewport: manifest.prototype.viewport
    },
    counts: {
      canvases: manifest.canvases.length,
      nodes: manifest.nodes.length,
      identities: items.length,
      bound: items.filter(item => item.bound).length,
      unreviewed: items.filter(item => !["ai-reviewed", "user"].includes(item.descriptionSource)).length
    },
    warnings: manifest.analysis?.warnings || [],
    unresolved: manifest.analysis?.unresolved || [],
    items
  };
}

// 批量写回说明：同一个业务页面在所有画布中的副本一次写完。
export function applyDescriptions({ manifestPath, patchPath }) {
  const patch = readJson(patchPath);
  const entries = Array.isArray(patch) ? patch : Object.entries(patch).map(([id, value]) => (typeof value === "string" ? { id, descriptionHtml: value } : { id, ...value }));
  const manifest = normalizeManifest(readJson(manifestPath));
  const groups = new Map();
  for (const node of manifest.nodes) {
    const key = identityOf(node);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const unknown = [];
  const applied = [];
  for (const entry of entries) {
    const key = String(entry?.id ?? "");
    const html = String(entry?.descriptionHtml ?? "").trim();
    if (!key || !html) continue;
    const group = groups.get(key);
    if (!group) {
      unknown.push(key);
      continue;
    }
    for (const node of group) {
      node.descriptionHtml = html;
      node.descriptionSource = "ai-reviewed";
    }
    applied.push({ id: key, title: group[0].title, nodes: group.length });
  }
  const appliedTitles = new Set(applied.map(item => item.title));
  manifest.analysis = manifest.analysis || {};
  manifest.analysis.unresolved = (manifest.analysis.unresolved || [])
    .filter(item => !appliedTitles.has(item.title));
  writeJson(manifestPath, manifest);
  const canvases = manifest.nodes.filter(node => appliedTitles.has(node.title) && ["ai-reviewed", "user"].includes(node.descriptionSource)).length;
  return {
    manifestPath,
    identities: applied.length,
    nodes: canvases,
    unknown,
    remainingUnresolved: manifest.analysis.unresolved.length
  };
}

// 批量写回关联：用在结构探查/验证之后，把已经确认路径的节点一次写入全部画布副本。
// 已有用户手动定位的关联默认不覆盖，避免冲掉人工结果。
export function applyBindings({ manifestPath, patchPath, force = false }) {
  const patch = readJson(patchPath);
  const entries = Array.isArray(patch) ? patch : Object.entries(patch).map(([id, value]) => ({ id, ...value }));
  const manifest = normalizeManifest(readJson(manifestPath));
  const profileByCanvas = new Map(manifest.profiles.map(profile => [profile.canvasId, profile.id]));
  const groups = new Map();
  for (const node of manifest.nodes) {
    const key = identityOf(node);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const applied = [];
  const unknown = [];
  const skipped = [];
  for (const entry of entries) {
    const id = String(entry?.id ?? "");
    if (!id || !entry?.target) continue;
    const group = groups.get(id) || manifest.nodes.filter(node => node.id === id);
    if (!group?.length) {
      unknown.push(id);
      continue;
    }
    const manuallyBound = group.filter(node => Object.values(node.bindings || {}).some(binding => (binding.evidence || []).includes("用户在本地编辑模式中定位并验证")));
    const targets = force ? group : group.filter(node => !manuallyBound.includes(node));
    if (!targets.length) {
      skipped.push({ id, title: group[0].title, reason: "该页面已有用户手动定位的关联" });
      continue;
    }
    for (const node of targets) {
      const profileKey = profileByCanvas.get(node.canvasId) || "global";
      node.bindings ||= {};
      node.bindings[profileKey] = {
        scope: entry.scope ?? null,
        target: entry.target,
        actions: Array.isArray(entry.actions) ? entry.actions : [],
        evidence: [...new Set([...(entry.evidence || []), "结构探查验证"])],
        confidence: 1,
        fingerprint: null
      };
      // 关联变了，旧预览必须作废，否则采集会跳过它并留下过期截图。
      delete manifest.snapshots[`${node.id}::${profileKey}`];
    }
    applied.push({ id, title: group[0].title, nodes: targets.length });
  }
  writeJson(manifestPath, manifest);
  return { manifestPath, applied, unknown, skipped };
}

function identityOf(node) {
  return node.scope || node.target?.selector || `title:${node.title}`;
}
