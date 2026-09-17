import { normalizeText, shortHash, slug } from "./common.mjs";

export const MANIFEST_FORMAT = "prototype-canvas@2";

export const NODE_TYPES = {
  start: "起点",
  navigation: "导航",
  page: "页面",
  tab: "标签页",
  drawer: "抽屉",
  modal: "弹窗",
  dialog: "对话框",
  sheet: "底部面板",
  popover: "气泡浮层",
  overlay: "浮层",
  step: "表单步骤",
  state: "页面状态",
  scenario: "情形"
};

export const AUDIENCE_TYPES = {
  user: "用户类型",
  tenant: "租户",
  department: "部门",
  position: "岗位",
  role: "角色",
  permission: "权限"
};

const ALLOWED_TYPES = new Set(Object.keys(NODE_TYPES));
const ALLOWED_AUDIENCE_TYPES = new Set(Object.keys(AUDIENCE_TYPES));
const ALLOWED_EDGE_TYPES = new Set(["hierarchy", "cross"]);
const DETAIL_TYPES = new Set(["tab", "drawer", "modal", "dialog", "sheet", "popover", "overlay", "step", "state"]);
const DETAIL_PARENT_TYPES = new Set(["page", "tab", "drawer", "modal", "dialog", "sheet", "popover", "overlay", "step", "state"]);
const DESCRIPTION_DRAFT_PATTERN = /识别依据为|JavaScript|DOM|选择器|导航数据模型|具体业务规则待|待结合需求材料|页面说明待|说明待补充|待\s*AI/i;

export function createNode(input = {}) {
  const type = ALLOWED_TYPES.has(input.type) ? input.type : "page";
  const identity = input.scope || input.target?.selector || input.title || cryptoFallback();
  const id = input.id || `node-${type}-${slug(identity, type)}`;
  const legacyBinding = normalizeBinding({
    scope: input.scope,
    target: input.target,
    actions: input.actions,
    evidence: input.evidence,
    confidence: input.confidence,
    fingerprint: input.fingerprint
  });
  const bindings = Object.fromEntries(Object.entries(input.bindings || {})
    .map(([key, value]) => [key, normalizeBinding(value)])
    .filter(([, value]) => hasBinding(value)));
  if (!Object.keys(bindings).length && hasBinding(legacyBinding)) bindings.global = legacyBinding;
  return {
    id,
    canvasId: input.canvasId || null,
    type,
    typeLabel: NODE_TYPES[type],
    title: normalizeText(input.title, NODE_TYPES[type]),
    descriptionHtml: input.descriptionHtml || `<p>${normalizeText(input.title, NODE_TYPES[type])}的页面说明待确认。</p>`,
    descriptionSource: input.descriptionSource || (input.userEdited ? "user" : "unreviewed"),
    groupId: input.groupId || "group-main",
    parentId: input.parentId || null,
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : 0,
    collapsed: Boolean(input.collapsed),
    bindings,
    scope: legacyBinding.scope,
    target: legacyBinding.target,
    actions: legacyBinding.actions,
    layouts: {
      mindmap: normalizeLayout(input.layouts?.mindmap, 220, 58),
      snapshot: normalizeLayout(input.layouts?.snapshot, 360, 264)
    },
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    confidence: clamp(Number(input.confidence ?? 0.5), 0, 1),
    source: input.source || "analysis",
    userEdited: Boolean(input.userEdited)
  };
}

export function createEdge(source, target, type = "hierarchy", label = "", input = {}) {
  const normalizedType = ALLOWED_EDGE_TYPES.has(type) ? type : "cross";
  return {
    id: input.id || `edge-${shortHash(`${source}::${target}::${normalizedType}`, 12)}`,
    canvasId: input.canvasId || null,
    source,
    target,
    type: normalizedType,
    label: normalizeText(label),
    anchors: normalizeAnchors(input.anchors),
    controlOffsets: normalizeControlOffsets(input.controlOffsets),
    sourceKind: input.sourceKind || "analysis"
  };
}

export function normalizeManifest(input) {
  const source = structuredClone(input || {});
  const wasV2 = source.format === MANIFEST_FORMAT || (source.nodes || []).some(node => node.canvasId);
  source.prototype ||= {};
  source.dimensions = Array.isArray(source.dimensions) ? source.dimensions : [];
  source.profiles = normalizeProfiles(source.profiles);
  source.groups = Array.isArray(source.groups) && source.groups.length
    ? source.groups
    : [{ id: "group-main", name: "页面结构", collapsed: false }];
  source.snapshots = source.snapshots && typeof source.snapshots === "object" ? source.snapshots : {};
  source.snapshotAssets = source.snapshotAssets && typeof source.snapshotAssets === "object" ? source.snapshotAssets : {};

  const graph = wasV2 ? normalizeV2Graph(source) : migrateLegacyGraph(source);
  source.nodes = graph.nodes;
  source.edges = graph.edges;
  source.snapshots = graph.snapshots;
  source.profiles = graph.profiles;

  source.canvases = normalizeCanvases(source.canvases, source.profiles, source.nodes);
  const canvasIds = new Set(source.canvases.map(canvas => canvas.id));
  const fallbackCanvasId = source.canvases[0]?.id || "canvas-global";
  for (const node of source.nodes) node.canvasId = canvasIds.has(node.canvasId) ? node.canvasId : fallbackCanvasId;
  const nodeCanvas = new Map(source.nodes.map(node => [node.id, node.canvasId]));
  source.edges = source.edges
    .filter(edge => nodeCanvas.has(edge.source) && nodeCanvas.has(edge.target) && nodeCanvas.get(edge.source) === nodeCanvas.get(edge.target))
    .map(edge => ({ ...edge, canvasId: nodeCanvas.get(edge.source) }));

  source.audience = normalizeAudience(source.audience, source.profiles);
  source.viewState = normalizeViewState(source.viewState, source.profiles, source.canvases);
  normalizeSnapshotAssets(source);
  source.analysis ||= { warnings: [], unresolved: [], sourceSignals: [], confidenceSummary: {} };
  source.format = MANIFEST_FORMAT;
  return source;
}

export function validateManifest(input) {
  const errors = [];
  const warnings = [];
  if (!input || input.format !== MANIFEST_FORMAT) errors.push(`Manifest format 必须为 ${MANIFEST_FORMAT}。`);
  if (!input?.prototype?.sourceHash) errors.push("缺少 prototype.sourceHash。");
  if (!Array.isArray(input?.nodes)) errors.push("Manifest nodes 必须是数组。");
  if (!Array.isArray(input?.edges)) errors.push("Manifest edges 必须是数组。");
  const canvasIds = new Set((input?.canvases || []).map(canvas => canvas.id));
  if (!canvasIds.size) errors.push("Manifest 至少需要一个画布容器。");
  const ids = new Set();
  const nodeCanvas = new Map();
  const nodesById = new Map();
  for (const node of input?.nodes || []) {
    if (!node.id) errors.push("存在缺少 id 的节点。");
    if (ids.has(node.id)) errors.push(`节点 ID 重复：${node.id}`);
    ids.add(node.id);
    nodeCanvas.set(node.id, node.canvasId);
    nodesById.set(node.id, node);
    if (!canvasIds.has(node.canvasId)) errors.push(`节点 ${node.id} 引用未知画布 ${node.canvasId}。`);
    if (!ALLOWED_TYPES.has(node.type)) errors.push(`节点类型无效：${node.type}`);
    if (!node.title) errors.push(`节点 ${node.id || "(未知)"} 缺少标题。`);
    if (!node.layouts?.mindmap || !node.layouts?.snapshot) errors.push(`节点 ${node.id} 缺少双模式布局。`);
    if (Number(node.confidence) < 0.65) warnings.push(`低置信度节点：${node.title}`);
  }
  const hierarchyParents = new Map();
  for (const edge of input?.edges || []) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) errors.push(`连线引用不存在节点：${edge.id || "(未知)"}`);
    if (!ALLOWED_EDGE_TYPES.has(edge.type)) errors.push(`连线类型无效：${edge.type}`);
    if (nodeCanvas.get(edge.source) !== nodeCanvas.get(edge.target)) errors.push(`连线跨越了不同画布：${edge.id}`);
    if (edge.type === "hierarchy") {
      if (hierarchyParents.has(edge.target)) errors.push(`节点 ${edge.target} 存在多个层级父节点。`);
      hierarchyParents.set(edge.target, edge.source);
    }
  }
  for (const node of input?.nodes || []) {
    const edgeParentId = hierarchyParents.get(node.id) || null;
    if ((node.parentId || null) !== edgeParentId) errors.push(`节点 ${node.id} 的 parentId 与层级连线不一致。`);
    if (DETAIL_TYPES.has(node.type)) {
      const parent = node.parentId ? nodesById.get(node.parentId) : null;
      if (!parent) errors.push(`${NODE_TYPES[node.type]}节点“${node.title}”必须归属于具体页面或下钻交互。`);
      else if (!DETAIL_PARENT_TYPES.has(parent.type)) errors.push(`${NODE_TYPES[node.type]}节点“${node.title}”不能直接归属于${NODE_TYPES[parent.type] || parent.type}节点。`);
    }
  }
  if (hasHierarchyCycle(input?.nodes || [])) errors.push("页面层级树存在循环关系。");
  const audienceNodes = input?.audience?.nodes || [];
  const audienceIds = new Set(audienceNodes.map(node => node.id));
  const profileIds = new Set((input?.profiles || []).map(profile => profile.id));
  for (const node of audienceNodes) {
    if (node.parentId && !audienceIds.has(node.parentId)) errors.push(`用户类型节点 ${node.id} 引用未知上级。`);
    if (node.profileId && !profileIds.has(node.profileId)) errors.push(`用户类型节点 ${node.id} 引用未知用户类型。`);
    if (!ALLOWED_AUDIENCE_TYPES.has(node.type)) errors.push(`用户类型节点 ${node.id} 的类型无效。`);
  }
  for (const profile of input?.profiles || []) {
    if (!canvasIds.has(profile.canvasId)) errors.push(`用户类型 ${profile.name} 引用未知画布。`);
    const audienceNode = audienceNodes.find(node => node.profileId === profile.id);
    if (!audienceNode) errors.push(`用户类型 ${profile.name} 缺少树节点。`);
    else if (audienceNodes.some(node => node.parentId === audienceNode.id)) errors.push(`非叶子用户类型节点 ${audienceNode.title} 不能持有画布。`);
  }
  if (hasAudienceCycle(audienceNodes)) errors.push("用户类型树存在循环关系。");
  return { ok: errors.length === 0, errors, warnings };
}

export function validatePublicationManifest(input) {
  const base = validateManifest(input);
  const errors = [...base.errors];
  const warnings = [...base.warnings];
  const profilesByCanvas = new Map((input?.profiles || []).map(profile => [profile.canvasId, profile.id]));
  const unresolvedOwnership = (input?.analysis?.unresolved || []).filter(item => /所属页面|父节点|归属/.test(String(item.reason || "")));
  if (unresolvedOwnership.length) errors.push(`仍有 ${unresolvedOwnership.length} 个节点未确认所属页面。`);

  for (const node of input?.nodes || []) {
    const description = plainText(node.descriptionHtml);
    if (DESCRIPTION_DRAFT_PATTERN.test(description)) errors.push(`节点“${node.title}”仍是技术模板说明，必须改为业务说明。`);
    const bindingEntries = Object.entries(node.bindings || {});
    if (!bindingEntries.length) continue;
    if (!['ai-reviewed', 'user'].includes(node.descriptionSource) || description.length < 18) {
      errors.push(`已关联节点“${node.title}”缺少经过复核的业务说明。`);
    }
    const profileId = profilesByCanvas.get(node.canvasId) || "all";
    const snapshot = input?.snapshots?.[`${node.id}::${profileId}`];
    const assetHash = snapshot?.assetHash || snapshot?.hash;
    const asset = assetHash ? input?.snapshotAssets?.[assetHash] : null;
    if (snapshot?.status !== "ready" || !asset?.dataUri) {
      errors.push(`已关联节点“${node.title}”没有可用快照。`);
    }
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function bindingForProfile(node, profileId = null) {
  return node?.bindings?.[profileId] || node?.bindings?.global || null;
}

export function canvasForProfile(manifest, profileId = null) {
  const profile = (manifest?.profiles || []).find(item => item.id === profileId);
  const canvasId = profile?.canvasId || manifest?.viewState?.defaultCanvasId || manifest?.canvases?.[0]?.id;
  return (manifest?.canvases || []).find(canvas => canvas.id === canvasId) || null;
}

export function nodesForCanvas(manifest, canvasId) {
  return (manifest?.nodes || []).filter(node => node.canvasId === canvasId);
}

function normalizeProfiles(value) {
  return (Array.isArray(value) ? value : [])
    .filter(profile => !(profile.id === "default" && profile.source === "default"))
    .map(profile => ({
      ...profile,
      id: profile.id || `profile-${slug(profile.name || cryptoFallback(), "user")}`,
      name: normalizeText(profile.name, "用户类型"),
      attributes: profile.attributes || {},
      canvasId: profile.canvasId || null
    }));
}

function normalizeV2Graph(source) {
  const nodes = (Array.isArray(source.nodes) ? source.nodes : []).map(createNode);
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = (Array.isArray(source.edges) ? source.edges : [])
    .filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map(edge => {
      const type = edge.type === "hierarchy" || edge.type === "navigate" || edge.type === "open" ? "hierarchy" : "cross";
      return createEdge(edge.source, edge.target, type, edge.label, edge);
    });
  const parentByTarget = new Map(edges.filter(edge => edge.type === "hierarchy").map(edge => [edge.target, edge.source]));
  for (const node of nodes) node.parentId = parentByTarget.get(node.id) || (nodeIds.has(node.parentId) ? node.parentId : null);
  return { nodes, edges, snapshots: source.snapshots, profiles: source.profiles };
}

function migrateLegacyGraph(source) {
  const legacyNodes = (Array.isArray(source.nodes) ? source.nodes : []).map(createNode);
  const legacyNodeIds = new Set(legacyNodes.map(node => node.id));
  const legacyEdges = (Array.isArray(source.edges) ? source.edges : [])
    .filter(edge => legacyNodeIds.has(edge.source) && legacyNodeIds.has(edge.target))
    .map(edge => {
      const type = edge.type === "hierarchy" || edge.type === "navigate" || edge.type === "open" ? "hierarchy" : "cross";
      return createEdge(edge.source, edge.target, type, edge.label, edge);
    });
  const profiles = source.profiles;
  if (!profiles.length) {
    const canvasId = "canvas-global";
    const nodes = legacyNodes.map(node => ({ ...node, canvasId }));
    const edges = legacyEdges.map(edge => ({ ...edge, canvasId }));
    return { nodes, edges, snapshots: source.snapshots, profiles };
  }

  const nodes = [];
  const edges = [];
  const snapshots = {};
  for (const profile of profiles) {
    const canvasId = profile.canvasId || `canvas-${slug(profile.id, "user")}`;
    profile.canvasId = canvasId;
    const allowed = new Set(Array.isArray(profile.visibleNodeIds) && profile.visibleNodeIds.length
      ? profile.visibleNodeIds
      : legacyNodes.map(node => node.id));
    const idMap = new Map();
    for (const node of legacyNodes.filter(item => allowed.has(item.id))) {
      const id = `${node.id}--${shortHash(profile.id, 6)}`;
      idMap.set(node.id, id);
      const binding = node.bindings?.[profile.id] || node.bindings?.global || null;
      nodes.push({
        ...structuredClone(node),
        id,
        canvasId,
        parentId: null,
        bindings: binding ? { [profile.id]: structuredClone(binding) } : {}
      });
      const oldSnapshot = source.snapshots?.[`${node.id}::${profile.id}`] || source.snapshots?.[`${node.id}::all`];
      if (oldSnapshot) snapshots[`${id}::${profile.id}`] = structuredClone(oldSnapshot);
    }
    for (const edge of legacyEdges) {
      if (!idMap.has(edge.source) || !idMap.has(edge.target)) continue;
      edges.push(createEdge(idMap.get(edge.source), idMap.get(edge.target), edge.type, edge.label, {
        ...edge,
        id: `${edge.id}--${shortHash(profile.id, 6)}`,
        canvasId
      }));
    }
    const parentByTarget = new Map(edges.filter(edge => edge.canvasId === canvasId && edge.type === "hierarchy").map(edge => [edge.target, edge.source]));
    for (const node of nodes.filter(item => item.canvasId === canvasId)) node.parentId = parentByTarget.get(node.id) || null;
    delete profile.visibleNodeIds;
  }
  return { nodes, edges, snapshots, profiles };
}

function normalizeCanvases(value, profiles, nodes) {
  const existing = new Map((Array.isArray(value) ? value : []).filter(item => item?.id).map(item => [item.id, item]));
  const ids = new Set(nodes.map(node => node.canvasId).filter(Boolean));
  for (const profile of profiles) {
    profile.canvasId ||= `canvas-${slug(profile.id, "user")}`;
    ids.add(profile.canvasId);
  }
  if (!ids.size) ids.add("canvas-global");
  return [...ids].map(id => {
    const profile = profiles.find(item => item.canvasId === id);
    const current = existing.get(id) || {};
    return {
      ...current,
      id,
      profileId: profile?.id || current.profileId || null,
      name: normalizeText(current.name || profile?.name, profile ? profile.name : "未配置用户类型")
    };
  });
}

function normalizeAudience(value, profiles) {
  const rawNodes = Array.isArray(value?.nodes) ? value.nodes : [];
  const nodes = rawNodes.map((node, index) => ({
    id: node.id || `audience-${shortHash(`${node.title}-${index}`, 10)}`,
    title: normalizeText(node.title, index === 0 ? "用户类型" : "新用户类型"),
    type: ALLOWED_AUDIENCE_TYPES.has(node.type) ? node.type : index === 0 ? "user" : "role",
    typeLabel: AUDIENCE_TYPES[ALLOWED_AUDIENCE_TYPES.has(node.type) ? node.type : index === 0 ? "user" : "role"],
    descriptionHtml: node.descriptionHtml || "<p>说明待补充。</p>",
    parentId: node.parentId || null,
    order: Number.isFinite(Number(node.order)) ? Number(node.order) : index,
    collapsed: Boolean(node.collapsed),
    profileId: node.profileId || null,
    canvasId: node.canvasId || null,
    layout: normalizeLayout(node.layout, 176, 48)
  }));
  let root = nodes.find(node => !node.parentId);
  if (!root) {
    root = { id: "audience-root", title: "用户类型", type: "user", typeLabel: AUDIENCE_TYPES.user, descriptionHtml: "<p>用户类型结构的起点。</p>", parentId: null, order: 0, collapsed: false, profileId: null, canvasId: null, layout: normalizeLayout({ x: 60, y: 80 }, 176, 48) };
    nodes.unshift(root);
  }
  root.type = "user";
  root.typeLabel = AUDIENCE_TYPES.user;
  root.profileId = null;
  root.canvasId = null;
  for (const profile of profiles) {
    let node = nodes.find(item => item.profileId === profile.id);
    if (!node) {
      node = {
        id: `audience-${slug(profile.id, "user")}`,
        title: profile.name,
        type: "role",
        typeLabel: AUDIENCE_TYPES.role,
        descriptionHtml: "<p>说明待补充。</p>",
        parentId: root.id,
        order: nodes.filter(item => item.parentId === root.id).length,
        collapsed: false,
        profileId: profile.id,
        canvasId: profile.canvasId,
        layout: normalizeLayout({}, 190, 52)
      };
      nodes.push(node);
    }
    node.canvasId = profile.canvasId;
  }
  const profileIds = new Set(profiles.map(profile => profile.id));
  for (const node of nodes) {
    if (node.profileId && !profileIds.has(node.profileId)) {
      node.profileId = null;
      node.canvasId = null;
    }
  }
  return {
    rootId: root.id,
    nodes,
    view: normalizeViewport(value?.view, 1)
  };
}

function normalizeViewState(value, profiles, canvases) {
  const validProfile = profiles.find(profile => profile.id === value?.activeProfileId) || profiles[0] || null;
  const defaultCanvasId = validProfile?.canvasId || value?.defaultCanvasId || canvases[0]?.id || "canvas-global";
  const existingCanvasViews = value?.canvases && typeof value.canvases === "object" ? value.canvases : {};
  const legacyModes = value?.modes;
  const canvasViews = {};
  for (const canvas of canvases) {
    const current = existingCanvasViews[canvas.id] || {};
    canvasViews[canvas.id] = {
      modes: {
        mindmap: normalizeViewport(current.modes?.mindmap || legacyModes?.mindmap, 1),
        snapshot: normalizeViewport(current.modes?.snapshot || legacyModes?.snapshot, 0.72)
      },
      minimap: {
        scale: clamp(Number(current.minimap?.scale ?? value?.minimap?.scale ?? 1), 0.5, 4),
        collapsed: Boolean(current.minimap?.collapsed ?? value?.minimap?.collapsed)
      }
    };
  }
  return {
    activeMode: value?.activeMode === "snapshot" ? "snapshot" : "mindmap",
    activeProfileId: validProfile?.id || null,
    defaultCanvasId,
    canvases: canvasViews,
    layoutEngine: "tree-v3",
    deletedNodeIds: Array.isArray(value?.deletedNodeIds) ? [...new Set(value.deletedNodeIds)] : [],
    deletedProfileIds: Array.isArray(value?.deletedProfileIds) ? [...new Set(value.deletedProfileIds)] : [],
    inspectorWidth: clamp(Number(value?.inspectorWidth ?? 330), 260, 640)
  };
}

function normalizeSnapshotAssets(manifest) {
  for (const snapshot of Object.values(manifest.snapshots)) {
    if (!snapshot?.dataUri || !snapshot.hash) continue;
    manifest.snapshotAssets[snapshot.hash] ||= {
      dataUri: snapshot.dataUri,
      mimeType: snapshot.dataUri.slice(5, snapshot.dataUri.indexOf(";")) || "image/webp",
      width: snapshot.width,
      height: snapshot.height
    };
    snapshot.assetHash = snapshot.hash;
    delete snapshot.dataUri;
  }
}

function normalizeBinding(value = {}) {
  return {
    scope: value?.scope || null,
    target: value?.target && typeof value.target === "object" ? value.target : { selector: null },
    actions: Array.isArray(value?.actions) ? value.actions : [],
    evidence: Array.isArray(value?.evidence) ? value.evidence : [],
    confidence: clamp(Number(value?.confidence ?? 0.5), 0, 1),
    fingerprint: value?.fingerprint && typeof value.fingerprint === "object" ? value.fingerprint : null
  };
}

function hasBinding(binding) {
  return Boolean(binding?.scope || binding?.target?.selector || binding?.actions?.length);
}

function normalizeLayout(value, width, height) {
  return {
    x: Number.isFinite(Number(value?.x)) ? Number(value.x) : 0,
    y: Number.isFinite(Number(value?.y)) ? Number(value.y) : 0,
    width: Number.isFinite(Number(value?.width)) ? Math.max(120, Number(value.width)) : width,
    height: Number.isFinite(Number(value?.height)) ? Math.max(44, Number(value.height)) : height
  };
}

function normalizeAnchors(value) {
  return { source: normalizeAnchor(value?.source), target: normalizeAnchor(value?.target) };
}

function normalizeAnchor(value) {
  if (!value || !["top", "right", "bottom", "left"].includes(value.side)) return null;
  return { side: value.side, ratio: clamp(Number(value.ratio ?? 0.5), 0, 1), manual: value.manual !== false };
}

function normalizeControlOffsets(value) {
  const point = input => ({ x: Number(input?.x || 0), y: Number(input?.y || 0) });
  return { source: point(value?.source), target: point(value?.target) };
}

function normalizeViewport(value, scale) {
  return {
    x: Number(value?.x || 0),
    y: Number(value?.y || 0),
    scale: clamp(Number(value?.scale ?? scale), 0.15, 3)
  };
}

function hasAudienceCycle(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    const seen = new Set();
    let current = node;
    while (current?.parentId) {
      if (seen.has(current.id)) return true;
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
  }
  return false;
}

function hasHierarchyCycle(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    const seen = new Set();
    let current = node;
    while (current?.parentId) {
      if (seen.has(current.id)) return true;
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
  }
  return false;
}

function plainText(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function cryptoFallback() {
  return `generated-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
