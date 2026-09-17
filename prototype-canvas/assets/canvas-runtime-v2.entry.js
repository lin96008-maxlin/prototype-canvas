import { refreshIcons } from "./runtime/icons.js";
import { clamp, debounce, deepClone, escapeHtml, sanitizeRichHtml, snapshotKey, uniqueId } from "./runtime/utils.js";
import { childrenOf, graphBounds, layoutForest, normalizeTree, renumberSiblings, reorderNode, resolveForestOverlaps, rootNodes, subtreeIds, visibleNodes } from "./runtime/tree-layout.js";
import { anchorPoint, closestAnchors, hierarchyPath, nodeRect, projectToBoundary, relationshipGeometry, relationshipPath } from "./runtime/relationship.js";
import { exportCanvas } from "./runtime/export-v2.js";

const root = document.getElementById("prototypeCanvasRoot");
const manifest = JSON.parse(document.getElementById("prototypeCanvasData").textContent);
const config = JSON.parse(document.getElementById("prototypeCanvasConfig").textContent);
const sourceHtml = decodeSource(document.getElementById("prototypeCanvasSource").textContent.trim());
const editMode = Boolean(config.editMode);
const NODE_TYPES = {
  start: "起点", navigation: "导航", page: "页面", tab: "标签页", drawer: "抽屉", modal: "弹窗",
  dialog: "对话框", sheet: "底部面板", popover: "气泡浮层", overlay: "浮层", step: "表单步骤",
  state: "页面状态", scenario: "情形"
};
const AUDIENCE_TYPES = { user: "用户类型", tenant: "租户", department: "部门", position: "岗位", role: "角色", permission: "权限" };
const AUDIENCE_TYPE_SEQUENCE = ["tenant", "department", "position", "role", "permission"];
const INLINE_PREVIEW_PRELOAD_WIDTH = 640;
const INLINE_PREVIEW_ENTER_WIDTH = 720;
const INLINE_PREVIEW_EXIT_WIDTH = 600;

const state = {
  mode: manifest.viewState.activeMode || "mindmap",
  profileId: manifest.viewState.activeProfileId || manifest.profiles?.[0]?.id || null,
  selectedNodes: new Set(),
  selectedEdgeId: null,
  connect: null,
  pointerWorld: null,
  spaceDown: false,
  pan: null,
  drag: null,
  suppressNodeClick: false,
  nodeClickTimer: null,
  box: null,
  undo: [],
  redo: [],
  operations: [],
  lastOperation: "打开画布",
  frame: null,
  frameWrap: null,
  frameReady: false,
  framePositioned: false,
  frameTarget: null,
  frameRequestId: null,
  frameNavigationTimer: null,
  frameNavigationStarted: false,
  frameFallbackTimer: null,
  frameError: null,
  locateResult: null,
  locateForce: false,
  overlayNodeId: null,
  pendingBindings: new Map(),
  pendingSnapshots: new Map(),
  inspectorOpen: true,
  audience: null,
  audienceSelected: new Set(),
  audienceDrag: null,
  suppressAudienceClick: false,
  audienceBox: null,
  audienceView: manifest.audience?.view || { x: 80, y: 80, scale: 1 },
  audienceMinimapScale: manifest.audience?.minimap?.scale || 1,
  audienceMiniDrag: false,
  audienceSpaceDown: false,
  audienceSearch: "",
  inspectorWidth: clamp(Number(manifest.viewState?.inspectorWidth || 330), 260, 640),
  inspectorResize: null
};

root.innerHTML = `
  <div class="pc-app">
    <header class="pc-toolbar" aria-label="原型画布工具栏">
      <div class="pc-brand"><span class="pc-brand-mark">PC</span><strong>${escapeHtml(manifest.prototype.name || "原型画布")}</strong></div>
      <span class="pc-divider"></span>
      <button class="pc-profile-switch" data-action="audience" title="查看和切换用户类型"><i data-lucide="users-round"></i><span data-profile-name></span><i data-lucide="chevron-down"></i></button>
      <div class="pc-segment" role="group" aria-label="画布模式">
        <button data-mode="mindmap">思维导图</button><button data-mode="snapshot">快照</button>
      </div>
      ${editMode ? `<span class="pc-divider"></span><button data-action="add"><i data-lucide="plus"></i><span data-add-label>新增节点</span></button><button data-action="connect"><i data-lucide="link"></i><span>联系</span></button><button class="pc-icon-btn" data-action="undo" title="撤销 Ctrl+Z"><i data-lucide="undo-2"></i></button><button class="pc-icon-btn" data-action="redo" title="重做 Ctrl+Y"><i data-lucide="redo-2"></i></button>` : ""}
      <span class="pc-toolbar-spacer"></span>
      <button class="pc-icon-btn" data-action="zoom-out" title="缩小 Ctrl+-"><i data-lucide="zoom-out"></i></button>
      <button class="pc-zoom-value" data-action="zoom-reset" title="恢复 100%">100%</button>
      <button class="pc-icon-btn" data-action="zoom-in" title="放大 Ctrl++"><i data-lucide="zoom-in"></i></button>
      <button data-action="shortcuts" title="查看快捷键"><i data-lucide="keyboard"></i><span>快捷键</span></button>
      <button data-action="export"><i data-lucide="download"></i><span>导出</span></button>
      ${editMode ? `<span class="pc-save-state" data-save-state>已保存</span>` : `<span class="pc-readonly">HTML 查看模式</span>`}
    </header>
    <main class="pc-main">
      <section class="pc-viewport" data-viewport tabindex="0" aria-label="原型画布">
        <div class="pc-world" data-world><svg class="pc-edges pc-hierarchy-edges" data-hierarchy-edges aria-hidden="true"></svg><div class="pc-nodes" data-nodes></div><div class="pc-live-layer" data-live-layer></div><svg class="pc-edges pc-relationship-edges" data-edges aria-hidden="true"></svg><div class="pc-node-controls" data-node-controls></div></div>
        <div class="pc-selection-box" data-selection-box hidden></div>
        <div class="pc-empty" data-empty hidden><i data-lucide="map"></i><strong>这张画布还没有节点</strong>${editMode ? "<span>点击“新增节点”，或双击空白处开始</span>" : ""}</div>
        <section class="pc-minimap" aria-label="鸟瞰图">
          <header><strong>鸟瞰图</strong><div><button data-minimap="out" title="缩小鸟瞰图"><i data-lucide="zoom-out"></i></button><span data-minimap-scale>100%</span><button data-minimap="in" title="放大鸟瞰图"><i data-lucide="zoom-in"></i></button></div></header>
          <div class="pc-minimap-scroll" data-minimap-scroll><div class="pc-minimap-content" data-minimap-content></div></div>
        </section>
      </section>
      <aside class="pc-inspector" data-inspector hidden></aside>
    </main>
    <section class="pc-prototype-overlay" data-prototype-overlay hidden>
      <header><button data-action="prototype-back"><i data-lucide="chevron-left"></i><span>返回画布</span></button><strong data-prototype-title>原型页面</strong><span class="pc-toolbar-spacer"></span><span data-locate-hint hidden>请在原型中操作并点击目标页面</span></header>
      <div class="pc-prototype-stage" data-prototype-stage></div>
      <footer data-locate-footer hidden><button data-action="locate-cancel">取消</button><button class="pc-primary" data-action="locate-confirm">确定关联</button></footer>
      <div class="pc-operation-mask" data-operation-mask role="status" aria-live="assertive" aria-busy="true" hidden>
        <div class="pc-operation-progress"><span class="pc-operation-spinner" aria-hidden="true"></span><strong data-operation-title>正在处理</strong><p data-operation-detail>请稍候，不要刷新页面。</p></div>
      </div>
    </section>
    <section class="pc-audience-overlay" data-audience-overlay hidden></section>
    <div class="pc-dialog-layer" data-dialog-layer></div>
    <div class="pc-toast" data-toast hidden></div>
  </div>`;

const el = selector => root.querySelector(selector);
const viewport = el("[data-viewport]");
const world = el("[data-world]");
const nodesLayer = el("[data-nodes]");
const liveLayer = el("[data-live-layer]");
const edgesLayer = el("[data-edges]");
const hierarchyEdgesLayer = el("[data-hierarchy-edges]");
const nodeControlsLayer = el("[data-node-controls]");
const saveSoon = debounce(saveSession, 500);
let livePreviewSyncFrame = 0;
let minimapSyncFrame = 0;
let audienceMinimapSyncFrame = 0;

function updateLiveSoon() {
  if (livePreviewSyncFrame) return;
  livePreviewSyncFrame = requestAnimationFrame(() => {
    livePreviewSyncFrame = 0;
    updateLivePreview();
  });
}

prepareManifest();
bindEvents();
renderAll(true);
root.dataset.runtimeStatus = "ready";

function prepareManifest() {
  manifest.canvases ||= [{ id: "canvas-global", profileId: null, name: "未配置用户类型" }];
  manifest.nodes ||= [];
  manifest.edges ||= [];
  manifest.profiles ||= [];
  manifest.audience ||= { rootId: "audience-root", nodes: [{ id: "audience-root", title: "用户类型", parentId: null, order: 0, collapsed: false, profileId: null, canvasId: null, layout: { x: 80, y: 80, width: 176, height: 48 } }], view: { x: 80, y: 80, scale: 1 } };
  manifest.audience.nodes ||= [];
  manifest.audience.minimap ||= { scale: 1 };
  for (const node of manifest.audience.nodes) {
    node.type = AUDIENCE_TYPES[node.type] ? node.type : node.id === manifest.audience.rootId ? "user" : "role";
    node.typeLabel = AUDIENCE_TYPES[node.type];
    node.descriptionHtml ||= "<p>说明待补充。</p>";
  }
  for (const node of manifest.nodes) node.typeLabel = NODE_TYPES[node.type] || NODE_TYPES.page;
  restoreCollapseState();
  ensureAudienceLeafCanvases();
  manifest.viewState.canvases ||= {};
  for (const canvas of manifest.canvases) ensureCanvasView(canvas.id);
  for (const canvas of manifest.canvases) {
    const canvasNodes = manifest.nodes.filter(node => node.canvasId === canvas.id);
    const canvasEdges = manifest.edges.filter(edge => edge.canvasId === canvas.id);
    const validHierarchy = normalizeTree(canvasNodes, canvasEdges);
    manifest.edges = manifest.edges.filter(edge => edge.canvasId !== canvas.id || edge.type !== "hierarchy").concat(validHierarchy);
    sizeNodes(canvasNodes);
    layoutForest(canvasNodes, canvasEdgesFor(canvas.id), "mindmap", { initialize: true });
    layoutForest(canvasNodes, canvasEdgesFor(canvas.id), "snapshot", { initialize: true });
  }
  if (state.profileId && !manifest.profiles.some(profile => profile.id === state.profileId)) state.profileId = manifest.profiles[0]?.id || null;
  manifest.viewState.activeProfileId = state.profileId;
}

function restoreCollapseState() {
  if (editMode || !config.collapseStorageKey) return;
  try {
    const stored = JSON.parse(localStorage.getItem(config.collapseStorageKey) || "null");
    if (!stored || stored.version !== 1) return;
    for (const node of manifest.nodes) {
      const value = stored.nodes?.[`${node.canvasId}::${node.id}`];
      if (typeof value === "boolean") node.collapsed = value;
    }
    for (const node of manifest.audience.nodes) {
      const value = stored.audienceNodes?.[node.id];
      if (typeof value === "boolean") node.collapsed = value;
    }
  } catch {
    // 部分浏览器会限制 file:// 页面的 localStorage；不影响当前会话内的展开收起。
  }
}

function persistCollapseState() {
  if (editMode || !config.collapseStorageKey) return;
  try {
    localStorage.setItem(config.collapseStorageKey, JSON.stringify({
      version: 1,
      nodes: Object.fromEntries(manifest.nodes.map(node => [`${node.canvasId}::${node.id}`, Boolean(node.collapsed)])),
      audienceNodes: Object.fromEntries(manifest.audience.nodes.map(node => [node.id, Boolean(node.collapsed)]))
    }));
  } catch {
    // 存储不可用时保留当前会话内状态，不阻断画布浏览。
  }
}

function ensureCanvasView(canvasId) {
  manifest.viewState.canvases[canvasId] ||= {
    modes: { mindmap: { x: 80, y: 80, scale: 1 }, snapshot: { x: 80, y: 80, scale: 0.72 } },
    minimap: { scale: 1, collapsed: false }
  };
  return manifest.viewState.canvases[canvasId];
}

function activeCanvasId() {
  return manifest.profiles.find(profile => profile.id === state.profileId)?.canvasId || manifest.viewState.defaultCanvasId || manifest.canvases[0]?.id;
}

function activeNodes() { return manifest.nodes.filter(node => node.canvasId === activeCanvasId()); }
function canvasEdgesFor(canvasId = activeCanvasId()) { return manifest.edges.filter(edge => edge.canvasId === canvasId); }
function activeEdges() { return canvasEdgesFor(activeCanvasId()); }
function currentView() { return ensureCanvasView(activeCanvasId()).modes[state.mode]; }
function activeProfile() { return manifest.profiles.find(profile => profile.id === state.profileId) || null; }
function bindingFor(node) { return state.pendingBindings.get(node?.id) || node?.bindings?.[state.profileId] || node?.bindings?.global || null; }

function sizeNodes(nodes = activeNodes()) {
  const sourceWidth = Math.max(1, Number(manifest.prototype.viewport?.width || 1440));
  const sourceHeight = Math.max(1, Number(manifest.prototype.viewport?.height || 900));
  const sourceAspect = sourceWidth / sourceHeight;
  for (const node of nodes) {
    const titleSize = [...String(node.title || "")].length;
    node.layouts.mindmap.width = clamp(154 + titleSize * 9, 210, 318);
    node.layouts.mindmap.height = 58;
    const bound = Boolean(Object.values(node.bindings || {}).some(binding => binding?.target?.selector || binding?.actions?.length || binding?.scope));
    node.layouts.snapshot.width = bound ? 384 : node.layouts.mindmap.width;
    node.layouts.snapshot.height = bound ? Math.round((384 - 18) / sourceAspect + 63) : 58;
  }
}

function relayout(canvasId = activeCanvasId(), preferredRootIds = []) {
  const nodes = manifest.nodes.filter(node => node.canvasId === canvasId);
  sizeNodes(nodes);
  layoutForest(nodes, canvasEdgesFor(canvasId), "mindmap");
  layoutForest(nodes, canvasEdgesFor(canvasId), "snapshot");
  resolveForestOverlaps(nodes, canvasEdgesFor(canvasId), "mindmap", preferredRootIds);
  resolveForestOverlaps(nodes, canvasEdgesFor(canvasId), "snapshot", preferredRootIds);
}

function renderAll(initialize = false) {
  updateToolbar();
  renderGraph();
  renderInspector();
  applyView();
  renderMinimap();
  if (initialize && activeNodes().length) fitCanvas(false);
  refreshIcons(root);
  updateLiveSoon();
}

function updateToolbar() {
  const profile = activeProfile();
  el("[data-profile-name]").textContent = profile?.name || "未配置用户类型";
  root.querySelectorAll("[data-mode]").forEach(button => button.classList.toggle("is-active", button.dataset.mode === state.mode));
  const label = el("[data-add-label]");
  if (label) label.textContent = state.selectedNodes.size === 1 ? "新增下级" : "新增节点";
  const connectButton = el('[data-action="connect"]');
  connectButton?.classList.toggle("is-active", Boolean(state.connect));
  const view = currentView();
  el(".pc-zoom-value").textContent = `${Math.round(view.scale * 100)}%`;
}

function renderGraph() {
  const allNodes = activeNodes();
  const allEdges = activeEdges();
  const shown = visibleNodes(allNodes, allEdges);
  const shownIds = new Set(shown.map(node => node.id));
  el("[data-empty]").hidden = allNodes.length > 0;
  nodesLayer.innerHTML = shown.map(nodeMarkup).join("");
  nodeControlsLayer.innerHTML = shown.filter(node => childrenOf(node.id, allNodes, allEdges).length).map(collapseControlMarkup).join("");
  const markup = edgeMarkup(allEdges, shownIds);
  hierarchyEdgesLayer.innerHTML = markup.hierarchy;
  edgesLayer.innerHTML = markup.relationships;
  renderDropHint();
  syncSelectionClasses();
  refreshIcons(root);
  attachLiveFrameIfPossible();
}

function nodeMarkup(node) {
  const layout = displayLayout(node);
  const binding = bindingFor(node);
  const snapshot = snapshotFor(node);
  const asset = snapshot?.assetHash ? manifest.snapshotAssets?.[snapshot.assetHash] : null;
  const image = asset?.dataUri || snapshot?.dataUri || "";
  const previewLabel = snapshot?.status === "failed" ? "预览生成失败" : "正在渲染预览";
  const media = state.mode === "snapshot" && binding ? `<div class="pc-node-media" data-live-slot="${node.id}">${image ? `<img class="pc-snapshot" draggable="false" alt="${escapeHtml(node.title)}快照" src="${image}">` : `<div class="pc-snapshot-loading" role="status"><span></span><span></span><span></span><em>${previewLabel}</em></div>`}</div>` : "";
  return `<article class="pc-node type-${escapeHtml(node.type)} ${state.drag?.moved && state.drag.ids?.has(node.id) ? "is-dragging" : ""}" data-node-id="${node.id}" data-type="${escapeHtml(node.type)}" style="left:${layout.x}px;top:${layout.y}px;width:${layout.width}px;height:${layout.height}px" tabindex="0">
    <header><span class="pc-type">${escapeHtml(NODE_TYPES[node.type] || "页面")}</span><strong data-node-title>${escapeHtml(node.title)}</strong>${binding ? `<span class="pc-bound" title="已关联原型"><i data-lucide="check"></i></span>` : ""}</header>${media}
  </article>`;
}

function collapseControlMarkup(node) {
  const layout = displayLayout(node);
  const children = childrenOf(node.id, activeNodes(), activeEdges());
  return `<button class="pc-collapse pc-collapse-overlay" data-collapse="${node.id}" title="${node.collapsed ? "展开下级" : "收起下级"}" style="left:${layout.x + layout.width - 14}px;top:${layout.y + layout.height / 2}px">${node.collapsed ? `<span>${children.length}</span>` : `<i data-lucide="minus"></i>`}</button>`;
}

function displayLayout(node) {
  const layout = node.layouts[state.mode];
  if (!state.drag?.moved || !state.drag.ids?.has(node.id) || !state.drag.tempDelta) return layout;
  return { ...layout, x: layout.x + state.drag.tempDelta.x, y: layout.y + state.drag.tempDelta.y };
}

function edgeMarkup(edges, shownIds) {
  const nodes = new Map(activeNodes().map(node => [node.id, node]));
  const hierarchy = [];
  const relationships = [];
  for (const edge of edges) {
    if (!shownIds.has(edge.source) || !shownIds.has(edge.target)) continue;
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) continue;
    const sourceRect = state.drag?.moved ? nodeRect(source, state.mode) : displayRect(source);
    const targetRect = state.drag?.moved ? nodeRect(target, state.mode) : displayRect(target);
    if (edge.type === "hierarchy") {
      if (state.drag?.moved && (state.drag.ids?.has(edge.source) || state.drag.ids?.has(edge.target))) continue;
      hierarchy.push(`<path class="pc-hierarchy-line" d="${hierarchyPath(nodeRect(source, state.mode), nodeRect(target, state.mode))}"></path>`);
    } else {
      const geometry = relationshipGeometry(edge, sourceRect, targetRect);
      const selected = state.selectedEdgeId === edge.id;
      relationships.push(`<g class="pc-relationship ${selected ? "is-selected" : ""}" data-edge-id="${edge.id}"><path class="pc-relationship-line" marker-end="url(#pc-arrow)" d="${relationshipPath(geometry)}"></path><path class="pc-edge-hit" d="${relationshipPath(geometry)}"></path>${selected ? relationshipHandles(edge, geometry) : ""}</g>`);
    }
  }
  if (state.connect?.sourceId && state.pointerWorld) {
    const source = nodes.get(state.connect.sourceId);
    if (source) {
      const rect = displayRect(source);
      const anchor = projectToBoundary(rect, state.pointerWorld);
      const start = anchorPoint(rect, anchor);
      const end = state.pointerWorld;
      const dx = Math.max(60, Math.abs(end.x - start.x) * .45);
      relationships.push(`<path class="pc-relationship-preview" marker-end="url(#pc-arrow)" d="M ${start.x} ${start.y} C ${start.x + dx} ${start.y}, ${end.x - dx} ${end.y}, ${end.x} ${end.y}"></path>`);
    }
  }
  return {
    hierarchy: hierarchy.join(""),
    relationships: `<defs><marker id="pc-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z"></path></marker></defs>${relationships.join("")}`
  };
}

function relationshipHandles(edge, geometry) {
  return `<line class="pc-control-guide" x1="${geometry.start.x}" y1="${geometry.start.y}" x2="${geometry.control1.x}" y2="${geometry.control1.y}"></line><line class="pc-control-guide" x1="${geometry.end.x}" y1="${geometry.end.y}" x2="${geometry.control2.x}" y2="${geometry.control2.y}"></line>
    <circle class="pc-edge-anchor" data-edge-handle="source" data-edge-id="${edge.id}" cx="${geometry.start.x}" cy="${geometry.start.y}" r="7"></circle>
    <circle class="pc-edge-anchor" data-edge-handle="target" data-edge-id="${edge.id}" cx="${geometry.end.x}" cy="${geometry.end.y}" r="7"></circle>
    <rect class="pc-edge-control" data-edge-control="source" data-edge-id="${edge.id}" x="${geometry.control1.x - 5}" y="${geometry.control1.y - 5}" width="10" height="10"></rect>
    <rect class="pc-edge-control" data-edge-control="target" data-edge-id="${edge.id}" x="${geometry.control2.x - 5}" y="${geometry.control2.y - 5}" width="10" height="10"></rect>`;
}

function displayRect(node) {
  const layout = displayLayout(node);
  return { x: layout.x, y: layout.y, width: layout.width, height: layout.height };
}

function snapshotFor(node) {
  if (state.pendingSnapshots.has(node?.id)) return state.pendingSnapshots.get(node.id);
  const keys = [snapshotKey(node.id, state.profileId || "all"), snapshotKey(node.id, "all"), snapshotKey(node.id, "global")];
  return keys.map(key => manifest.snapshots?.[key]).find(Boolean) || null;
}

function renderDropHint() {
  world.querySelectorAll(".pc-drop-marker,.pc-drag-placeholder").forEach(item => item.remove());
  if (state.drag?.moved) {
    for (const id of state.drag.ids) {
      const node = activeNodes().find(item => item.id === id);
      const layout = state.drag.original[id];
      if (!node || !layout) continue;
      const placeholder = document.createElement("div");
      placeholder.className = "pc-drag-placeholder";
      placeholder.style.cssText = `left:${layout.x}px;top:${layout.y}px;width:${layout.width}px;height:${layout.height}px`;
      placeholder.innerHTML = `<span>${escapeHtml(node.title)}</span>`;
      world.append(placeholder);
    }
  }
  const hint = state.drag?.hint;
  if (!hint) return;
  if (hint.targetId) nodesLayer.querySelector(`[data-node-id="${cssEscape(hint.targetId)}"]`)?.classList.add("is-drop-parent");
  if (hint.marker) {
    const marker = document.createElement("div");
    marker.className = "pc-drop-marker";
    marker.style.cssText = `left:${hint.marker.x}px;top:${hint.marker.y}px;width:${hint.marker.width}px`;
    world.append(marker);
  }
}

function renderInspector() {
  const panel = el("[data-inspector]");
  const selected = [...state.selectedNodes];
  if (!state.inspectorOpen || selected.length !== 1) { panel.hidden = true; return; }
  const node = activeNodes().find(item => item.id === selected[0]);
  if (!node) { panel.hidden = true; return; }
  panel.hidden = false;
  if (window.innerWidth > 900) {
    panel.style.width = `${state.inspectorWidth}px`;
    panel.style.flexBasis = `${state.inspectorWidth}px`;
  } else {
    panel.style.removeProperty("width");
    panel.style.removeProperty("flex-basis");
  }
  const binding = bindingFor(node);
  panel.innerHTML = `<div class="pc-inspector-resizer" data-inspector-resizer role="separator" aria-label="调整节点详情宽度" aria-orientation="vertical" tabindex="0" title="拖拽调整宽度"></div><header><div><span>节点详情</span><strong>${escapeHtml(node.title)}</strong></div><button class="pc-icon-btn" data-inspector-close title="关闭详情"><i data-lucide="panel-right-close"></i></button></header>
    <div class="pc-field"><label for="pc-node-name">页面名称</label>${editMode ? `<input id="pc-node-name" data-edit-name value="${escapeHtml(node.title)}">` : `<p>${escapeHtml(node.title)}</p>`}</div>
    <div class="pc-field"><label for="pc-node-type">节点类型</label>${editMode ? `<select id="pc-node-type" data-edit-type>${Object.entries(NODE_TYPES).map(([value, label]) => `<option value="${value}" ${node.type === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>` : `<p>${escapeHtml(node.typeLabel)}</p>`}</div>
    <div class="pc-field"><label>页面说明</label>${editMode ? `<div class="pc-rich-tools"><button data-rich="bold" title="加粗"><i data-lucide="bold"></i></button><button data-rich="italic" title="斜体"><i data-lucide="italic"></i></button><button data-rich="underline" title="下划线"><i data-lucide="underline"></i></button><button data-rich="insertUnorderedList" title="无序列表"><i data-lucide="list"></i></button><button data-rich="insertOrderedList" title="有序列表"><i data-lucide="list-ordered"></i></button></div><div class="pc-rich" contenteditable="true" data-edit-description>${node.descriptionHtml || "<p>页面说明待补充。</p>"}</div>` : `<div class="pc-rich pc-readonly-rich">${node.descriptionHtml || "<p>页面说明待补充。</p>"}</div>`}</div>
    <div class="pc-binding-status"><span class="${binding ? "is-bound" : ""}"><i data-lucide="${binding ? "check" : "unplug"}"></i>${binding ? "已关联原型页面" : "未关联原型页面"}</span>${editMode ? `<button data-action="locate"><i data-lucide="locate-fixed"></i>${binding ? "重新定位" : "关联页面"}</button>` : ""}</div>`;
  refreshIcons(panel);
}

function applyView() {
  const view = currentView();
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
  clampViewToGraph(view, visibleNodes(activeNodes(), activeEdges()), state.mode, viewport.getBoundingClientRect());
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  el(".pc-zoom-value").textContent = `${Math.round(view.scale * 100)}%`;
}

function clampViewToGraph(view, nodes, mode, rect) {
  if (!nodes.length || !rect.width || !rect.height) return view;
  const bounds = graphBounds(nodes, mode, 36);
  const visibleX = Math.min(180, rect.width * .28);
  const visibleY = Math.min(140, rect.height * .28);
  const minX = visibleX - (bounds.x + bounds.width) * view.scale;
  const maxX = rect.width - visibleX - bounds.x * view.scale;
  const minY = visibleY - (bounds.y + bounds.height) * view.scale;
  const maxY = rect.height - visibleY - bounds.y * view.scale;
  view.x = clamp(view.x, Math.min(minX, maxX), Math.max(minX, maxX));
  view.y = clamp(view.y, Math.min(minY, maxY), Math.max(minY, maxY));
  return view;
}

function setZoom(next, clientPoint = null) {
  const view = currentView();
  const scale = clamp(next, .15, 3);
  const rect = viewport.getBoundingClientRect();
  const point = clientPoint || { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const local = { x: point.x - rect.left, y: point.y - rect.top };
  const worldPoint = { x: (local.x - view.x) / view.scale, y: (local.y - view.y) / view.scale };
  view.x = local.x - worldPoint.x * scale;
  view.y = local.y - worldPoint.y * scale;
  view.scale = scale;
  applyView();
  syncMinimapViewportSoon();
  updateLiveSoon();
}

function fitCanvas(save = true) {
  const nodes = visibleNodes(activeNodes(), activeEdges());
  const bounds = graphBounds(nodes, state.mode, 90);
  const rect = viewport.getBoundingClientRect();
  const scale = clamp(Math.min(rect.width / bounds.width, rect.height / bounds.height), .15, 1.25);
  const view = currentView();
  view.scale = scale;
  view.x = (rect.width - bounds.width * scale) / 2 - bounds.x * scale;
  view.y = (rect.height - bounds.height * scale) / 2 - bounds.y * scale;
  constrainFittedView(view, bounds, rect, 36);
  applyView();
  renderMinimap();
  updateLiveSoon();
  if (save) saveSoon();
}

function switchMode(mode) {
  if (mode === state.mode) return;
  const rect = viewport.getBoundingClientRect();
  const oldView = currentView();
  const centerScreen = { x: rect.width / 2, y: rect.height / 2 };
  const centerClient = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const anchorElement = [...nodesLayer.querySelectorAll("[data-node-id]")].sort((left, right) => rectDistance(left.getBoundingClientRect(), centerClient) - rectDistance(right.getBoundingClientRect(), centerClient))[0];
  const anchor = activeNodes().find(node => node.id === anchorElement?.dataset.nodeId);
  const anchorRect = anchorElement?.getBoundingClientRect();
  const anchorScreen = anchorRect ? { x: anchorRect.left + anchorRect.width / 2 - rect.left, y: anchorRect.top + anchorRect.height / 2 - rect.top } : centerScreen;
  state.mode = mode;
  manifest.viewState.activeMode = mode;
  const next = currentView();
  if (anchor) {
    const nextCenter = centerOf(anchor.layouts[mode]);
    next.x = anchorScreen.x - nextCenter.x * next.scale;
    next.y = anchorScreen.y - nextCenter.y * next.scale;
  }
  stopInlineFrame();
  renderAll();
  saveSoon();
}

function renderMinimap() {
  const scroll = el("[data-minimap-scroll]");
  const content = el("[data-minimap-content]");
  const scrollLeft = scroll.scrollLeft;
  const scrollTop = scroll.scrollTop;
  const nodes = visibleNodes(activeNodes(), activeEdges());
  const bounds = graphBounds(nodes, state.mode, 80);
  const miniScale = ensureCanvasView(activeCanvasId()).minimap.scale;
  const factor = .09 * miniScale;
  const inset = 12;
  const width = Math.max(218, bounds.width * factor + inset * 2);
  const height = Math.max(132, bounds.height * factor + inset * 2);
  const view = currentView();
  const rect = viewport.getBoundingClientRect();
  const worldViewport = { x: -view.x / view.scale, y: -view.y / view.scale, width: rect.width / view.scale, height: rect.height / view.scale };
  const mapBounds = alignedMinimapBounds(bounds, factor, width, height);
  content.style.width = `${width}px`;
  content.style.height = `${height}px`;
  content.dataset.bounds = JSON.stringify({ ...mapBounds, factor });
  content.innerHTML = nodes.map(node => {
    const layout = node.layouts[state.mode];
    return `<span class="pc-mini-node type-${node.type}" style="left:${(layout.x - mapBounds.x) * factor}px;top:${(layout.y - mapBounds.y) * factor}px;width:${Math.max(3, layout.width * factor)}px;height:${Math.max(3, layout.height * factor)}px"></span>`;
  }).join("") + minimapViewportMarkup(worldViewport, mapBounds, factor, width, height, "data-mini-viewport");
  el("[data-minimap-scale]").textContent = `${Math.round(miniScale * 100)}%`;
  scroll.scrollLeft = clamp(scrollLeft, 0, Math.max(0, width - scroll.clientWidth));
  scroll.scrollTop = clamp(scrollTop, 0, Math.max(0, height - scroll.clientHeight));
}

function alignedMinimapBounds(bounds, factor, width, height) {
  const graphWidth = bounds.width * factor;
  const graphHeight = bounds.height * factor;
  const freeX = Math.max(0, width - graphWidth);
  const freeY = Math.max(0, height - graphHeight);
  const offsetX = freeX / 2;
  const offsetY = freeY / 2;
  return { x: bounds.x - offsetX / factor, y: bounds.y - offsetY / factor, width: width / factor, height: height / factor };
}

function minimapViewportMarkup(worldViewport, bounds, factor, width, height, attribute) {
  const geometry = minimapViewportGeometry(worldViewport, bounds, factor, width, height);
  return `<span class="pc-mini-viewport" ${attribute} title="当前画布中心，拖拽定位" style="${minimapViewportStyle(geometry)}"></span>`;
}

function minimapViewportGeometry(worldViewport, bounds, factor, width, height) {
  const inset = 3;
  const rawWidth = Math.max(2, worldViewport.width * factor);
  const rawHeight = Math.max(2, worldViewport.height * factor);
  const markerWidth = clamp(rawWidth, 18, Math.min(84, Math.max(18, width - inset * 2)));
  const markerHeight = clamp(rawHeight, 18, Math.min(62, Math.max(18, height - inset * 2)));
  const rawCenterX = (worldViewport.x + worldViewport.width / 2 - bounds.x) * factor;
  const rawCenterY = (worldViewport.y + worldViewport.height / 2 - bounds.y) * factor;
  const markerLeft = clamp(rawCenterX - markerWidth / 2, inset, Math.max(inset, width - inset - markerWidth));
  const markerTop = clamp(rawCenterY - markerHeight / 2, inset, Math.max(inset, height - inset - markerHeight));
  return { left: markerLeft, top: markerTop, width: markerWidth, height: markerHeight };
}

function minimapViewportStyle(geometry) {
  return `left:${geometry.left}px;top:${geometry.top}px;width:${geometry.width}px;height:${geometry.height}px`;
}

function syncMinimapViewport() {
  const content = el("[data-minimap-content]");
  if (!content?.dataset.bounds) return;
  const bounds = JSON.parse(content.dataset.bounds);
  const view = currentView();
  const rect = viewport.getBoundingClientRect();
  const worldViewport = { x: -view.x / view.scale, y: -view.y / view.scale, width: rect.width / view.scale, height: rect.height / view.scale };
  const geometry = minimapViewportGeometry(worldViewport, bounds, bounds.factor, content.offsetWidth, content.offsetHeight);
  let marker = content.querySelector("[data-mini-viewport]");
  if (!marker) {
    marker = document.createElement("span");
    marker.className = "pc-mini-viewport";
    marker.dataset.miniViewport = "";
    marker.title = "当前画布中心，拖拽定位";
    content.append(marker);
  }
  marker.style.cssText = minimapViewportStyle(geometry);
}

function syncMinimapViewportSoon() {
  if (minimapSyncFrame) return;
  minimapSyncFrame = requestAnimationFrame(() => {
    minimapSyncFrame = 0;
    syncMinimapViewport();
  });
}

function syncAudienceMinimapViewport() {
  const overlay = el("[data-audience-overlay]");
  const content = overlay?.querySelector("[data-audience-minimap-content]");
  const audienceViewport = overlay?.querySelector("[data-audience-viewport]");
  if (!content?.dataset.bounds || !audienceViewport) return;
  const bounds = JSON.parse(content.dataset.bounds);
  const rect = audienceViewport.getBoundingClientRect();
  const view = state.audienceView;
  const worldViewport = { x: -view.x / view.scale, y: -view.y / view.scale, width: rect.width / view.scale, height: rect.height / view.scale };
  const geometry = minimapViewportGeometry(worldViewport, bounds, bounds.factor, content.offsetWidth, content.offsetHeight);
  let marker = content.querySelector("[data-audience-mini-viewport]");
  if (!marker) {
    marker = document.createElement("span");
    marker.className = "pc-mini-viewport";
    marker.dataset.audienceMiniViewport = "";
    marker.title = "当前画布中心，拖拽定位";
    content.append(marker);
  }
  marker.style.cssText = minimapViewportStyle(geometry);
}

function syncAudienceMinimapViewportSoon() {
  if (audienceMinimapSyncFrame) return;
  audienceMinimapSyncFrame = requestAnimationFrame(() => {
    audienceMinimapSyncFrame = 0;
    syncAudienceMinimapViewport();
  });
}

function constrainFittedView(view, bounds, rect, padding) {
  if (bounds.width * view.scale <= rect.width - padding * 2) {
    view.x = clamp(view.x, padding - bounds.x * view.scale, rect.width - padding - (bounds.x + bounds.width) * view.scale);
  }
  if (bounds.height * view.scale <= rect.height - padding * 2) {
    view.y = clamp(view.y, padding - bounds.y * view.scale, rect.height - padding - (bounds.y + bounds.height) * view.scale);
  }
}

function renderAudience() {
  const overlay = el("[data-audience-overlay]");
  overlay.hidden = false;
  state.audience = { pan: null };
  layoutAudience();
  overlay.innerHTML = `<div class="pc-audience-backdrop" data-audience-action="close"></div><section class="pc-audience-dialog" role="dialog" aria-modal="true" aria-label="用户类型管理" tabindex="-1"><header class="pc-toolbar"><div class="pc-brand"><i data-lucide="users-round"></i><strong>用户类型管理</strong></div>${editMode ? `<span class="pc-divider"></span><button data-audience-action="add"><i data-lucide="plus"></i><span data-audience-add-label>新增用户类型</span></button><button class="pc-icon-btn" data-audience-action="undo" title="撤销"><i data-lucide="undo-2"></i></button><button class="pc-icon-btn" data-audience-action="redo" title="重做"><i data-lucide="redo-2"></i></button>` : ""}<label class="pc-audience-search"><i data-lucide="search"></i><input data-audience-search placeholder="搜索用户类型" value="${escapeHtml(state.audienceSearch)}"></label><span class="pc-toolbar-spacer"></span><button class="pc-icon-btn" data-audience-action="zoom-out" title="缩小"><i data-lucide="zoom-out"></i></button><span class="pc-audience-zoom">${Math.round(state.audienceView.scale * 100)}%</span><button class="pc-icon-btn" data-audience-action="zoom-in" title="放大"><i data-lucide="zoom-in"></i></button><button class="pc-icon-btn" data-audience-action="close" title="关闭"><i data-lucide="x"></i></button></header>
    <div class="pc-audience-main"><div class="pc-audience-viewport" data-audience-viewport tabindex="0"><div class="pc-audience-world" data-audience-world><svg class="pc-edges pc-hierarchy-edges" data-audience-edges></svg><div data-audience-nodes></div></div><div class="pc-selection-box" data-audience-box hidden></div><section class="pc-minimap pc-audience-minimap" aria-label="用户类型鸟瞰图"><header><strong>鸟瞰图</strong><div><button data-audience-minimap="out" title="缩小鸟瞰图"><i data-lucide="zoom-out"></i></button><span data-audience-minimap-scale>100%</span><button data-audience-minimap="in" title="放大鸟瞰图"><i data-lucide="zoom-in"></i></button></div></header><div class="pc-minimap-scroll" data-audience-minimap-scroll><div class="pc-minimap-content" data-audience-minimap-content></div></div></section></div><aside class="pc-audience-inspector" data-audience-inspector hidden></aside></div></section>`;
  bindAudienceEvents();
  renderAudienceGraph();
  fitAudience(false);
  refreshIcons(overlay);
  overlay.querySelector(".pc-audience-dialog")?.focus();
}

function renderAudienceGraph() {
  persistCollapseState();
  const overlay = el("[data-audience-overlay]");
  if (overlay.hidden) return;
  overlay.querySelectorAll(".pc-drop-marker").forEach(marker => marker.remove());
  if (!state.audienceDrag?.moved) layoutAudience();
  const nodes = manifest.audience.nodes;
  const shown = audienceVisibleNodes();
  const shownIds = new Set(shown.map(node => node.id));
  overlay.querySelector("[data-audience-nodes]").innerHTML = shown.map(node => {
    const layout = audienceDisplayLayout(node);
    const childCount = nodes.filter(item => item.parentId === node.id).length;
    const isLeaf = childCount === 0 && node.profileId;
    return `<article class="pc-audience-node audience-type-${escapeHtml(node.type)} ${state.audienceSelected.has(node.id) ? "is-selected" : ""} ${state.audienceDrag?.moved && state.audienceDrag.ids?.has(node.id) ? "is-dragging" : ""}" data-audience-node="${node.id}" data-audience-type="${escapeHtml(node.type)}" data-parent-id="${escapeHtml(node.parentId || "")}" style="left:${layout.x}px;top:${layout.y}px;width:${layout.width}px;height:${layout.height}px"><span class="pc-audience-type">${escapeHtml(node.typeLabel || AUDIENCE_TYPES[node.type] || "角色")}</span><strong>${escapeHtml(node.title)}</strong>${isLeaf ? `<button data-switch-profile="${node.profileId}" title="进入该用户类型画布"><i data-lucide="chevron-right"></i></button>` : ""}${childCount ? `<button class="pc-collapse" data-audience-collapse="${node.id}">${node.collapsed ? `<span>${childCount}</span>` : `<i data-lucide="minus"></i>`}</button>` : ""}</article>`;
  }).join("");
  overlay.querySelector("[data-audience-edges]").innerHTML = nodes.filter(node => node.parentId && shownIds.has(node.id) && shownIds.has(node.parentId) && !(state.audienceDrag?.moved && (state.audienceDrag.ids?.has(node.id) || state.audienceDrag.ids?.has(node.parentId)))).map(node => {
    const parent = nodes.find(item => item.id === node.parentId);
    return `<path class="pc-hierarchy-line" d="${audiencePath(parent.layout, node.layout)}"></path>`;
  }).join("");
  overlay.querySelectorAll(".pc-drag-placeholder").forEach(item => item.remove());
  if (state.audienceDrag?.moved) {
    for (const id of state.audienceDrag.ids) {
      const node = nodes.find(item => item.id === id);
      const layout = state.audienceDrag.original[id];
      if (!node || !layout) continue;
      const placeholder = document.createElement("div");
      placeholder.className = "pc-drag-placeholder";
      placeholder.style.cssText = `left:${layout.x}px;top:${layout.y}px;width:${layout.width}px;height:${layout.height}px`;
      placeholder.innerHTML = `<span>${escapeHtml(node.title)}</span>`;
      overlay.querySelector("[data-audience-world]").append(placeholder);
    }
  }
  const hint = state.audienceDrag?.hint;
  if (hint?.targetId) overlay.querySelector(`[data-audience-node="${cssEscape(hint.targetId)}"]`)?.classList.add("is-drop-parent");
  if (hint?.marker) {
    const marker = document.createElement("div"); marker.className = "pc-drop-marker";
    marker.style.cssText = `left:${hint.marker.x}px;top:${hint.marker.y}px;width:${hint.marker.width}px`;
    overlay.querySelector("[data-audience-world]").append(marker);
  }
  const worldEl = overlay.querySelector("[data-audience-world]");
  const audienceViewport = overlay.querySelector("[data-audience-viewport]");
  audienceViewport.scrollLeft = 0;
  audienceViewport.scrollTop = 0;
  clampAudienceView();
  worldEl.style.transform = `translate(${state.audienceView.x}px, ${state.audienceView.y}px) scale(${state.audienceView.scale})`;
  overlay.querySelector(".pc-audience-zoom").textContent = `${Math.round(state.audienceView.scale * 100)}%`;
  const addLabel = overlay.querySelector("[data-audience-add-label]");
  if (addLabel) addLabel.textContent = state.audienceSelected.size === 1 ? "新增下级" : "新增用户类型";
  renderAudienceInspector();
  ensureAudienceSelectionVisible();
  renderAudienceMinimap();
  refreshIcons(overlay);
}

function renderAudienceMinimap() {
  const overlay = el("[data-audience-overlay]");
  const scroll = overlay.querySelector("[data-audience-minimap-scroll]");
  const content = overlay.querySelector("[data-audience-minimap-content]");
  const audienceViewport = overlay.querySelector("[data-audience-viewport]");
  if (!scroll || !content || !audienceViewport) return;
  const scrollLeft = scroll.scrollLeft;
  const scrollTop = scroll.scrollTop;
  const nodes = audienceVisibleNodes();
  const bounds = audienceBounds(nodes, 70);
  const factor = .09 * state.audienceMinimapScale;
  const inset = 12;
  const width = Math.max(218, bounds.width * factor + inset * 2);
  const height = Math.max(132, bounds.height * factor + inset * 2);
  const rect = audienceViewport.getBoundingClientRect();
  const view = state.audienceView;
  const worldViewport = { x: -view.x / view.scale, y: -view.y / view.scale, width: rect.width / view.scale, height: rect.height / view.scale };
  const mapBounds = alignedMinimapBounds(bounds, factor, width, height);
  content.style.width = `${width}px`;
  content.style.height = `${height}px`;
  content.dataset.bounds = JSON.stringify({ ...mapBounds, factor });
  content.innerHTML = nodes.map(node => `<span class="pc-mini-node" style="left:${(node.layout.x - mapBounds.x) * factor}px;top:${(node.layout.y - mapBounds.y) * factor}px;width:${Math.max(3, node.layout.width * factor)}px;height:${Math.max(3, node.layout.height * factor)}px"></span>`).join("") + minimapViewportMarkup(worldViewport, mapBounds, factor, width, height, "data-audience-mini-viewport");
  overlay.querySelector("[data-audience-minimap-scale]").textContent = `${Math.round(state.audienceMinimapScale * 100)}%`;
  scroll.scrollLeft = clamp(scrollLeft, 0, Math.max(0, width - scroll.clientWidth));
  scroll.scrollTop = clamp(scrollTop, 0, Math.max(0, height - scroll.clientHeight));
}

function layoutAudience() {
  const nodes = manifest.audience.nodes;
  for (const node of nodes) {
    node.layout.width = clamp(190 + [...String(node.title || "")].length * 6, 220, 310);
    node.layout.height = 58;
  }
  const edges = nodes.filter(node => node.parentId).map(node => ({ id: `aud-${node.id}`, source: node.parentId, target: node.id, type: "hierarchy" }));
  const wrapped = nodes.map(node => ({ ...node, layouts: { mindmap: node.layout, snapshot: node.layout } }));
  layoutForest(wrapped, edges, "mindmap", { initialize: true });
  resolveForestOverlaps(wrapped, edges, "mindmap", state.audienceDrag?.rootIds || []);
}

function audienceDisplayLayout(node) {
  const drag = state.audienceDrag;
  if (!drag?.moved || drag.root || !drag.ids?.has(node.id)) return node.layout;
  return { ...node.layout, x: node.layout.x + drag.tempDelta.x, y: node.layout.y + drag.tempDelta.y };
}

function audienceVisibleNodes() {
  const nodes = manifest.audience.nodes;
  const edges = nodes.filter(node => node.parentId).map(node => ({ source: node.parentId, target: node.id, type: "hierarchy" }));
  const wrapped = nodes.map(node => ({ ...node, layouts: { mindmap: node.layout, snapshot: node.layout } }));
  if (!state.audienceSearch.trim()) return visibleNodes(wrapped, edges).map(item => nodes.find(node => node.id === item.id));
  const query = state.audienceSearch.trim().toLowerCase();
  const keep = new Set([manifest.audience.rootId]);
  for (const matched of nodes.filter(node => node.title.toLowerCase().includes(query))) {
    let current = matched;
    while (current) {
      keep.add(current.id);
      current = nodes.find(node => node.id === current.parentId);
    }
  }
  return nodes.filter(node => keep.has(node.id));
}

function selectedAudienceNode() {
  if (state.audienceSelected.size !== 1) return null;
  return manifest.audience.nodes.find(node => state.audienceSelected.has(node.id)) || null;
}

function renderAudienceInspector() {
  const panel = el("[data-audience-inspector]");
  if (!panel) return;
  const node = selectedAudienceNode();
  if (!node) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = `<header><div><span>用户类型详情</span><strong>${escapeHtml(node.title)}</strong></div><button class="pc-icon-btn" data-audience-inspector-close title="关闭详情"><i data-lucide="panel-right-close"></i></button></header>
    <div class="pc-field"><label for="pc-audience-name">名称</label>${editMode ? `<input id="pc-audience-name" data-audience-edit-name value="${escapeHtml(node.title)}">` : `<p>${escapeHtml(node.title)}</p>`}</div>
    <div class="pc-field"><label for="pc-audience-type">类型</label>${editMode ? `<select id="pc-audience-type" data-audience-edit-type ${node.id === manifest.audience.rootId ? "disabled" : ""}>${Object.entries(AUDIENCE_TYPES).map(([value, label]) => `<option value="${value}" ${node.type === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>` : `<p>${escapeHtml(node.typeLabel || AUDIENCE_TYPES[node.type])}</p>`}</div>
    <div class="pc-field"><label>说明</label>${editMode ? `<div class="pc-rich-tools"><button data-audience-rich="bold" title="加粗"><i data-lucide="bold"></i></button><button data-audience-rich="italic" title="斜体"><i data-lucide="italic"></i></button><button data-audience-rich="underline" title="下划线"><i data-lucide="underline"></i></button><button data-audience-rich="insertUnorderedList" title="无序列表"><i data-lucide="list"></i></button></div><div class="pc-rich" contenteditable="true" data-audience-edit-description>${node.descriptionHtml || "<p>说明待补充。</p>"}</div>` : `<div class="pc-rich pc-readonly-rich">${node.descriptionHtml || "<p>说明待补充。</p>"}</div>`}</div>`;
  refreshIcons(panel);
}

function bindEvents() {
  root.addEventListener("click", onClick);
  root.addEventListener("dblclick", onDoubleClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("pointerdown", onRootPointerDown);
  viewport.addEventListener("pointerdown", onViewportPointerDown);
  viewport.addEventListener("pointermove", event => {
    state.pointerWorld = clientToWorld(event.clientX, event.clientY);
    if (state.connect) renderGraph();
  });
  viewport.addEventListener("wheel", onWheel, { passive: false });
  el("[data-minimap-scroll]").addEventListener("wheel", onMinimapWheel, { passive: false });
  document.addEventListener("pointermove", onDocumentPointerMove);
  document.addEventListener("pointerup", onDocumentPointerUp);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", event => { if (event.code === "Space") state.spaceDown = false; });
  document.addEventListener("dragstart", event => { if (event.target.closest?.(".pc-node")) event.preventDefault(); });
  addEventListener("message", onFrameMessage);
  addEventListener("resize", debounce(() => { renderMinimap(); updateLivePreview(); }, 120));
}

function onRootPointerDown(event) {
  if (!event.target.closest("[data-inspector-resizer]") || event.button !== 0) return;
  state.inspectorResize = { startX: event.clientX, startWidth: state.inspectorWidth };
  document.body.classList.add("is-resizing-inspector");
  event.preventDefault();
}

function onClick(event) {
  clearTimeout(state.nodeClickTimer);
  state.nodeClickTimer = null;
  const minimapAction = event.target.closest("[data-minimap]")?.dataset.minimap;
  if (minimapAction) {
    const settings = ensureCanvasView(activeCanvasId()).minimap;
    settings.scale = clamp(settings.scale * (minimapAction === "in" ? 1.25 : .8), .5, 4);
    renderMinimap(); saveSoon(); return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action) {
    if (action === "audience") renderAudience();
    if (action === "add") addNode();
    if (action === "connect") beginRelationship();
    if (action === "undo") undo();
    if (action === "redo") redo();
    if (action === "zoom-in") setZoom(currentView().scale * 1.16);
    if (action === "zoom-out") setZoom(currentView().scale / 1.16);
    if (action === "zoom-reset") setZoom(1);
    if (action === "fit") fitCanvas();
    if (action === "shortcuts") showShortcutDialog();
    if (action === "export") showExportDialog();
    if (action === "prototype-back") closePrototype();
    if (action === "locate") startLocate();
    if (action === "locate-confirm") confirmLocate();
    if (action === "locate-cancel") closePrototype();
    return;
  }
  const mode = event.target.closest("[data-mode]")?.dataset.mode;
  if (mode) return switchMode(mode);
  const collapseId = event.target.closest("[data-collapse]")?.dataset.collapse;
  if (collapseId) return toggleCollapse(collapseId);
  const rich = event.target.closest("[data-rich]")?.dataset.rich;
  if (rich) { document.execCommand(rich); el("[data-edit-description]")?.focus(); return; }
  if (event.target.closest("[data-inspector-close]")) { state.inspectorOpen = false; renderInspector(); renderMinimap(); updateLiveSoon(); return; }
  const edge = event.target.closest("[data-edge-id]");
  if (edge && !event.target.closest("[data-edge-handle],[data-edge-control]")) {
    state.selectedEdgeId = edge.dataset.edgeId;
    state.selectedNodes.clear();
    renderAll();
    return;
  }
  const nodeElement = event.target.closest("[data-node-id]");
  if (nodeElement && state.suppressNodeClick) { state.suppressNodeClick = false; return; }
  if (nodeElement && !event.target.closest("button")) selectOrConnectNode(nodeElement.dataset.nodeId, event);
}

function onDoubleClick(event) {
  clearTimeout(state.nodeClickTimer);
  state.nodeClickTimer = null;
  const nodeElement = event.target.closest("[data-node-id]");
  if (nodeElement) {
    const node = activeNodes().find(item => item.id === nodeElement.dataset.nodeId);
    if (!node) return;
    if (editMode && event.target.closest("[data-node-title]")) return beginInlineRename(node, event.target.closest("[data-node-title]"));
    return openPrototype(node);
  }
  if (editMode && event.target.closest("[data-viewport]") && !event.target.closest(".pc-minimap,.pc-inspector")) addNode(clientToWorld(event.clientX, event.clientY), true);
}

function onInput(event) {
  if (event.target.matches("[data-audience-search]")) {
    state.audienceSearch = event.target.value;
    const selectionStart = event.target.selectionStart;
    renderAudienceGraph();
    const input = el("[data-audience-search]");
    input?.focus(); input?.setSelectionRange(selectionStart, selectionStart);
    return;
  }
  const audienceNode = selectedAudienceNode();
  if (audienceNode && editMode && event.target.matches("[data-audience-edit-name]")) {
    audienceNode.title = event.target.value || "未命名用户类型";
    syncAudienceIdentityName(audienceNode);
    el(`[data-audience-node="${cssEscape(audienceNode.id)}"] > strong`)?.replaceChildren(audienceNode.title);
    el("[data-audience-inspector] header strong")?.replaceChildren(audienceNode.title);
    state.lastOperation = "修改用户类型名称";
    saveSoon();
    return;
  }
  if (audienceNode && editMode && event.target.matches("[data-audience-edit-description]")) {
    audienceNode.descriptionHtml = sanitizeRichHtml(event.target.innerHTML);
    state.lastOperation = "修改用户类型说明";
    saveSoon();
    return;
  }
  const node = selectedNode();
  if (!node || !editMode) return;
  if (event.target.matches("[data-edit-name]")) {
    node.title = event.target.value || "未命名节点";
    node.userEdited = true;
    sizeNodes([node]);
    relayout();
    state.lastOperation = "修改节点名称";
    saveSoon();
    renderGraph();
    updateToolbar();
  }
  if (event.target.matches("[data-edit-description]")) {
    node.descriptionHtml = sanitizeRichHtml(event.target.innerHTML);
    node.descriptionSource = "user";
    node.userEdited = true;
    state.lastOperation = "修改页面说明";
    saveSoon();
  }
}

function onChange(event) {
  const audienceNode = selectedAudienceNode();
  if (audienceNode && editMode && event.target.matches("[data-audience-edit-type]")) return mutate("修改用户类型节点类型", () => {
    audienceNode.type = event.target.value;
    audienceNode.typeLabel = AUDIENCE_TYPES[audienceNode.type];
  }, true);
  const node = selectedNode();
  if (node && editMode && event.target.matches("[data-edit-type]")) mutate("修改节点类型", () => {
    node.type = event.target.value;
    node.typeLabel = NODE_TYPES[node.type];
    node.userEdited = true;
  });
}

function onViewportPointerDown(event) {
  if (event.button !== 0) return;
  if (event.target.closest("button,input,select,[contenteditable]")) return;
  const handle = event.target.closest("[data-edge-handle],[data-edge-control]");
  if (handle && editMode) return beginEdgeHandleDrag(event, handle);
  if (event.target.closest("[data-edge-id]")) return;
  const nodeElement = event.target.closest("[data-node-id]");
  if (nodeElement && state.connect) return;
  if (nodeElement && editMode && !event.target.closest("button,input,select,[contenteditable]")) return beginNodeDrag(event, nodeElement.dataset.nodeId);
  if (nodeElement) return;
  if (event.target.closest(".pc-minimap")) return beginMinimapDrag(event);
  if (state.spaceDown) {
    state.pan = { x: event.clientX, y: event.clientY, startX: currentView().x, startY: currentView().y };
    viewport.classList.add("is-panning");
    event.preventDefault();
    return;
  }
  if (!event.target.closest("[data-world]") || event.target === world || event.target === nodesLayer || event.target === edgesLayer || event.target.closest(".pc-viewport")) {
    state.box = { startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false };
    event.preventDefault();
  }
}

function onDocumentPointerMove(event) {
  if (state.inspectorResize) {
    const maxWidth = Math.max(260, Math.min(640, window.innerWidth * .55));
    state.inspectorWidth = clamp(state.inspectorResize.startWidth + state.inspectorResize.startX - event.clientX, 260, maxWidth);
    const panel = el("[data-inspector]");
    panel.style.width = `${state.inspectorWidth}px`;
    panel.style.flexBasis = `${state.inspectorWidth}px`;
    syncMinimapViewportSoon();
    attachLiveFrameIfPossible();
    return;
  }
  if (state.pan) {
    const view = currentView();
    view.x = state.pan.startX + event.clientX - state.pan.x;
    view.y = state.pan.startY + event.clientY - state.pan.y;
    applyView(); syncMinimapViewportSoon(); updateLiveSoon(); return;
  }
  if (state.box) return updateSelectionBox(event);
  if (state.drag) return updateNodeDrag(event);
  if (state.edgeDrag) return updateEdgeHandleDrag(event);
}

function onDocumentPointerUp(event) {
  if (state.inspectorResize) {
    state.inspectorResize = null;
    document.body.classList.remove("is-resizing-inspector");
    manifest.viewState.inspectorWidth = state.inspectorWidth;
    saveSoon();
  }
  if (state.pan) { state.pan = null; viewport.classList.remove("is-panning"); saveSoon(); }
  if (state.box) finishSelectionBox(event);
  if (state.drag) finishNodeDrag(event);
  if (state.edgeDrag) finishEdgeHandleDrag();
}

function onWheel(event) {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) return setZoom(currentView().scale * Math.exp(-event.deltaY * .0015), { x: event.clientX, y: event.clientY });
  const view = currentView();
  if (event.shiftKey) view.x -= event.deltaY || event.deltaX;
  else { view.x -= event.deltaX; view.y -= event.deltaY; }
  applyView(); syncMinimapViewportSoon(); updateLiveSoon(); saveSoon();
}

function onMinimapWheel(event) {
  const scroll = event.currentTarget;
  event.preventDefault();
  event.stopPropagation();
  if (event.shiftKey) scroll.scrollLeft += event.deltaY || event.deltaX;
  else {
    scroll.scrollLeft += event.deltaX;
    scroll.scrollTop += event.deltaY;
  }
}

function onKeyDown(event) {
  const resizer = event.target.closest?.("[data-inspector-resizer]");
  if (resizer && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    state.inspectorWidth = clamp(state.inspectorWidth + (event.key === "ArrowLeft" ? 24 : -24), 260, Math.max(260, Math.min(640, window.innerWidth * .55)));
    manifest.viewState.inspectorWidth = state.inspectorWidth;
    renderInspector(); syncMinimapViewportSoon(); updateLiveSoon(); saveSoon();
    requestAnimationFrame(() => el("[data-inspector-resizer]")?.focus());
    return;
  }
  const typing = event.target.matches?.("input,textarea,select,[contenteditable=true]");
  if (event.code === "Space" && !typing) { state.spaceDown = true; event.preventDefault(); }
  if (typing) return;
  if (el("[data-dialog-layer]").classList.contains("is-open")) {
    if (event.key === "Escape") { event.preventDefault(); closeDialog(); }
    return;
  }
  const ctrl = event.ctrlKey || event.metaKey;
  if (!el("[data-audience-overlay]").hidden) {
    if (ctrl && event.key.toLowerCase() === "z") { event.preventDefault(); return event.shiftKey ? redo(true) : undo(true); }
    if (ctrl && event.key.toLowerCase() === "y") { event.preventDefault(); return redo(true); }
    if ((event.key === "Delete" || event.key === "Backspace") && editMode) { event.preventDefault(); return deleteAudienceSelection(); }
    if (event.key === "F2" && editMode) { event.preventDefault(); const node = selectedAudienceNode(); if (node) beginAudienceRename(node, el(`[data-audience-node="${cssEscape(node.id)}"]`)); return; }
    if (event.key === "Tab" && event.shiftKey && editMode) { event.preventDefault(); return outdentAudienceSelected(); }
    if (event.key === "Tab" && editMode) { event.preventDefault(); return addAudienceNode(); }
    if (event.key === "Enter" && editMode) { event.preventDefault(); return addAudienceSibling(event.shiftKey); }
    if (event.altKey && event.key === "ArrowUp" && editMode) { event.preventDefault(); return reorderAudienceSelected(-1); }
    if (event.altKey && event.key === "ArrowDown" && editMode) { event.preventDefault(); return reorderAudienceSelected(1); }
    if (ctrl && event.key === "/") { event.preventDefault(); const node = manifest.audience.nodes.find(item => state.audienceSelected.has(item.id)); if (node) { node.collapsed = !node.collapsed; renderAudienceGraph(); saveSoon(); } return; }
    if (event.key === "Home") { event.preventDefault(); return fitAudience(); }
    if (event.key === "Escape") { closeAudience(); return; }
    return;
  }
  if (ctrl && event.key.toLowerCase() === "z") { event.preventDefault(); return event.shiftKey ? redo() : undo(); }
  if (ctrl && event.key.toLowerCase() === "y") { event.preventDefault(); return redo(); }
  if (ctrl && event.key.toLowerCase() === "d" && editMode) { event.preventDefault(); return duplicateSelectedSubtree(); }
  if (ctrl && event.key === "+" || ctrl && event.key === "=") { event.preventDefault(); return setZoom(currentView().scale * 1.16); }
  if (ctrl && event.key === "-") { event.preventDefault(); return setZoom(currentView().scale / 1.16); }
  if (ctrl && event.key === "0") { event.preventDefault(); return setZoom(1); }
  if (ctrl && event.shiftKey && event.key.toLowerCase() === "r" && editMode) { event.preventDefault(); return beginRelationship(); }
  if (ctrl && event.key === "/" && editMode) { event.preventDefault(); const node = selectedNode(); if (node) toggleCollapse(node.id); return; }
  if (event.key === "Home") { event.preventDefault(); return fitCanvas(); }
  if ((event.key === "Delete" || event.key === "Backspace") && editMode) { event.preventDefault(); return deleteSelection(); }
  if (event.key === "Escape") { state.connect = null; state.selectedEdgeId = null; renderAll(); return; }
  if (event.key === "F2" && editMode) { event.preventDefault(); const node = selectedNode(); if (node) beginInlineRename(node, nodesLayer.querySelector(`[data-node-id="${cssEscape(node.id)}"] [data-node-title]`)); return; }
  if (event.key === "Tab" && event.shiftKey && editMode) { event.preventDefault(); return outdentSelected(); }
  if (event.key === "Tab" && editMode) { event.preventDefault(); return addNode(); }
  if (event.key === "Enter" && editMode) { event.preventDefault(); return addSibling(event.shiftKey); }
  if (event.altKey && event.key === "ArrowUp" && editMode) { event.preventDefault(); return reorderSelected(-1); }
  if (event.altKey && event.key === "ArrowDown" && editMode) { event.preventDefault(); return reorderSelected(1); }
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && !event.altKey) { event.preventDefault(); return selectSpatialNeighbor(event.key); }
}

function selectOrConnectNode(nodeId, event) {
  if (state.connect) {
    if (!state.connect.sourceId) { state.connect.sourceId = nodeId; state.pointerWorld = centerOf(activeNodes().find(node => node.id === nodeId).layouts[state.mode]); renderAll(); return; }
    if (state.connect.sourceId !== nodeId) createRelationship(state.connect.sourceId, nodeId);
    return;
  }
  if (event.ctrlKey || event.metaKey || event.shiftKey) {
    if (state.selectedNodes.has(nodeId)) state.selectedNodes.delete(nodeId); else state.selectedNodes.add(nodeId);
  } else if (!state.selectedNodes.has(nodeId) || state.selectedNodes.size > 1) {
    state.selectedNodes.clear(); state.selectedNodes.add(nodeId);
  }
  state.selectedEdgeId = null;
  updateToolbar(); syncSelectionClasses();
  if (!el("[data-inspector]").hidden) renderInspector();
  else if (state.selectedNodes.size === 1) {
    state.nodeClickTimer = setTimeout(() => {
      state.nodeClickTimer = null;
      if (state.selectedNodes.size !== 1 || state.overlayNodeId) return;
      state.inspectorOpen = true;
      renderInspector(); renderMinimap(); updateLiveSoon();
    }, 250);
  }
  requestAnimationFrame(() => { renderMinimap(); attachLiveFrameIfPossible(); });
}

function selectedNode() {
  if (state.selectedNodes.size !== 1) return null;
  const id = [...state.selectedNodes][0];
  return activeNodes().find(node => node.id === id) || null;
}

function syncSelectionClasses() {
  nodesLayer.querySelectorAll("[data-node-id]").forEach(node => node.classList.toggle("is-selected", state.selectedNodes.has(node.dataset.nodeId)));
}

function addNode(point = null, forceRoot = false) {
  if (!editMode) return;
  const parent = !forceRoot ? selectedNode() : null;
  const canvasId = activeCanvasId();
  const id = uniqueId("node");
  const center = point || screenCenterWorld();
  const node = {
    id, canvasId, type: "page", typeLabel: NODE_TYPES.page, title: parent ? "新下级" : "新节点", descriptionHtml: "<p>页面说明待补充。</p>", descriptionSource: "user",
    parentId: parent?.id || null, order: parent ? childrenOf(parent.id, activeNodes(), activeEdges()).length : rootNodes(activeNodes(), activeEdges()).length,
    collapsed: false, bindings: {}, layouts: { mindmap: { x: center.x, y: center.y, width: 220, height: 58 }, snapshot: { x: center.x, y: center.y, width: 220, height: 58 } },
    evidence: [], confidence: 1, source: "user", userEdited: true
  };
  mutate(parent ? "新增下级节点" : "新增根节点", () => {
    manifest.nodes.push(node);
    if (parent) manifest.edges.push({ id: uniqueId("edge"), canvasId, source: parent.id, target: id, type: "hierarchy", label: "", anchors: { source: null, target: null }, controlOffsets: { source: { x: 0, y: 0 }, target: { x: 0, y: 0 } }, sourceKind: "user" });
    relayout();
    state.selectedNodes = new Set([id]);
    state.selectedEdgeId = null;
  });
  requestAnimationFrame(() => beginInlineRename(node, nodesLayer.querySelector(`[data-node-id="${cssEscape(id)}"] [data-node-title]`)));
}

function addSibling(before = false) {
  const current = selectedNode();
  if (!current) return addNode();
  const parent = activeNodes().find(node => node.id === current.parentId) || null;
  const point = centerOf(current.layouts[state.mode]);
  addNode(point, !parent);
  const added = selectedNode();
  if (!added || !parent) return;
  const edge = activeEdges().find(item => item.type === "hierarchy" && item.target === added.id);
  if (edge) edge.source = parent.id;
  added.parentId = parent.id;
  added.order = current.order + (before ? -.5 : .5);
  renumberSiblings(activeNodes()); relayout(); renderAll(); saveSoon();
}

function beginInlineRename(node, titleElement) {
  if (!editMode || !titleElement) return;
  const nodeId = node.id;
  const input = document.createElement("input");
  input.className = "pc-inline-name";
  input.value = node.title;
  titleElement.replaceWith(input);
  input.focus(); input.select();
  const finish = accept => {
    if (!input.isConnected) return;
    const nextTitle = input.value.trim();
    if (accept && nextTitle && nextTitle !== node.title) mutate("修改节点名称", () => {
      const current = activeNodes().find(item => item.id === nodeId);
      if (!current) return;
      current.title = nextTitle;
      current.userEdited = true;
      relayout();
    });
    else renderAll();
  };
  input.addEventListener("keydown", event => { if (event.key === "Enter") finish(true); if (event.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true), { once: true });
}

function beginRelationship() {
  if (!editMode) return;
  const ids = [...state.selectedNodes];
  if (ids.length === 2) return createRelationship(ids[0], ids[1]);
  state.connect = { sourceId: ids.length === 1 ? ids[0] : null };
  state.selectedEdgeId = null;
  showToast(ids.length === 1 ? "请选择联系的结束节点" : "请选择联系的开始节点");
  renderAll();
}

function createRelationship(sourceId, targetId) {
  if (activeEdges().some(edge => edge.type === "cross" && edge.source === sourceId && edge.target === targetId)) { state.connect = null; showToast("这两个节点已有联系"); return renderAll(); }
  const nodes = new Map(activeNodes().map(node => [node.id, node]));
  const anchors = closestAnchors(nodes.get(sourceId).layouts[state.mode], nodes.get(targetId).layouts[state.mode]);
  mutate("新增联系", () => {
    const edge = { id: uniqueId("relation"), canvasId: activeCanvasId(), source: sourceId, target: targetId, type: "cross", label: "", anchors, controlOffsets: { source: { x: 0, y: 0 }, target: { x: 0, y: 0 } }, sourceKind: "user" };
    manifest.edges.push(edge);
    state.connect = null;
    state.selectedNodes.clear();
    state.selectedEdgeId = edge.id;
  });
}

function toggleCollapse(id) {
  if (!editMode) {
    const node = activeNodes().find(item => item.id === id);
    if (node) node.collapsed = !node.collapsed;
    persistCollapseState();
    relayout(); renderAll(); return;
  }
  mutate("展开或收起下级", () => {
    const node = activeNodes().find(item => item.id === id);
    if (node) node.collapsed = !node.collapsed;
    relayout();
  });
}

function deleteSelection() {
  if (state.selectedEdgeId) return mutate("删除联系", () => {
    manifest.edges = manifest.edges.filter(edge => edge.id !== state.selectedEdgeId);
    state.selectedEdgeId = null;
  });
  if (!state.selectedNodes.size) return;
  const nodes = activeNodes();
  const edges = activeEdges();
  const removed = new Set();
  for (const id of state.selectedNodes) subtreeIds(id, nodes, edges).forEach(childId => removed.add(childId));
  mutate("删除节点及其下级", () => {
    manifest.viewState.deletedNodeIds = [...new Set([...(manifest.viewState.deletedNodeIds || []), ...removed])];
    manifest.nodes = manifest.nodes.filter(node => !removed.has(node.id));
    manifest.edges = manifest.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target));
    for (const key of Object.keys(manifest.snapshots || {})) if (removed.has(key.split("::")[0])) delete manifest.snapshots[key];
    state.selectedNodes.clear(); state.selectedEdgeId = null; relayout();
  });
}

function reorderSelected(direction) {
  const node = selectedNode();
  if (!node) return;
  mutate("调整同级顺序", () => { reorderNode(node.id, direction, activeNodes(), activeEdges()); relayout(); });
}

function outdentSelected() {
  const node = selectedNode();
  const parent = activeNodes().find(item => item.id === node?.parentId);
  if (!node || !parent) return;
  const grandParentId = parent.parentId || null;
  mutate("节点提升一级", () => {
    manifest.edges = manifest.edges.filter(edge => !(edge.canvasId === activeCanvasId() && edge.type === "hierarchy" && edge.target === node.id));
    node.parentId = grandParentId;
    node.order = Number(parent.order || 0) + .5;
    if (grandParentId) manifest.edges.push({ id: uniqueId("edge"), canvasId: activeCanvasId(), source: grandParentId, target: node.id, type: "hierarchy", label: "", anchors: { source: null, target: null }, controlOffsets: { source: { x: 0, y: 0 }, target: { x: 0, y: 0 } }, sourceKind: "user" });
    renumberSiblings(activeNodes());
    relayout(activeCanvasId(), grandParentId ? [] : [node.id]);
  });
}

function duplicateSelectedSubtree() {
  const source = selectedNode();
  if (!source) return;
  const canvasId = activeCanvasId();
  const ids = subtreeIds(source.id, activeNodes(), activeEdges());
  const idMap = new Map(ids.map(id => [id, uniqueId("node")]));
  mutate("复制节点树", () => {
    const clones = ids.map(id => {
      const original = activeNodes().find(node => node.id === id);
      const clone = deepClone(original);
      clone.id = idMap.get(id);
      clone.title = id === source.id ? `${original.title} 副本` : original.title;
      clone.parentId = id === source.id ? source.parentId : idMap.get(original.parentId);
      clone.order = id === source.id ? source.order + .5 : original.order;
      clone.userEdited = true;
      if (!clone.parentId) {
        for (const mode of ["mindmap", "snapshot"]) clone.layouts[mode].y += 110;
      }
      return clone;
    });
    manifest.nodes.push(...clones);
    const hierarchy = activeEdges().filter(edge => edge.type === "hierarchy" && ids.includes(edge.source) && ids.includes(edge.target)).map(edge => ({ ...deepClone(edge), id: uniqueId("edge"), source: idMap.get(edge.source), target: idMap.get(edge.target), canvasId }));
    manifest.edges.push(...hierarchy);
    if (source.parentId) manifest.edges.push({ id: uniqueId("edge"), canvasId, source: source.parentId, target: idMap.get(source.id), type: "hierarchy", label: "", anchors: { source: null, target: null }, controlOffsets: { source: { x: 0, y: 0 }, target: { x: 0, y: 0 } }, sourceKind: "user" });
    renumberSiblings(activeNodes()); relayout(); state.selectedNodes = new Set([idMap.get(source.id)]);
  });
}

function selectSpatialNeighbor(direction) {
  const current = selectedNode();
  if (!current) return;
  const origin = centerOf(current.layouts[state.mode]);
  const candidates = visibleNodes(activeNodes(), activeEdges()).filter(node => node.id !== current.id).map(node => {
    const point = centerOf(node.layouts[state.mode]);
    const dx = point.x - origin.x; const dy = point.y - origin.y;
    const valid = direction === "ArrowLeft" ? dx < 0 : direction === "ArrowRight" ? dx > 0 : direction === "ArrowUp" ? dy < 0 : dy > 0;
    const primary = direction === "ArrowLeft" || direction === "ArrowRight" ? Math.abs(dx) : Math.abs(dy);
    const secondary = direction === "ArrowLeft" || direction === "ArrowRight" ? Math.abs(dy) : Math.abs(dx);
    return valid ? { node, score: primary + secondary * 1.7 } : null;
  }).filter(Boolean).sort((a, b) => a.score - b.score);
  if (!candidates[0]) return;
  state.selectedNodes = new Set([candidates[0].node.id]); state.selectedEdgeId = null; state.inspectorOpen = true; renderAll();
}

function beginNodeDrag(event, nodeId) {
  const nodes = activeNodes();
  const edges = activeEdges();
  const node = nodes.find(item => item.id === nodeId);
  if (!node) return;
  if (!state.selectedNodes.has(nodeId)) {
    state.selectedNodes = new Set([nodeId]); state.selectedEdgeId = null;
    updateToolbar();
    if (!el("[data-inspector]").hidden) renderInspector();
    syncSelectionClasses(); refreshIcons(root);
  }
  const selected = state.selectedNodes.has(nodeId) && state.selectedNodes.size > 1 ? [...state.selectedNodes] : [nodeId];
  const rootIds = canonicalSelectionRoots(selected, nodes);
  const ids = new Set(rootIds.flatMap(id => subtreeIds(id, nodes, edges)));
  const originalModes = Object.fromEntries(rootIds.map(id => {
    const item = nodes.find(candidate => candidate.id === id);
    return [id, deepClone(item.layouts)];
  }));
  state.drag = {
    nodeId, rootIds, ids, start: clientToWorld(event.clientX, event.clientY), last: clientToWorld(event.clientX, event.clientY),
    before: deepClone(manifest), originalModes, original: Object.fromEntries([...ids].map(id => { const item = nodes.find(candidate => candidate.id === id); return [id, deepClone(item.layouts[state.mode])]; })),
    moved: false, tempDelta: { x: 0, y: 0 }, hint: null
  };
  viewport.classList.add("is-node-dragging");
  event.preventDefault();
}

function updateNodeDrag(event) {
  const drag = state.drag;
  const point = clientToWorld(event.clientX, event.clientY);
  const dx = point.x - drag.start.x;
  const dy = point.y - drag.start.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) stopInlineFrame();
  drag.moved = true; drag.last = point;
  drag.tempDelta = { x: dx, y: dy };
  drag.hint = findDropHint(event.clientX, event.clientY, drag.ids, point);
  renderGraph(); renderMinimap();
}

function finishNodeDrag(event) {
  const drag = state.drag;
  state.drag = null;
  viewport.classList.remove("is-node-dragging");
  if (!drag.moved) return;
  const nodes = activeNodes();
  const hint = drag.hint;
  manifest.edges = manifest.edges.filter(edge => !(edge.canvasId === activeCanvasId() && edge.type === "hierarchy" && drag.rootIds.includes(edge.target)));
  if (hint?.parentId) {
    drag.rootIds.forEach((id, index) => {
      const node = nodes.find(item => item.id === id);
      node.parentId = hint.parentId;
      node.order = Number(hint.order || 0) + index / 100;
      manifest.edges.push({ id: uniqueId("edge"), canvasId: activeCanvasId(), source: hint.parentId, target: id, type: "hierarchy", label: "", anchors: { source: null, target: null }, controlOffsets: { source: { x: 0, y: 0 }, target: { x: 0, y: 0 } }, sourceKind: "user" });
    });
  } else {
    const rootOrder = rootNodes(nodes, activeEdges()).length;
    drag.rootIds.forEach((id, index) => {
      const node = nodes.find(item => item.id === id);
      node.parentId = null;
      node.order = rootOrder + index;
      for (const mode of ["mindmap", "snapshot"]) {
        const original = drag.originalModes[id][mode];
        node.layouts[mode].x = original.x + drag.tempDelta.x;
        node.layouts[mode].y = original.y + drag.tempDelta.y;
      }
    });
  }
  renumberSiblings(nodes);
  relayout(activeCanvasId(), drag.rootIds.filter(id => !nodes.find(item => item.id === id)?.parentId));
  state.suppressNodeClick = true;
  setTimeout(() => { state.suppressNodeClick = false; }, 0);
  recordHistory(drag.before, hint?.parentId ? "调整节点归属或顺序" : "移动节点树");
  renderAll();
}

function canonicalSelectionRoots(selectedIds, nodes) {
  const selected = new Set(selectedIds);
  return selectedIds.filter(id => {
    let parentId = nodes.find(node => node.id === id)?.parentId;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = nodes.find(node => node.id === parentId)?.parentId;
    }
    return true;
  }).sort((left, right) => Number(nodes.find(node => node.id === left)?.order || 0) - Number(nodes.find(node => node.id === right)?.order || 0));
}

function findDropHint(clientX, clientY, draggedIds, worldPoint) {
  const gapHint = findHierarchyGapHint(worldPoint, draggedIds);
  if (gapHint) return gapHint;
  const candidateElement = document.elementsFromPoint(clientX, clientY).find(item => item.matches?.("[data-node-id]") && !draggedIds.has(item.dataset.nodeId));
  const candidate = activeNodes()
    .filter(node => !draggedIds.has(node.id))
    .filter(node => {
      const layout = node.layouts[state.mode];
      return worldPoint.x >= layout.x && worldPoint.x <= layout.x + layout.width && worldPoint.y >= layout.y && worldPoint.y <= layout.y + layout.height;
    })
    .sort((left, right) => distanceToCenter(left.layouts[state.mode], worldPoint) - distanceToCenter(right.layouts[state.mode], worldPoint))[0]
    || activeNodes().find(node => node.id === candidateElement?.dataset.nodeId);
  if (!candidate) return { parentId: null, order: 0, marker: null };
  const layout = candidate.layouts[state.mode];
  const relative = (worldPoint.y - layout.y) / layout.height;
  if (candidate.parentId && (relative < .28 || relative > .72)) {
    const siblings = activeNodes().filter(node => node.parentId === candidate.parentId).sort((a, b) => a.order - b.order);
    const index = siblings.findIndex(node => node.id === candidate.id) + (relative > .72 ? 1 : 0);
    return { parentId: candidate.parentId, order: index - .25, targetId: null, marker: { x: layout.x, y: relative > .72 ? layout.y + layout.height + 8 : layout.y - 8, width: layout.width } };
  }
  return { parentId: candidate.id, order: childrenOf(candidate.id, activeNodes(), activeEdges()).length, targetId: candidate.id, marker: null };
}

function findHierarchyGapHint(point, draggedIds) {
  const nodes = activeNodes();
  const edges = activeEdges();
  const visible = new Set(visibleNodes(nodes, edges).map(node => node.id));
  const hints = [];
  for (const parent of nodes.filter(node => visible.has(node.id) && !draggedIds.has(node.id))) {
    const siblings = childrenOf(parent.id, nodes, edges).filter(node => visible.has(node.id) && !draggedIds.has(node.id));
    if (!siblings.length) continue;
    const branches = siblings.map(node => ({ node, bounds: subtreeBounds(node.id, nodes, edges, state.mode, visible, draggedIds) }));
    const left = Math.min(...branches.map(item => item.bounds.x)) - 90;
    const right = Math.max(...branches.map(item => item.bounds.x + item.bounds.width)) + 90;
    if (point.x < left || point.x > right) continue;
    for (let index = 0; index <= branches.length; index += 1) {
      const previous = branches[index - 1]?.bounds;
      const next = branches[index]?.bounds;
      const top = previous ? previous.y + previous.height : next.y - 100;
      const bottom = next ? next.y : previous.y + previous.height + 100;
      if (point.y < top || point.y > bottom) continue;
      const markerY = previous && next ? (top + bottom) / 2 : previous ? previous.y + previous.height + 18 : next.y - 18;
      const reference = branches[Math.min(index, branches.length - 1)].node.layouts[state.mode];
      hints.push({
        parentId: parent.id,
        order: index - .5,
        targetId: null,
        marker: { x: reference.x, y: markerY, width: reference.width },
        score: Math.abs(point.x - (reference.x + reference.width / 2)) + Math.abs(point.y - markerY) * .15
      });
    }
  }
  hints.sort((left, right) => left.score - right.score);
  if (!hints[0]) return null;
  const { score, ...hint } = hints[0];
  return hint;
}

function subtreeBounds(rootId, nodes, edges, mode, visibleIds, excludedIds = new Set()) {
  const branch = subtreeIds(rootId, nodes, edges)
    .filter(id => visibleIds.has(id) && !excludedIds.has(id))
    .map(id => nodes.find(node => node.id === id))
    .filter(Boolean);
  const layouts = branch.map(node => node.layouts[mode]);
  const minX = Math.min(...layouts.map(layout => layout.x));
  const minY = Math.min(...layouts.map(layout => layout.y));
  const maxX = Math.max(...layouts.map(layout => layout.x + layout.width));
  const maxY = Math.max(...layouts.map(layout => layout.y + layout.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function beginEdgeHandleDrag(event, handle) {
  const edge = activeEdges().find(item => item.id === handle.dataset.edgeId && item.type === "cross");
  if (!edge) return;
  state.edgeDrag = { edgeId: edge.id, endpoint: handle.dataset.edgeHandle || null, control: handle.dataset.edgeControl || null, before: deepClone(manifest) };
  event.preventDefault(); event.stopPropagation();
}

function updateEdgeHandleDrag(event) {
  const drag = state.edgeDrag;
  const edge = activeEdges().find(item => item.id === drag.edgeId);
  if (!edge) return;
  const point = clientToWorld(event.clientX, event.clientY);
  if (drag.endpoint) {
    const targetElement = document.elementsFromPoint(event.clientX, event.clientY).find(item => item.matches?.("[data-node-id]"));
    const key = drag.endpoint === "source" ? "source" : "target";
    const currentNode = activeNodes().find(node => node.id === edge[key]);
    if (targetElement && targetElement.dataset.nodeId !== edge[key === "source" ? "target" : "source"]) edge[key] = targetElement.dataset.nodeId;
    const node = activeNodes().find(item => item.id === edge[key]) || currentNode;
    edge.anchors[key] = projectToBoundary(node.layouts[state.mode], point);
  } else if (drag.control) {
    const nodes = new Map(activeNodes().map(node => [node.id, node]));
    const geometry = relationshipGeometry({ ...edge, controlOffsets: { source: { x: 0, y: 0 }, target: { x: 0, y: 0 } } }, nodes.get(edge.source).layouts[state.mode], nodes.get(edge.target).layouts[state.mode]);
    const base = drag.control === "source" ? geometry.control1 : geometry.control2;
    edge.controlOffsets[drag.control] = { x: point.x - base.x, y: point.y - base.y };
  }
  renderGraph();
}

function finishEdgeHandleDrag() {
  const drag = state.edgeDrag;
  state.edgeDrag = null;
  recordHistory(drag.before, "调整联系线");
  renderAll();
}

function updateSelectionBox(event) {
  const box = state.box;
  box.x = event.clientX; box.y = event.clientY;
  box.moved ||= Math.hypot(box.x - box.startX, box.y - box.startY) > 4;
  if (!box.moved) return;
  const rect = viewport.getBoundingClientRect();
  const left = Math.max(rect.left, Math.min(box.startX, box.x));
  const top = Math.max(rect.top, Math.min(box.startY, box.y));
  const right = Math.min(rect.right, Math.max(box.startX, box.x));
  const bottom = Math.min(rect.bottom, Math.max(box.startY, box.y));
  const boxElement = el("[data-selection-box]");
  boxElement.hidden = false;
  boxElement.style.cssText = `left:${left - rect.left}px;top:${top - rect.top}px;width:${Math.max(0, right - left)}px;height:${Math.max(0, bottom - top)}px`;
}

function finishSelectionBox(event) {
  const box = state.box; state.box = null;
  el("[data-selection-box]").hidden = true;
  if (!box.moved) {
    state.selectedNodes.clear(); state.selectedEdgeId = null; state.connect = null; renderAll(); return;
  }
  const selection = { left: Math.min(box.startX, box.x), top: Math.min(box.startY, box.y), right: Math.max(box.startX, box.x), bottom: Math.max(box.startY, box.y) };
  state.selectedNodes.clear();
  nodesLayer.querySelectorAll("[data-node-id]").forEach(node => {
    const rect = node.getBoundingClientRect();
    if (rect.right >= selection.left && rect.left <= selection.right && rect.bottom >= selection.top && rect.top <= selection.bottom) state.selectedNodes.add(node.dataset.nodeId);
  });
  state.selectedEdgeId = null; renderAll();
}

function openPrototype(node) {
  const binding = bindingFor(node);
  if (!binding) return showToast("该节点尚未关联原型页面");
  state.overlayNodeId = node.id;
  const overlay = el("[data-prototype-overlay]");
  overlay.hidden = false;
  el("[data-prototype-title]").textContent = node.title;
  el("[data-locate-footer]").hidden = true;
  el("[data-locate-hint]").hidden = true;
  if (!promoteInlineFrameToOverlay(node, binding)) resetFrame({ kind: "overlay", nodeId: node.id, binding, locating: false });
}

function promoteInlineFrameToOverlay(node, binding) {
  if (
    state.frameTarget?.kind !== "inline"
    || state.frameTarget.nodeId !== node.id
    || !state.frameWrap
    || !state.frame
    || !state.frameReady
    || state.frameError
    || state.frameWrap.classList.contains("is-error")
  ) return false;
  clearLiveMedia();
  state.frameTarget = { kind: "overlay", nodeId: node.id, binding, locating: false };
  state.framePositioned = true;
  state.frameWrap.className = "pc-live-frame is-overlay";
  state.frameWrap.removeAttribute("style");
  state.frame.removeAttribute("style");
  el("[data-prototype-stage]").append(state.frameWrap);
  // iframe 被移动到新的父容器时浏览器会重新加载它，因此必须重置导航状态并重新回放一次关联，
  // 否则进入原型后会停留在原型默认页面（表现为“双击后打开的页面不对”）。
  state.frameReady = false;
  state.frameNavigationStarted = false;
  state.frameRequestId = uniqueId("frame");
  state.frameError = null;
  state.frameWrap.classList.remove("is-ready", "is-error");
  clearTimeout(state.frameFallbackTimer);
  state.frameFallbackTimer = setTimeout(sendFrameNavigation, 900);
  return true;
}

function startLocate() {
  const node = selectedNode();
  if (!node || !editMode) return;
  state.overlayNodeId = node.id;
  state.locateResult = null;
  state.locateForce = false;
  const overlay = el("[data-prototype-overlay]");
  overlay.hidden = false;
  el("[data-prototype-title]").textContent = `定位：${node.title}`;
  el("[data-locate-footer]").hidden = false;
  el("[data-locate-hint]").hidden = false;
  el("[data-locate-hint]").textContent = "正在准备定位...";
  el('[data-action="locate-confirm"]').disabled = true;
  resetFrame({ kind: "overlay", nodeId: node.id, binding: bindingFor(node) || { actions: [], target: { selector: null } }, locating: true });
}

async function confirmLocate() {
  const node = activeNodes().find(item => item.id === state.overlayNodeId);
  if (!node) return;
  const previous = bindingFor(node) || { actions: [], target: { selector: null }, evidence: [], confidence: 1 };
  const located = state.locateResult || {};
  const target = located.userInteracted && located.target?.selector ? located.target : previous.target;
  const baseActions = Array.isArray(located.baseActions)
    ? located.baseActions
    : located.baseReplaySucceeded ? previous.actions || [] : [];
  const actions = compactReplayActions([...(baseActions || []), ...(located.actions || [])]);
  if (!target?.selector && !target?.selectors?.length && !target?.locator && !actions.length) {
    showToast("请先在原型中点击并定位目标页面");
    return;
  }
  const profileKey = state.profileId || "global";
  const previewProfileId = state.profileId || "all";
  // 定位结果和原关联完全一致时先说明再决定，避免“点了确定却什么都没变”的错觉。
  if (!state.locateForce && bindingSignature({ actions, target }) === bindingSignature(previous)) {
    showDialog("这次定位没有产生变化",
      `<p>你在原型里的操作和原来的关联完全一样，保存后画布和预览图都不会有变化。</p><footer><button data-dialog-relocate>重新定位</button><button class="pc-primary" data-dialog-save>仍然保存</button></footer>`,
      dialog => {
        dialog.querySelector("[data-dialog-relocate]").onclick = () => { closeDialog(); startLocate(); };
        dialog.querySelector("[data-dialog-save]").onclick = () => { closeDialog(); state.locateForce = true; confirmLocate(); };
      });
    return;
  }
  state.locateForce = false;
  const candidateBinding = {
    ...previous,
    actions,
    target,
    scope: located.fingerprint?.scope || previous.scope || null,
    fingerprint: located.fingerprint || previous.fingerprint || null,
    confidence: 1,
    evidence: [...new Set([...(previous.evidence || []), "用户在本地编辑模式中定位并验证"])]
  };
  const confirm = el('[data-action="locate-confirm"]');
  if (confirm) confirm.disabled = true;
  const hint = el("[data-locate-hint]");
  if (hint) hint.textContent = "正在从初始状态验证路径并生成预览...";
  showOperationMask("正在确认页面关联", "正在重新打开原型、验证刚才的操作并生成预览。请稍候，不要刷新页面。");
  const previousSnapshotHash = manifest.snapshots[snapshotKey(node.id, previewProfileId)]?.hash || null;
  state.pendingBindings.set(node.id, candidateBinding);
  state.pendingSnapshots.set(node.id, {
    sourceHash: manifest.prototype.sourceHash,
    capturedAt: new Date().toISOString(),
    status: "rendering"
  });
  renderAll();
  try {
    const result = await captureBindingSnapshot(node.id, previewProfileId, candidateBinding);
    state.pendingBindings.delete(node.id);
    state.pendingSnapshots.delete(node.id);
    mutate("关联原型页面", () => {
      node.bindings ||= {};
      node.bindings[profileKey] = candidateBinding;
      manifest.snapshots[result.key] = result.snapshot;
      manifest.snapshotAssets[result.snapshot.assetHash] = result.asset;
      sizeNodes([node]);
      relayout();
    });
    updateOperationMask("验证完成，正在保存", "页面路径和预览已生成，正在保存到当前画布。");
    await saveSession();
    hideOperationMask();
    closePrototype();
    const samePreview = Boolean(previousSnapshotHash) && previousSnapshotHash === result.snapshot.hash;
    showToast(samePreview ? "页面关联已更新，但预览图和上一版相同" : "页面关联和预览已更新");
  } catch (error) {
    const message = friendlyErrorMessage(error, "页面关联没有完成。请重新打开目标页面后再试。");
    hideOperationMask();
    state.pendingBindings.delete(node.id);
    state.pendingSnapshots.delete(node.id);
    renderAll();
    if (confirm) confirm.disabled = false;
    if (hint) hint.textContent = "关联没有保存，请按提示处理后重试";
    showErrorDialog("页面关联没有完成", message);
  }
}

async function captureBindingSnapshot(nodeId, profileId, binding) {
  if (!editMode || !config.captureUrl) throw new Error("当前模式不能验证页面关联");
  const response = await fetch(config.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-prototype-canvas-token": config.apiToken },
    body: JSON.stringify({ nodeId, profileId: profileId === "all" ? null : profileId, binding, quality: 68, timeout: 9000 })
  });
  const result = await readApiResponse(response, "页面关联验证没有完成。");
  if (result.snapshot?.status !== "ready" || !result.asset?.dataUri) throw new Error("预览未生成完成");
  return result;
}

function stripActionHints(action) {
  const clean = { ...action };
  delete clean.unchanged;
  delete clean.noEffect;
  return clean;
}

// 只丢弃“点击后界面没有任何变化”的操作，不按选择器去重：
// 向导的“下一步”这类同一个按钮重复点击会推进业务状态，合并等于丢步骤。
function compactReplayActions(actions) {
  const recorded = actions.filter(item => item?.type);
  const kept = recorded.filter(action => action.unchanged !== true).map(stripActionHints);
  return kept.length ? kept : recorded.slice(-1).map(stripActionHints);
}

function bindingSignature(binding) {
  return JSON.stringify([
    (binding?.actions || []).map(action => [action?.type, action?.selector, action?.value, action?.locator?.text]),
    binding?.target?.selector || null
  ]);
}

function closePrototype() {
  hideOperationMask();
  el("[data-prototype-overlay]").hidden = true;
  state.overlayNodeId = null; state.locateResult = null;
  stopInlineFrame(true);
  updateLiveSoon();
}

function updateLivePreview() {
  if (state.mode !== "snapshot" || !el("[data-prototype-overlay]").hidden || state.drag) return stopInlineFrame();
  const viewportRect = viewport.getBoundingClientRect();
  const center = { x: viewportRect.left + viewportRect.width / 2, y: viewportRect.top + viewportRect.height / 2 };
  const candidates = [...nodesLayer.querySelectorAll("[data-node-id]")].filter(element => {
    const node = activeNodes().find(item => item.id === element.dataset.nodeId);
    const rect = element.getBoundingClientRect();
    return bindingFor(node) && rect.width >= INLINE_PREVIEW_PRELOAD_WIDTH && rect.right > viewportRect.left && rect.left < viewportRect.right && rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
  }).sort((left, right) => rectDistance(left.getBoundingClientRect(), center) - rectDistance(right.getBoundingClientRect(), center));
  const candidate = candidates[0];
  if (state.frameTarget?.kind === "inline") {
    const currentElement = nodesLayer.querySelector(`[data-node-id="${cssEscape(state.frameTarget.nodeId)}"]`);
    const currentRect = currentElement?.getBoundingClientRect();
    if (currentRect && currentRect.width >= INLINE_PREVIEW_EXIT_WIDTH && visibleRectRatio(currentRect, viewportRect) >= .16) {
      const currentDistance = rectDistance(currentRect, center);
      const candidateDistance = candidate ? rectDistance(candidate.getBoundingClientRect(), center) : Infinity;
      if (!candidate || candidate.dataset.nodeId === state.frameTarget.nodeId || currentDistance <= candidateDistance * 1.2) {
        attachLiveFrameIfPossible();
        return syncInlineFrameVisibility();
      }
    }
  }
  if (!candidate) return stopInlineFrame();
  const nodeId = candidate.dataset.nodeId;
  if (state.frameTarget?.kind === "inline" && state.frameTarget.nodeId === nodeId && state.frameWrap) return attachLiveFrameIfPossible();
  const node = activeNodes().find(item => item.id === nodeId);
  const snapshot = snapshotFor(node);
  resetFrame({ kind: "inline", nodeId, binding: bindingFor(node), locating: false, hasSnapshot: Boolean(snapshot?.assetHash || snapshot?.dataUri) });
}

function resetFrame(target) {
  clearLiveMedia();
  state.frameWrap?.remove();
  state.frameTarget = target;
  state.frameReady = false;
  state.framePositioned = false;
  state.frameError = null;
  clearTimeout(state.frameNavigationTimer);
  clearTimeout(state.frameFallbackTimer);
  state.frameNavigationStarted = false;
  state.frameRequestId = uniqueId("frame");
  state.frameWrap = document.createElement("div");
  state.frameWrap.className = `pc-live-frame ${target.kind === "overlay" ? "is-overlay" : "is-inline"} ${target.hasSnapshot ? "has-snapshot" : ""}`;
  if (target.nodeId) state.frameWrap.dataset.nodeId = target.nodeId;
  state.frameWrap.innerHTML = `<div class="pc-frame-loading"><span></span><span></span><span></span></div><iframe title="原型实时预览" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"></iframe>`;
  state.frame = state.frameWrap.querySelector("iframe");
  state.frame.addEventListener("load", () => {
    clearTimeout(state.frameFallbackTimer);
    state.frameFallbackTimer = setTimeout(sendFrameNavigation, 900);
  }, { once: true });
  // 导出 HTML 通过 file:// 打开时，blob:null 会导致桥接脚本无法稳定完成页面回放。
  state.frame.srcdoc = sourceHtml;
  if (target.kind === "overlay") el("[data-prototype-stage]").append(state.frameWrap);
  else attachLiveFrameIfPossible();
}

function attachLiveFrameIfPossible() {
  if (!state.frameWrap || state.frameTarget?.kind !== "inline") return;
  const slot = nodesLayer.querySelector(`[data-live-slot="${cssEscape(state.frameTarget.nodeId)}"]`);
  const node = activeNodes().find(item => item.id === state.frameTarget.nodeId);
  if (slot && node) {
    clearLiveMedia(slot);
    if (state.frameWrap.parentElement !== liveLayer) liveLayer.append(state.frameWrap);
    const slotRect = slot.getBoundingClientRect();
    const worldRect = world.getBoundingClientRect();
    const scale = Math.max(.01, currentView().scale);
    state.frameWrap.style.left = `${(slotRect.left - worldRect.left) / scale}px`;
    state.frameWrap.style.top = `${(slotRect.top - worldRect.top) / scale}px`;
    state.frameWrap.style.width = `${Math.max(1, slotRect.width / scale)}px`;
    state.frameWrap.style.height = `${Math.max(1, slotRect.height / scale)}px`;
    resizeInlineFrame(state.frameWrap);
    state.framePositioned = true;
    state.frameWrap.classList.add("is-positioned");
    syncInlineFrameVisibility();
  }
}

function syncInlineFrameVisibility() {
  if (state.frameTarget?.kind !== "inline") return;
  const slot = nodesLayer.querySelector(`[data-live-slot="${cssEscape(state.frameTarget.nodeId)}"]`);
  const visible = state.frameReady && state.framePositioned && (slot?.getBoundingClientRect().width || 0) >= INLINE_PREVIEW_ENTER_WIDTH;
  slot?.classList.toggle("is-live", visible);
  state.frameWrap?.classList.toggle("is-visible", visible);
}

function resizeInlineFrame(slot) {
  if (!state.frame || state.frameTarget?.kind !== "inline") return;
  const sourceWidth = Math.max(320, Number(manifest.prototype.viewport?.width || 1440));
  const sourceHeight = Math.max(568, Number(manifest.prototype.viewport?.height || 900));
  const width = slot.clientWidth;
  const scale = width / sourceWidth;
  state.frame.style.width = `${sourceWidth}px`;
  state.frame.style.height = `${sourceHeight}px`;
  state.frame.style.left = "0";
  state.frame.style.top = "0";
  state.frame.style.transform = `scale(${scale})`;
}

function beginMinimapDrag(event) {
  if (event.target.closest("button")) return;
  const content = el("[data-minimap-content]");
  if (!content.dataset.bounds) return;
  const marker = event.target.closest("[data-mini-viewport]");
  const markerRect = marker?.getBoundingClientRect();
  const dragOffset = markerRect ? { x: event.clientX - markerRect.left - markerRect.width / 2, y: event.clientY - markerRect.top - markerRect.height / 2 } : { x: 0, y: 0 };
  const pointerId = event.pointerId;
  try { content.setPointerCapture?.(pointerId); } catch {}
  state.miniDrag = true;
  const move = moveEvent => {
    if (!state.miniDrag) return;
    const rect = content.getBoundingClientRect();
    const bounds = JSON.parse(content.dataset.bounds);
    const worldPoint = { x: bounds.x + (moveEvent.clientX - dragOffset.x - rect.left) / bounds.factor, y: bounds.y + (moveEvent.clientY - dragOffset.y - rect.top) / bounds.factor };
    const viewportRect = viewport.getBoundingClientRect();
    const view = currentView();
    view.x = viewportRect.width / 2 - worldPoint.x * view.scale;
    view.y = viewportRect.height / 2 - worldPoint.y * view.scale;
    applyView(); syncMinimapViewport(); updateLiveSoon();
  };
  const up = () => {
    state.miniDrag = false;
    document.removeEventListener("pointermove", move);
    try { if (content.hasPointerCapture?.(pointerId)) content.releasePointerCapture(pointerId); } catch {}
    saveSoon();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up, { once: true });
  move(event);
  event.preventDefault(); event.stopPropagation();
}

function stopInlineFrame(force = false) {
  if (!state.frameTarget) { clearLiveMedia(); return; }
  if (!force && state.frameTarget.kind !== "inline") return;
  clearTimeout(state.frameNavigationTimer);
  clearTimeout(state.frameFallbackTimer);
  clearLiveMedia();
  state.frameWrap?.remove();
  state.frame = null; state.frameWrap = null; state.frameTarget = null; state.frameReady = false; state.framePositioned = false; state.frameNavigationTimer = null; state.frameNavigationStarted = false; state.frameFallbackTimer = null; state.frameError = null;
}

function clearLiveMedia(except = null) {
  nodesLayer.querySelectorAll(".pc-node-media.is-live").forEach(item => { if (item !== except) item.classList.remove("is-live"); });
}

function onFrameMessage(event) {
  const message = event.data;
  if (!message?.__prototypeCanvas || message.token !== config.bridgeToken || event.source !== state.frame?.contentWindow) return;
  if (message.type === "prototype:ready") {
    if (state.frameTarget?.locating) state.frame.contentWindow.postMessage({ __prototypeCanvas: true, token: config.bridgeToken, type: "canvas:start-locate", binding: state.frameTarget.binding }, "*");
    clearTimeout(state.frameFallbackTimer);
    sendFrameNavigation();
  }
  if (message.type === "prototype:render-stable" && message.requestId === state.frameRequestId) {
    clearTimeout(state.frameNavigationTimer);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      state.frameReady = true;
      state.frameWrap?.classList.add("is-ready");
      syncInlineFrameVisibility();
    }));
  }
  if (message.type === "prototype:render-error" && (!message.requestId || message.requestId === state.frameRequestId)) {
    clearTimeout(state.frameNavigationTimer);
    state.frameError = friendlyErrorMessage(message.error, "没有打开已关联的原型页面，请重新定位这个节点。");
    state.frameWrap?.classList.add("is-error");
    showToast(state.frameError);
  }
  if (message.type === "prototype:locate-update") {
    state.locateResult = message.result;
    const confirm = el('[data-action="locate-confirm"]');
    const hasTarget = Boolean(
      message.result?.userInteracted && (message.result?.target?.selector || message.result?.target?.selectors?.length || (message.result?.actions || []).length)
      || message.result?.baseReplaySucceeded && (message.result?.target?.selector || message.result?.target?.selectors?.length)
    );
    if (confirm) confirm.disabled = !hasTarget;
    const hint = el("[data-locate-hint]");
    if (hint) {
      const effective = (message.result?.actions || []).filter(action => action?.type && action.unchanged !== true).length;
      const label = message.result?.targetLabel || "";
      hint.textContent = hasTarget
        ? `已记录 ${effective} 步有效操作${label ? ` · 当前目标：${label}` : ""}`
        : "请在原型中操作并点击目标页面";
    }
  }
}

function sendFrameNavigation() {
  if (!state.frame?.contentWindow || !state.frameTarget || state.frameNavigationStarted) return;
  state.frameNavigationStarted = true;
  clearTimeout(state.frameFallbackTimer);
  state.frame.contentWindow.postMessage({
    __prototypeCanvas: true,
    token: config.bridgeToken,
    type: "canvas:navigate",
    requestId: state.frameRequestId,
    binding: state.frameTarget.binding,
    profile: activeProfile(),
    dimensions: manifest.dimensions || [],
    timeout: 3600
  }, "*");
  clearTimeout(state.frameNavigationTimer);
  const requestId = state.frameRequestId;
  state.frameNavigationTimer = setTimeout(() => {
    if (state.frameRequestId !== requestId || state.frameReady) return;
    state.frameError = "实时 HTML 预览定位超时";
    state.frameWrap?.classList.add("is-error");
    if (editMode) showToast(state.frameError);
  }, 6000);
}

function showShortcutDialog() {
  const rows = [
    ["鼠标滚轮", "纵向移动画布"], ["Shift + 鼠标滚轮", "横向移动画布"], ["Ctrl + 鼠标滚轮", "以鼠标位置缩放"],
    ["Space + 鼠标拖拽", "移动画布"], ["拖拽空白区域", "框选多个节点"], ["点击空白区域", "取消选择"],
    ["方向键", "选择相邻节点"], ["Ctrl + + / - / 0", "放大、缩小、恢复 100%"], ["Home", "居中显示导图"]
  ];
  if (editMode) rows.push(
    ["双击空白区域", "新增独立节点"], ["双击标题 / F2", "修改节点名称"], ["Tab", "新增下级"],
    ["Enter / Shift + Enter", "新增后一个 / 前一个同级"], ["Shift + Tab", "提升为上一级"], ["Alt + ↑ / ↓", "调整同级顺序"],
    ["Ctrl + D", "复制所选子树"], ["Ctrl + /", "展开或收起下级"], ["Ctrl + Shift + R", "建立联系"],
    ["Delete / Backspace", "删除所选节点子树或联系"], ["Ctrl + Z / Ctrl + Y", "撤销 / 重做"], ["Esc", "取消当前操作"]
  );
  showDialog("快捷键", `<div class="pc-shortcut-grid">${rows.map(([keys, action]) => `<div><kbd>${escapeHtml(keys)}</kbd><span>${escapeHtml(action)}</span></div>`).join("")}</div>`, dialog => dialog.classList.add("pc-shortcut-dialog"));
}

function showExportDialog() {
  const mindmapPreview = `<svg viewBox="0 0 220 86" aria-hidden="true"><path d="M45 43 C72 43 72 20 98 20 M45 43 C72 43 72 66 98 66 M133 20 H184 M133 66 H184" fill="none" stroke="#4b7bec" stroke-width="2"/><rect x="12" y="29" width="44" height="28" rx="5" fill="#1768e5"/><rect x="98" y="9" width="35" height="22" rx="4" fill="#fff" stroke="#79a9ef"/><rect x="98" y="55" width="35" height="22" rx="4" fill="#fff" stroke="#79a9ef"/><circle cx="184" cy="20" r="5" fill="#8eb5f6"/><circle cx="184" cy="66" r="5" fill="#8eb5f6"/></svg>`;
  const snapshotPreview = `<svg viewBox="0 0 220 86" aria-hidden="true"><path d="M54 43 H82 M138 43 H166" fill="none" stroke="#4b7bec" stroke-width="2"/><g fill="#fff" stroke="#79a9ef"><rect x="4" y="12" width="54" height="62" rx="5"/><rect x="82" y="7" width="56" height="72" rx="5"/><rect x="166" y="15" width="50" height="56" rx="5"/></g><g fill="#dbeafe"><rect x="10" y="29" width="42" height="38" rx="2"/><rect x="88" y="25" width="44" height="47" rx="2"/><rect x="172" y="31" width="38" height="33" rx="2"/></g><g fill="#1768e5"><rect x="10" y="18" width="22" height="6" rx="2"/><rect x="88" y="13" width="24" height="7" rx="2"/><rect x="172" y="21" width="20" height="6" rx="2"/></g></svg>`;
  showDialog("导出画布", `<p>两种导出都会包含当前用户类型画布中的全部可见节点和连线。</p><div class="pc-export-grid"><button class="pc-export-option" data-export-mode="mindmap">${mindmapPreview}<strong>导出思维导图 SVG</strong><span>节点与层级骨架，完整画布</span></button><button class="pc-export-option" data-export-mode="snapshot">${snapshotPreview}<strong>导出页面快照 SVG</strong><span>节点、原型快照与连线，完整画布</span></button></div>`, dialog => {
    dialog.classList.add("pc-export-dialog");
    dialog.querySelectorAll("[data-export-mode]").forEach(button => button.addEventListener("click", async () => {
      const exportMode = button.dataset.exportMode;
      button.disabled = true; button.textContent = "正在导出...";
      try {
        await exportCanvas({ manifest, nodes: visibleNodes(activeNodes(), activeEdges()), edges: activeEdges(), mode: exportMode, range: "full", viewport: null, format: "svg", profileId: state.profileId });
        closeDialog(); showToast("导出完成");
      } catch (error) { button.disabled = false; button.textContent = "导出失败，请重试"; showToast(friendlyErrorMessage(error, "画布导出没有完成，请稍后重试。")); }
    }));
  });
}

function bindAudienceEvents() {
  const overlay = el("[data-audience-overlay]");
  const audienceViewport = overlay.querySelector("[data-audience-viewport]");
  overlay.addEventListener("click", audienceClick);
  overlay.addEventListener("dblclick", audienceDoubleClick);
  audienceViewport.addEventListener("pointerdown", audiencePointerDown);
  audienceViewport.addEventListener("wheel", audienceWheel, { passive: false });
  overlay.querySelector("[data-audience-minimap-scroll]").addEventListener("wheel", onMinimapWheel, { passive: false });
}

function audienceClick(event) {
  const rich = event.target.closest("[data-audience-rich]")?.dataset.audienceRich;
  if (rich) { document.execCommand(rich); el("[data-audience-edit-description]")?.focus(); return; }
  if (event.target.closest("[data-audience-inspector-close]")) { state.audienceSelected.clear(); renderAudienceGraph(); return; }
  const action = event.target.closest("[data-audience-action]")?.dataset.audienceAction;
  if (action === "close") return closeAudience();
  if (action === "add") return addAudienceNode();
  if (action === "undo") return undo(true);
  if (action === "redo") return redo(true);
  if (action === "zoom-in") return audienceZoom(state.audienceView.scale * 1.16);
  if (action === "zoom-out") return audienceZoom(state.audienceView.scale / 1.16);
  const minimapAction = event.target.closest("[data-audience-minimap]")?.dataset.audienceMinimap;
  if (minimapAction) {
    state.audienceMinimapScale = clamp(state.audienceMinimapScale * (minimapAction === "in" ? 1.25 : .8), .5, 4);
    manifest.audience.minimap.scale = state.audienceMinimapScale;
    renderAudienceMinimap();
    saveSoon();
    return;
  }
  const profileId = event.target.closest("[data-switch-profile]")?.dataset.switchProfile;
  if (profileId) return switchProfile(profileId);
  const collapseId = event.target.closest("[data-audience-collapse]")?.dataset.audienceCollapse;
  if (collapseId) {
    if (editMode) return mutate("展开或收起用户类型", () => { const node = manifest.audience.nodes.find(item => item.id === collapseId); node.collapsed = !node.collapsed; }, true);
    const node = manifest.audience.nodes.find(item => item.id === collapseId); node.collapsed = !node.collapsed; return renderAudienceGraph();
  }
  const nodeElement = event.target.closest("[data-audience-node]");
  if (nodeElement && state.suppressAudienceClick) { state.suppressAudienceClick = false; return; }
  if (nodeElement && !event.target.closest("button")) {
    const id = nodeElement.dataset.audienceNode;
    if (event.ctrlKey || event.metaKey || event.shiftKey) state.audienceSelected.has(id) ? state.audienceSelected.delete(id) : state.audienceSelected.add(id);
    else { state.audienceSelected.clear(); state.audienceSelected.add(id); }
    syncAudienceSelection();
  }
}

function syncAudienceSelection() {
  const overlay = el("[data-audience-overlay]");
  overlay.querySelectorAll("[data-audience-node]").forEach(node => node.classList.toggle("is-selected", state.audienceSelected.has(node.dataset.audienceNode)));
  const addLabel = overlay.querySelector("[data-audience-add-label]");
  if (addLabel) addLabel.textContent = state.audienceSelected.size === 1 ? "新增下级" : "新增用户类型";
  renderAudienceInspector();
  ensureAudienceSelectionVisible();
  refreshIcons(overlay);
}

function ensureAudienceSelectionVisible() {
  const node = selectedAudienceNode();
  const overlay = el("[data-audience-overlay]");
  const audienceViewport = overlay.querySelector("[data-audience-viewport]");
  const worldEl = overlay.querySelector("[data-audience-world]");
  if (!node || !audienceViewport || !worldEl) return;
  const rect = audienceViewport.getBoundingClientRect();
  const margin = 28;
  const left = node.layout.x * state.audienceView.scale + state.audienceView.x;
  const top = node.layout.y * state.audienceView.scale + state.audienceView.y;
  const right = left + node.layout.width * state.audienceView.scale;
  const bottom = top + node.layout.height * state.audienceView.scale;
  if (left < margin) state.audienceView.x += margin - left;
  else if (right > rect.width - margin) state.audienceView.x -= right - (rect.width - margin);
  if (top < margin) state.audienceView.y += margin - top;
  else if (bottom > rect.height - margin) state.audienceView.y -= bottom - (rect.height - margin);
  clampAudienceView();
  worldEl.style.transform = `translate(${state.audienceView.x}px, ${state.audienceView.y}px) scale(${state.audienceView.scale})`;
  manifest.audience.view = state.audienceView;
  renderAudienceMinimap();
}

function audienceDoubleClick(event) {
  if (!editMode) return;
  const nodeElement = event.target.closest("[data-audience-node]");
  if (!nodeElement || event.target.closest("button")) return;
  const node = manifest.audience.nodes.find(item => item.id === nodeElement.dataset.audienceNode);
  beginAudienceRename(node, nodeElement);
}

function beginAudienceRename(node, nodeElement) {
  if (!node || !nodeElement) return;
  const title = nodeElement.querySelector("strong");
  const input = document.createElement("input"); input.className = "pc-inline-name"; input.value = node.title; title.replaceWith(input); input.focus(); input.select();
  const nodeId = node.id;
  const finish = accept => {
    if (!input.isConnected) return;
    const nextTitle = input.value.trim();
    const currentNode = manifest.audience.nodes.find(item => item.id === nodeId);
    if (accept && nextTitle && nextTitle !== currentNode?.title) mutate("修改用户类型名称", () => { const current = manifest.audience.nodes.find(item => item.id === nodeId); if (current) { current.title = nextTitle; syncAudienceIdentityName(current); } }, true);
    else renderAudienceGraph();
    requestAnimationFrame(() => el("[data-audience-overlay]").querySelector(".pc-audience-dialog")?.focus());
  };
  input.addEventListener("keydown", keyEvent => { if (keyEvent.key === "Enter") finish(true); if (keyEvent.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true), { once: true });
}

function addAudienceNode() {
  if (!editMode) return;
  const parent = state.audienceSelected.size === 1 ? manifest.audience.nodes.find(node => state.audienceSelected.has(node.id)) : manifest.audience.nodes.find(node => node.id === manifest.audience.rootId);
  if (!parent) return;
  const existingChildren = manifest.audience.nodes.filter(node => node.parentId === parent.id);
  const fallbackCanvas = parent.id === manifest.audience.rootId && !existingChildren.length
    ? manifest.canvases.find(canvas => canvas.id === activeCanvasId()) || manifest.canvases[0]
    : null;
  const ownedCanvasId = parent.canvasId || fallbackCanvas?.id || null;
  const hasCanvas = Boolean(ownedCanvasId && manifest.nodes.some(node => node.canvasId === ownedCanvasId));
  const proceed = () => {
    let addedId = null;
    mutate("新增用户类型下级", () => {
    const id = uniqueId("audience");
    addedId = id;
    let profileId = parent.profileId;
    let canvasId = parent.canvasId || fallbackCanvas?.id || null;
    if (!profileId) {
      profileId = uniqueId("profile");
      canvasId ||= uniqueId("canvas");
      manifest.profiles.push({ id: profileId, name: "新用户类型", attributes: {}, canvasId, source: "user" });
      const existingCanvas = manifest.canvases.find(canvas => canvas.id === canvasId);
      if (existingCanvas) { existingCanvas.profileId = profileId; existingCanvas.name = "新用户类型"; }
      else manifest.canvases.push({ id: canvasId, profileId, name: "新用户类型" });
      ensureCanvasView(canvasId);
    }
    const type = nextAudienceType(parent.type);
    const node = { id, title: "新用户类型", type, typeLabel: AUDIENCE_TYPES[type], descriptionHtml: "<p>说明待补充。</p>", parentId: parent.id, order: existingChildren.length, collapsed: false, profileId, canvasId, layout: { x: parent.layout.x + 280, y: parent.layout.y, width: 220, height: 58 } };
    manifest.audience.nodes.push(node);
    parent.profileId = null; parent.canvasId = null;
    const migratedProfile = manifest.profiles.find(profile => profile.id === profileId);
    const migratedCanvas = manifest.canvases.find(canvas => canvas.id === canvasId);
    if (migratedProfile) migratedProfile.name = node.title;
    if (migratedCanvas) migratedCanvas.name = node.title;
    state.audienceSelected = new Set([id]);
    ensureAudienceLeafCanvases();
    }, true);
    requestAnimationFrame(() => beginAudienceRenameById(addedId));
  };
  if (hasCanvas) showConfirm("迁移用户类型画布", "新增下级后，当前节点将变为分类节点，只有末级节点拥有画布。确定后，当前画布会迁移到新建的第一个下级。", proceed);
  else proceed();
}

function addAudienceSibling(before = false) {
  const current = selectedAudienceNode();
  if (!current || current.id === manifest.audience.rootId) return addAudienceNode();
  mutate("新增同级用户类型", () => {
    const id = uniqueId("audience");
    const profileId = uniqueId("profile");
    const canvasId = uniqueId("canvas");
    const node = {
      id,
      title: "新用户类型",
      type: current.type,
      typeLabel: AUDIENCE_TYPES[current.type],
      descriptionHtml: "<p>说明待补充。</p>",
      parentId: current.parentId,
      order: Number(current.order || 0) + (before ? -.5 : .5),
      collapsed: false,
      profileId,
      canvasId,
      layout: { x: current.layout.x, y: current.layout.y + 72, width: 220, height: 58 }
    };
    manifest.audience.nodes.push(node);
    manifest.profiles.push({ id: profileId, name: node.title, attributes: {}, canvasId, source: "user" });
    manifest.canvases.push({ id: canvasId, profileId, name: node.title });
    ensureCanvasView(canvasId);
    renumberAudience();
    layoutAudience();
    state.audienceSelected = new Set([id]);
  }, true);
  requestAnimationFrame(() => beginAudienceRenameById([...state.audienceSelected][0]));
}

function beginAudienceRenameById(nodeId) {
  if (!nodeId) return;
  const node = manifest.audience.nodes.find(item => item.id === nodeId);
  const nodeElement = el("[data-audience-overlay]")?.querySelector(`[data-audience-node="${cssEscape(nodeId)}"]`);
  if (node && nodeElement) beginAudienceRename(node, nodeElement);
}

function reorderAudienceSelected(direction) {
  const node = selectedAudienceNode();
  if (!node || node.id === manifest.audience.rootId) return;
  const siblings = manifest.audience.nodes.filter(item => (item.parentId || null) === (node.parentId || null)).sort((left, right) => left.order - right.order);
  const index = siblings.findIndex(item => item.id === node.id);
  const next = Math.max(0, Math.min(siblings.length - 1, index + direction));
  if (index === next) return;
  mutate("调整用户类型同级顺序", () => {
    const [moved] = siblings.splice(index, 1);
    siblings.splice(next, 0, moved);
    siblings.forEach((item, order) => { item.order = order; });
    layoutAudience();
  }, true);
}

function outdentAudienceSelected() {
  const node = selectedAudienceNode();
  const parent = manifest.audience.nodes.find(item => item.id === node?.parentId);
  if (!node || !parent || node.id === manifest.audience.rootId) return;
  mutate("用户类型节点提升一级", () => {
    node.parentId = parent.parentId || null;
    node.order = Number(parent.order || 0) + .5;
    renumberAudience();
    ensureAudienceLeafCanvases();
    layoutAudience();
  }, true);
}

function deleteAudienceSelection() {
  const rootId = manifest.audience.rootId;
  const removed = new Set();
  for (const id of state.audienceSelected) {
    if (id === rootId) continue;
    audienceDescendants(id).forEach(item => removed.add(item));
  }
  if (!removed.size) return;
  mutate("删除用户类型及其下级", () => {
    const remaining = manifest.audience.nodes.filter(node => !removed.has(node.id));
    const affectedParents = [...new Set(manifest.audience.nodes.filter(node => removed.has(node.id) && node.parentId && !removed.has(node.parentId)).map(node => node.parentId))];
    const rescuedProfiles = new Set();
    const rescuedCanvases = new Set();
    for (const parentId of affectedParents) {
      const parent = remaining.find(node => node.id === parentId);
      if (!parent || remaining.some(node => node.parentId === parent.id) || parent.profileId) continue;
      const source = manifest.audience.nodes
        .filter(node => removed.has(node.id) && node.profileId && audienceHasAncestor(node.id, parent.id))
        .sort((left, right) => Number(left.order || 0) - Number(right.order || 0))[0];
      if (source) {
        if (parent.id === rootId) {
          const canvas = manifest.canvases.find(item => item.id === source.canvasId);
          if (canvas) { canvas.profileId = null; canvas.name = "未配置用户类型"; }
          rescuedCanvases.add(source.canvasId);
          manifest.viewState.defaultCanvasId = source.canvasId;
          parent.profileId = null;
          parent.canvasId = null;
        } else {
          parent.profileId = source.profileId;
          parent.canvasId = source.canvasId;
          rescuedProfiles.add(source.profileId);
          syncAudienceIdentityName(parent);
        }
      }
    }
    const removedProfiles = new Set(manifest.audience.nodes.filter(node => removed.has(node.id) && node.profileId && !rescuedProfiles.has(node.profileId)).map(node => node.profileId));
    const removedCanvases = new Set(manifest.profiles.filter(profile => removedProfiles.has(profile.id) && !rescuedCanvases.has(profile.canvasId)).map(profile => profile.canvasId));
    manifest.audience.nodes = remaining;
    manifest.viewState.deletedProfileIds = [...new Set([...(manifest.viewState.deletedProfileIds || []), ...removedProfiles])];
    manifest.profiles = manifest.profiles.filter(profile => !removedProfiles.has(profile.id));
    manifest.canvases = manifest.canvases.filter(canvas => !removedCanvases.has(canvas.id));
    const removedNodeIds = new Set(manifest.nodes.filter(node => removedCanvases.has(node.canvasId)).map(node => node.id));
    manifest.nodes = manifest.nodes.filter(node => !removedCanvases.has(node.canvasId));
    manifest.edges = manifest.edges.filter(edge => !removedCanvases.has(edge.canvasId));
    for (const key of Object.keys(manifest.snapshots || {})) if (removedNodeIds.has(key.split("::")[0])) delete manifest.snapshots[key];
    if (removedProfiles.has(state.profileId)) state.profileId = manifest.profiles[0]?.id || null;
    if (!manifest.canvases.length) {
      manifest.canvases.push({ id: "canvas-global", profileId: null, name: "未配置用户类型" });
      ensureCanvasView("canvas-global");
      manifest.viewState.defaultCanvasId = "canvas-global";
    }
    ensureAudienceLeafCanvases();
    manifest.viewState.activeProfileId = state.profileId;
    state.audienceSelected.clear();
    renumberAudience();
  }, true);
}

function switchProfile(profileId) {
  const profile = manifest.profiles.find(item => item.id === profileId);
  if (!profile) return;
  state.profileId = profileId;
  manifest.viewState.activeProfileId = profileId;
  manifest.viewState.defaultCanvasId = profile.canvasId;
  state.selectedNodes.clear(); state.selectedEdgeId = null;
  el("[data-audience-overlay]").hidden = true;
  stopInlineFrame(); renderAll(); fitCanvas(false); saveSoon();
}

function closeAudience() {
  el("[data-audience-overlay]").hidden = true;
  state.audienceSelected.clear();
  state.profileId = manifest.profiles.some(profile => profile.id === state.profileId) ? state.profileId : null;
  manifest.viewState.activeProfileId = state.profileId;
  renderAll();
  saveSoon();
}

function audiencePointerDown(event) {
  if (event.button !== 0) return;
  const overlay = el("[data-audience-overlay]");
  if (event.target.closest(".pc-audience-minimap")) return beginAudienceMinimapDrag(event);
  const nodeElement = event.target.closest("[data-audience-node]");
  if (nodeElement && editMode && !event.target.closest("button,input")) {
    const id = nodeElement.dataset.audienceNode;
    if (!state.audienceSelected.has(id)) state.audienceSelected = new Set([id]);
    const selected = state.audienceSelected.has(id) && state.audienceSelected.size > 1 ? [...state.audienceSelected] : [id];
    const rootIds = canonicalSelectionRoots(selected, manifest.audience.nodes);
    const ids = new Set(rootIds.flatMap(rootId => [...audienceDescendants(rootId)]));
    state.audienceDrag = {
      id,
      rootIds,
      ids,
      start: audienceClientToWorld(event),
      before: deepClone(manifest),
      original: Object.fromEntries([...ids].map(nodeId => [nodeId, deepClone(manifest.audience.nodes.find(item => item.id === nodeId).layout)])),
      moved: false,
      last: audienceClientToWorld(event),
      tempDelta: { x: 0, y: 0 },
      hint: null
    };
    document.addEventListener("pointermove", audiencePointerMove);
    document.addEventListener("pointerup", audiencePointerUp, { once: true });
    event.preventDefault(); return;
  }
  if (nodeElement) return;
  if (state.spaceDown) {
    state.audience.pan = { x: event.clientX, y: event.clientY, startX: state.audienceView.x, startY: state.audienceView.y };
    document.addEventListener("pointermove", audiencePointerMove);
    document.addEventListener("pointerup", audiencePointerUp, { once: true }); return;
  }
  state.audienceBox = { startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false };
  document.addEventListener("pointermove", audiencePointerMove);
  document.addEventListener("pointerup", audiencePointerUp, { once: true });
  event.preventDefault();
}

function audiencePointerMove(event) {
  if (state.audience?.pan) {
    state.audienceView.x = state.audience.pan.startX + event.clientX - state.audience.pan.x;
    state.audienceView.y = state.audience.pan.startY + event.clientY - state.audience.pan.y;
    return applyAudienceView();
  }
  if (state.audienceBox) {
    const box = state.audienceBox; box.x = event.clientX; box.y = event.clientY; box.moved ||= Math.hypot(box.x - box.startX, box.y - box.startY) > 4;
    const rect = el("[data-audience-overlay]").querySelector("[data-audience-viewport]").getBoundingClientRect();
    const boxEl = el("[data-audience-box]"); boxEl.hidden = !box.moved;
    boxEl.style.cssText = `left:${Math.min(box.startX, box.x) - rect.left}px;top:${Math.min(box.startY, box.y) - rect.top}px;width:${Math.abs(box.x - box.startX)}px;height:${Math.abs(box.y - box.startY)}px`;
    return;
  }
  if (state.audienceDrag) {
    const drag = state.audienceDrag; const point = audienceClientToWorld(event); drag.last = point; drag.moved ||= Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 4;
    if (drag.moved) {
      drag.tempDelta = { x: point.x - drag.start.x, y: point.y - drag.start.y };
      drag.hint = drag.rootIds.includes(manifest.audience.rootId) ? null : findAudienceDropHint(event.clientX, event.clientY, drag.ids, point);
      renderAudienceGraph();
    }
  }
}

function audiencePointerUp(event) {
  document.removeEventListener("pointermove", audiencePointerMove);
  if (state.audience?.pan) { state.audience.pan = null; manifest.audience.view = state.audienceView; saveSoon(); return; }
  if (state.audienceBox) {
    const box = state.audienceBox; state.audienceBox = null; el("[data-audience-box]").hidden = true;
    if (!box.moved) state.audienceSelected.clear();
    else {
      const selection = { left: Math.min(box.startX, box.x), top: Math.min(box.startY, box.y), right: Math.max(box.startX, box.x), bottom: Math.max(box.startY, box.y) };
      state.audienceSelected.clear();
      el("[data-audience-overlay]").querySelectorAll("[data-audience-node]").forEach(node => { const rect = node.getBoundingClientRect(); if (rect.right >= selection.left && rect.left <= selection.right && rect.bottom >= selection.top && rect.top <= selection.bottom) state.audienceSelected.add(node.dataset.audienceNode); });
    }
    return renderAudienceGraph();
  }
  const drag = state.audienceDrag; state.audienceDrag = null;
  if (!drag?.moved) return;
  if (drag.hint?.requiresMigration) {
    showConfirm("调整用户类型层级", "目标节点已有画布。确定后将自动新增一个下级保留原画布，再放入当前节点。", () => applyAudienceDrop(drag, true));
    return renderAudienceGraph();
  }
  applyAudienceDrop(drag, Boolean(drag.hint?.targetProfileId));
}

function findAudienceDropHint(clientX, clientY, draggedIds, point) {
  const gapHint = findAudienceGapHint(point, draggedIds);
  if (gapHint) return gapHint;
  const candidateElement = document.elementsFromPoint(clientX, clientY).find(item => item.matches?.("[data-audience-node]") && !draggedIds.has(item.dataset.audienceNode));
  const candidate = manifest.audience.nodes
    .filter(node => !draggedIds.has(node.id))
    .filter(node => point.x >= node.layout.x && point.x <= node.layout.x + node.layout.width && point.y >= node.layout.y && point.y <= node.layout.y + node.layout.height)
    .sort((left, right) => distanceToCenter(left.layout, point) - distanceToCenter(right.layout, point))[0]
    || manifest.audience.nodes.find(node => node.id === candidateElement?.dataset.audienceNode);
  if (!candidate) return { parentId: null, order: 0, marker: null };
  const relative = (point.y - candidate.layout.y) / candidate.layout.height;
  if (candidate.parentId && (relative < .28 || relative > .72)) {
    const siblings = manifest.audience.nodes.filter(node => node.parentId === candidate.parentId).sort((a, b) => a.order - b.order);
    const index = siblings.findIndex(node => node.id === candidate.id) + (relative > .72 ? 1 : 0);
    return { parentId: candidate.parentId, order: index - .25, marker: { x: candidate.layout.x, y: relative > .72 ? candidate.layout.y + candidate.layout.height + 8 : candidate.layout.y - 8, width: candidate.layout.width } };
  }
  if (candidate.profileId) {
    const hasCanvas = manifest.nodes.some(node => node.canvasId === candidate.canvasId);
    return { parentId: candidate.id, order: 1, targetId: candidate.id, targetProfileId: candidate.profileId, requiresMigration: hasCanvas, marker: null };
  }
  return { parentId: candidate.id, order: manifest.audience.nodes.filter(node => node.parentId === candidate.id).length, targetId: candidate.id, marker: null };
}

function findAudienceGapHint(point, draggedIds) {
  const nodes = audienceVisibleNodes();
  const visible = new Set(nodes.map(node => node.id));
  const hints = [];
  for (const parent of nodes.filter(node => !draggedIds.has(node.id))) {
    const siblings = manifest.audience.nodes.filter(node => node.parentId === parent.id && visible.has(node.id) && !draggedIds.has(node.id)).sort((left, right) => left.order - right.order);
    if (!siblings.length) continue;
    const branches = siblings.map(node => ({ node, bounds: audienceSubtreeBounds(node.id, visible, draggedIds) }));
    const left = Math.min(...branches.map(item => item.bounds.x)) - 90;
    const right = Math.max(...branches.map(item => item.bounds.x + item.bounds.width)) + 90;
    if (point.x < left || point.x > right) continue;
    for (let index = 0; index <= branches.length; index += 1) {
      const previous = branches[index - 1]?.bounds;
      const next = branches[index]?.bounds;
      const top = previous ? previous.y + previous.height : next.y - 90;
      const bottom = next ? next.y : previous.y + previous.height + 90;
      if (point.y < top || point.y > bottom) continue;
      const markerY = previous && next ? (top + bottom) / 2 : previous ? previous.y + previous.height + 16 : next.y - 16;
      const reference = branches[Math.min(index, branches.length - 1)].node.layout;
      hints.push({ parentId: parent.id, order: index - .5, targetId: null, marker: { x: reference.x, y: markerY, width: reference.width }, score: Math.abs(point.x - (reference.x + reference.width / 2)) + Math.abs(point.y - markerY) * .15 });
    }
  }
  hints.sort((left, right) => left.score - right.score);
  if (!hints[0]) return null;
  const { score, ...hint } = hints[0];
  return hint;
}

function audienceSubtreeBounds(rootId, visibleIds, excludedIds = new Set()) {
  const layouts = [...audienceDescendants(rootId)]
    .filter(id => visibleIds.has(id) && !excludedIds.has(id))
    .map(id => manifest.audience.nodes.find(node => node.id === id)?.layout)
    .filter(Boolean);
  const minX = Math.min(...layouts.map(layout => layout.x));
  const minY = Math.min(...layouts.map(layout => layout.y));
  const maxX = Math.max(...layouts.map(layout => layout.x + layout.width));
  const maxY = Math.max(...layouts.map(layout => layout.y + layout.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function applyAudienceDrop(drag, migrateTarget) {
  const hint = drag.hint;
  if (hint?.parentId && migrateTarget) migrateAudienceCanvasToChild(hint.parentId);
  if (hint?.parentId) {
    drag.rootIds.forEach((id, index) => {
      const node = manifest.audience.nodes.find(item => item.id === id);
      node.parentId = hint.parentId;
      node.order = Number(hint.order || 0) + index / 100;
    });
  } else {
    drag.rootIds.forEach((id, index) => {
      const node = manifest.audience.nodes.find(item => item.id === id);
      node.parentId = null;
      node.order = index;
      const original = drag.original[id];
      node.layout.x = original.x + drag.tempDelta.x;
      node.layout.y = original.y + drag.tempDelta.y;
    });
  }
  renumberAudience();
  ensureAudienceLeafCanvases();
  layoutAudience();
  state.suppressAudienceClick = true;
  setTimeout(() => { state.suppressAudienceClick = false; }, 0);
  recordHistory(drag.before, hint?.parentId ? "调整用户类型归属或顺序" : "移动用户类型节点树");
  renderAudienceGraph();
}

function beginAudienceMinimapDrag(event) {
  if (event.target.closest("button")) return;
  const overlay = el("[data-audience-overlay]");
  const content = overlay.querySelector("[data-audience-minimap-content]");
  if (!content?.dataset.bounds) return;
  const marker = event.target.closest("[data-audience-mini-viewport]");
  const markerRect = marker?.getBoundingClientRect();
  const dragOffset = markerRect ? { x: event.clientX - markerRect.left - markerRect.width / 2, y: event.clientY - markerRect.top - markerRect.height / 2 } : { x: 0, y: 0 };
  const pointerId = event.pointerId;
  try { content.setPointerCapture?.(pointerId); } catch {}
  state.audienceMiniDrag = true;
  const move = moveEvent => {
    if (!state.audienceMiniDrag) return;
    const rect = content.getBoundingClientRect();
    const bounds = JSON.parse(content.dataset.bounds);
    const worldPoint = { x: bounds.x + (moveEvent.clientX - dragOffset.x - rect.left) / bounds.factor, y: bounds.y + (moveEvent.clientY - dragOffset.y - rect.top) / bounds.factor };
    const viewportRect = overlay.querySelector("[data-audience-viewport]").getBoundingClientRect();
    state.audienceView.x = viewportRect.width / 2 - worldPoint.x * state.audienceView.scale;
    state.audienceView.y = viewportRect.height / 2 - worldPoint.y * state.audienceView.scale;
    applyAudienceView(true);
  };
  const up = () => {
    state.audienceMiniDrag = false;
    document.removeEventListener("pointermove", move);
    try { if (content.hasPointerCapture?.(pointerId)) content.releasePointerCapture(pointerId); } catch {}
    manifest.audience.view = state.audienceView;
    saveSoon();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up, { once: true });
  move(event);
  event.preventDefault();
  event.stopPropagation();
}

function audienceBounds(nodes = audienceVisibleNodes(), padding = 36) {
  if (!nodes.length) return { x: -300, y: -200, width: 600, height: 400 };
  const minX = Math.min(...nodes.map(node => node.layout.x)) - padding;
  const minY = Math.min(...nodes.map(node => node.layout.y)) - padding;
  const maxX = Math.max(...nodes.map(node => node.layout.x + node.layout.width)) + padding;
  const maxY = Math.max(...nodes.map(node => node.layout.y + node.layout.height)) + padding;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function clampAudienceView() {
  const audienceViewport = el("[data-audience-overlay]").querySelector("[data-audience-viewport]");
  if (!audienceViewport) return;
  const nodes = audienceVisibleNodes();
  if (!nodes.length) return;
  const rect = audienceViewport.getBoundingClientRect();
  const bounds = audienceBounds(nodes, 36);
  const visibleX = Math.min(160, rect.width * .28);
  const visibleY = Math.min(120, rect.height * .28);
  const minX = visibleX - (bounds.x + bounds.width) * state.audienceView.scale;
  const maxX = rect.width - visibleX - bounds.x * state.audienceView.scale;
  const minY = visibleY - (bounds.y + bounds.height) * state.audienceView.scale;
  const maxY = rect.height - visibleY - bounds.y * state.audienceView.scale;
  state.audienceView.x = clamp(state.audienceView.x, Math.min(minX, maxX), Math.max(minX, maxX));
  state.audienceView.y = clamp(state.audienceView.y, Math.min(minY, maxY), Math.max(minY, maxY));
}

function applyAudienceView(immediateMinimap = false) {
  const overlay = el("[data-audience-overlay]");
  const worldEl = overlay?.querySelector("[data-audience-world]");
  if (!worldEl) return;
  clampAudienceView();
  worldEl.style.transform = `translate(${state.audienceView.x}px, ${state.audienceView.y}px) scale(${state.audienceView.scale})`;
  const zoom = overlay.querySelector(".pc-audience-zoom");
  if (zoom) zoom.textContent = `${Math.round(state.audienceView.scale * 100)}%`;
  manifest.audience.view = state.audienceView;
  if (immediateMinimap) syncAudienceMinimapViewport();
  else syncAudienceMinimapViewportSoon();
}

function audienceWheel(event) {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) return audienceZoom(state.audienceView.scale * Math.exp(-event.deltaY * .0015), { x: event.clientX, y: event.clientY });
  if (event.shiftKey) state.audienceView.x -= event.deltaY || event.deltaX;
  else { state.audienceView.x -= event.deltaX; state.audienceView.y -= event.deltaY; }
  applyAudienceView(); saveSoon();
}

function audienceZoom(next, clientPoint = null) {
  const overlayViewport = el("[data-audience-overlay]").querySelector("[data-audience-viewport]");
  const rect = overlayViewport.getBoundingClientRect();
  const point = clientPoint || { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const local = { x: point.x - rect.left, y: point.y - rect.top };
  const worldPoint = { x: (local.x - state.audienceView.x) / state.audienceView.scale, y: (local.y - state.audienceView.y) / state.audienceView.scale };
  state.audienceView.scale = clamp(next, .2, 3);
  state.audienceView.x = local.x - worldPoint.x * state.audienceView.scale;
  state.audienceView.y = local.y - worldPoint.y * state.audienceView.scale;
  applyAudienceView(); saveSoon();
}

function fitAudience(save = true) {
  const nodes = audienceVisibleNodes(); if (!nodes.length) return;
  const bounds = audienceBounds(nodes, 80);
  const rect = el("[data-audience-overlay]").querySelector("[data-audience-viewport]").getBoundingClientRect();
  state.audienceView.scale = clamp(Math.min(rect.width / bounds.width, rect.height / bounds.height), .2, 1.3);
  state.audienceView.x = (rect.width - bounds.width * state.audienceView.scale) / 2 - bounds.x * state.audienceView.scale;
  state.audienceView.y = (rect.height - bounds.height * state.audienceView.scale) / 2 - bounds.y * state.audienceView.scale;
  constrainFittedView(state.audienceView, bounds, rect, 36);
  manifest.audience.view = state.audienceView;
  renderAudienceGraph();
  if (save) saveSoon();
}

function mutate(label, callback, audience = false) {
  const before = deepClone(manifest);
  callback();
  recordHistory(before, label);
  audience ? renderAudienceGraph() : renderAll();
}

function mutateFromCurrent(label, callback) {
  const before = deepClone(manifest); callback(); recordHistory(before, label); renderAll();
}

function recordHistory(before, label) {
  state.undo.push({ manifest: before, label });
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  state.lastOperation = label;
  state.operations.push({ at: new Date().toISOString(), label });
  saveSoon();
}

function undo(audience = false) {
  const item = state.undo.pop(); if (!item) return;
  const viewportState = captureViewportState();
  state.redo.push({ manifest: deepClone(manifest), label: item.label });
  replaceManifest(item.manifest, viewportState); state.lastOperation = `撤销：${item.label}`; saveSoon(); audience ? renderAudienceGraph() : renderAll();
}

function redo(audience = false) {
  const item = state.redo.pop(); if (!item) return;
  const viewportState = captureViewportState();
  state.undo.push({ manifest: deepClone(manifest), label: item.label });
  replaceManifest(item.manifest, viewportState); state.lastOperation = `重做：${item.label}`; saveSoon(); audience ? renderAudienceGraph() : renderAll();
}

function captureViewportState() {
  return {
    mode: state.mode,
    profileId: state.profileId,
    defaultCanvasId: manifest.viewState.defaultCanvasId,
    canvases: deepClone(manifest.viewState.canvases || {}),
    audienceView: deepClone(state.audienceView),
    audienceMinimapScale: state.audienceMinimapScale,
    inspectorWidth: state.inspectorWidth
  };
}

function replaceManifest(value, viewportState = null) {
  for (const key of Object.keys(manifest)) delete manifest[key];
  Object.assign(manifest, deepClone(value));
  manifest.viewState ||= { activeMode: "mindmap", activeProfileId: null, defaultCanvasId: manifest.canvases?.[0]?.id, canvases: {} };
  manifest.viewState.canvases ||= {};
  manifest.audience ||= { nodes: [], view: { x: 80, y: 80, scale: 1 }, minimap: { scale: 1 } };
  manifest.audience.minimap ||= { scale: 1 };
  if (viewportState) {
    for (const canvas of manifest.canvases || []) {
      if (viewportState.canvases?.[canvas.id]) manifest.viewState.canvases[canvas.id] = deepClone(viewportState.canvases[canvas.id]);
    }
    if (manifest.canvases?.some(canvas => canvas.id === viewportState.defaultCanvasId)) manifest.viewState.defaultCanvasId = viewportState.defaultCanvasId;
    const preservedProfileExists = viewportState.profileId === null || manifest.profiles?.some(profile => profile.id === viewportState.profileId);
    state.profileId = preservedProfileExists ? viewportState.profileId : manifest.viewState.activeProfileId;
    state.mode = ["mindmap", "snapshot"].includes(viewportState.mode) ? viewportState.mode : manifest.viewState.activeMode;
    state.audienceView = deepClone(viewportState.audienceView || manifest.audience.view || { x: 80, y: 80, scale: 1 });
    state.audienceMinimapScale = viewportState.audienceMinimapScale || 1;
    state.inspectorWidth = clamp(Number(viewportState.inspectorWidth || 330), 260, 640);
    manifest.viewState.activeMode = state.mode;
    manifest.viewState.activeProfileId = state.profileId;
    manifest.viewState.inspectorWidth = state.inspectorWidth;
    manifest.audience.view = deepClone(state.audienceView);
    manifest.audience.minimap.scale = state.audienceMinimapScale;
  } else {
    state.mode = manifest.viewState.activeMode;
    state.profileId = manifest.viewState.activeProfileId;
    state.audienceView = manifest.audience.view || { x: 80, y: 80, scale: 1 };
    state.audienceMinimapScale = manifest.audience.minimap.scale || 1;
    state.inspectorWidth = clamp(Number(manifest.viewState.inspectorWidth || 330), 260, 640);
  }
  state.selectedNodes.clear(); state.selectedEdgeId = null;
}

async function saveSession() {
  if (!editMode || !config.apiUrl) return;
  const saveState = el("[data-save-state]");
  if (saveState) saveState.textContent = "保存中...";
  try {
    const response = await fetch(config.apiUrl, { method: "PUT", headers: { "content-type": "application/json", "x-prototype-canvas-token": config.apiToken }, body: JSON.stringify({ sessionId: config.sessionId, manifest, operations: state.operations, lastOperation: state.lastOperation }) });
    await readApiResponse(response, "画布没有保存成功。");
    if (saveState) saveState.textContent = "已保存";
  } catch (error) { if (saveState) saveState.textContent = "未保存"; showToast(friendlyErrorMessage(error, "画布没有保存成功，请刷新页面后重试。")); }
}

async function readApiResponse(response, fallback) {
  const payload = await response.json().catch(() => ({}));
  if (response.ok) return payload;
  const error = new Error(payload.error || fallback);
  error.code = payload.code || "";
  error.status = response.status;
  throw error;
}

function friendlyErrorMessage(error, fallback = "操作没有完成，请稍后重试。") {
  const raw = String(error?.message || error || "").trim();
  const code = String(error?.code || "");
  const status = Number(error?.status || 0);
  if (raw) console.error("[原型画布]", raw);
  if (code === "EDITOR_PAGE_EXPIRED" || status === 401 || status === 403 || /Token|凭证.*失效/i.test(raw)) return "本地编辑服务已经重启，当前页面已失效。请刷新浏览器页面后再试。";
  if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(raw)) return "无法连接本地编辑服务。请确认 localhost 仍在运行，然后刷新页面重试。";
  if (/找不到交互入口|等待入口超时|找不到点击入口/.test(raw)) return "没有在原型中找到需要点击的入口。页面可能尚未加载完成，或原型结构已经变化，请重新定位这个节点。";
  if (/找不到关联页面|找不到关联目标|找不到目标|无法定位关联页面/.test(raw)) return "没有找到之前关联的页面。原型内容可能已经变化，请重新定位这个节点。";
  if (/定位超时|预览定位超时|回放内核未加载/.test(raw)) return "原型页面加载时间过长。请稍后重试；如果仍然失败，请重新打开本地预览。";
  if (/Session|会话|已应用|EDITOR_SESSION/i.test(raw) || code === "EDITOR_SESSION_CLOSED") return "当前编辑会话已经结束。请重新打开本地编辑地址后再操作。";
  if (/Hash|源 HTML|原型文件已被修改|SOURCE_CHANGED/i.test(raw) || code === "SOURCE_CHANGED") return "原型文件已经发生变化，当前画布不能继续保存。请重新分析原型后再编辑。";
  if (/Manifest|画布数据|节点类型无效|连线类型无效|不能直接归属于/i.test(raw) || code === "INVALID_CANVAS_DATA") return "画布数据不完整，暂时无法保存。请撤销最近一次操作；如果仍未恢复，请刷新页面。";
  if (/请求内容超过|REQUEST_TOO_LARGE/i.test(raw) || code === "REQUEST_TOO_LARGE") return "本次保存的数据量过大，浏览器无法提交。请减少一次操作的内容后重试。";
  if (/JSON|INVALID_REQUEST/i.test(raw) || code === "INVALID_REQUEST") return "本次请求内容不完整。请刷新页面后重新操作。";
  if (/没有可用的 Chromium|Chrome|Edge/.test(raw) || code === "BROWSER_UNAVAILABLE") return "电脑上没有找到可用的 Chrome 或 Edge，暂时不能生成页面预览。";
  if (/预览采集服务已经关闭|LOCAL_SERVICE_STOPPED/i.test(raw) || code === "LOCAL_SERVICE_STOPPED") return "本地预览服务已经停止。请重新启动 localhost 后再试。";
  if (/节点尚未关联原型页面/.test(raw)) return "这个节点还没有关联原型页面，请先点击“重新定位”完成关联。";
  if (/找不到需要生成预览的节点|找不到需要验证的节点/.test(raw)) return "这个节点已经不存在。请刷新页面后重新选择节点。";
  if (/预览未生成完成|截图|生成预览/.test(raw)) return "页面已经定位，但预览图片没有生成成功。请稍后重新关联。";
  if (/当前画布没有可导出的节点|导出内容校验失败|画布尺寸超出|浏览器未能生成/.test(raw)) return raw;
  return fallback;
}

function showOperationMask(title, detail) {
  const mask = el("[data-operation-mask]");
  if (!mask) return;
  mask.hidden = false;
  updateOperationMask(title, detail);
}

function updateOperationMask(title, detail) {
  const mask = el("[data-operation-mask]");
  if (!mask) return;
  mask.querySelector("[data-operation-title]").textContent = title;
  mask.querySelector("[data-operation-detail]").textContent = detail;
}

function hideOperationMask() {
  const mask = el("[data-operation-mask]");
  if (mask) mask.hidden = true;
}

function showErrorDialog(title, message) {
  showDialog(title, `<p>${escapeHtml(message)}</p><footer><button class="pc-primary" data-dialog-confirm>知道了</button></footer>`, dialog => {
    dialog.querySelector("[data-dialog-confirm]").onclick = closeDialog;
  });
}

function showConfirm(title, message, onConfirm) {
  showDialog(title, `<p>${escapeHtml(message)}</p><footer><button data-dialog-cancel>取消</button><button class="pc-primary" data-dialog-confirm>确定</button></footer>`, dialog => {
    dialog.querySelector("[data-dialog-cancel]").onclick = closeDialog;
    dialog.querySelector("[data-dialog-confirm]").onclick = () => { closeDialog(); onConfirm(); };
  });
}

function showDialog(title, content, bind) {
  const layer = el("[data-dialog-layer]");
  layer.innerHTML = `<div class="pc-dialog-backdrop" data-dialog-close></div><section class="pc-dialog" role="dialog" aria-modal="true"><header><strong>${escapeHtml(title)}</strong><button class="pc-icon-btn" data-dialog-close title="关闭"><i data-lucide="x"></i></button></header><div class="pc-dialog-body">${content}</div></section>`;
  layer.classList.add("is-open");
  layer.querySelectorAll("[data-dialog-close]").forEach(item => item.onclick = closeDialog);
  refreshIcons(layer); bind?.(layer.querySelector(".pc-dialog"));
}

function closeDialog() { const layer = el("[data-dialog-layer]"); layer.classList.remove("is-open"); layer.innerHTML = ""; }

function showToast(message) {
  const toast = el("[data-toast]"); toast.textContent = message; toast.hidden = false; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { toast.hidden = true; }, 2400);
}

function clientToWorld(clientX, clientY) {
  const rect = viewport.getBoundingClientRect(); const view = currentView();
  return { x: (clientX - rect.left - view.x) / view.scale, y: (clientY - rect.top - view.y) / view.scale };
}

function screenCenterWorld() { const rect = viewport.getBoundingClientRect(); return clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2); }

function audienceClientToWorld(event) {
  const rect = el("[data-audience-overlay]").querySelector("[data-audience-viewport]").getBoundingClientRect();
  return { x: (event.clientX - rect.left - state.audienceView.x) / state.audienceView.scale, y: (event.clientY - rect.top - state.audienceView.y) / state.audienceView.scale };
}

function audienceDescendants(id) {
  const result = new Set([id]);
  const visit = parent => manifest.audience.nodes.filter(node => node.parentId === parent).forEach(node => { result.add(node.id); visit(node.id); });
  visit(id); return result;
}

function audienceHasAncestor(id, ancestorId) {
  let current = manifest.audience.nodes.find(node => node.id === id);
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    current = manifest.audience.nodes.find(node => node.id === current.parentId);
  }
  return false;
}

function nextAudienceType(type) {
  const index = AUDIENCE_TYPE_SEQUENCE.indexOf(type);
  return AUDIENCE_TYPE_SEQUENCE[Math.min(AUDIENCE_TYPE_SEQUENCE.length - 1, index + 1)] || "tenant";
}

function syncAudienceIdentityName(node) {
  const profile = manifest.profiles.find(item => item.id === node.profileId);
  if (profile) { profile.name = node.title; profile.userEdited = true; }
  const canvas = manifest.canvases.find(item => item.id === node.canvasId);
  if (canvas) canvas.name = node.title;
}

function ensureAudienceLeafCanvases() {
  const nodes = manifest.audience.nodes || [];
  for (const node of nodes) {
    if (node.id === manifest.audience.rootId || nodes.some(item => item.parentId === node.id)) continue;
    const profile = manifest.profiles.find(item => item.id === node.profileId);
    const canvas = manifest.canvases.find(item => item.id === node.canvasId);
    if (profile && canvas) { syncAudienceIdentityName(node); continue; }
    const profileId = uniqueId("profile");
    const canvasId = uniqueId("canvas");
    node.profileId = profileId;
    node.canvasId = canvasId;
    manifest.profiles.push({ id: profileId, name: node.title, attributes: {}, canvasId, source: "user" });
    manifest.canvases.push({ id: canvasId, profileId, name: node.title });
    if (manifest.viewState?.canvases) ensureCanvasView(canvasId);
  }
}

function migrateAudienceCanvasToChild(parentId) {
  const parent = manifest.audience.nodes.find(node => node.id === parentId);
  if (!parent?.profileId) return null;
  manifest.audience.nodes.filter(node => node.parentId === parent.id).forEach(node => { node.order += 1; });
  const type = nextAudienceType(parent.type);
  const child = {
    id: uniqueId("audience"),
    title: parent.title,
    type,
    typeLabel: AUDIENCE_TYPES[type],
    descriptionHtml: parent.descriptionHtml || "<p>说明待补充。</p>",
    parentId: parent.id,
    order: 0,
    collapsed: false,
    profileId: parent.profileId,
    canvasId: parent.canvasId,
    layout: { x: parent.layout.x + 280, y: parent.layout.y, width: 220, height: 58 }
  };
  parent.profileId = null;
  parent.canvasId = null;
  manifest.audience.nodes.push(child);
  syncAudienceIdentityName(child);
  return child;
}

function renumberAudience() {
  const parents = new Set(manifest.audience.nodes.map(node => node.parentId || "__root__"));
  for (const parent of parents) manifest.audience.nodes.filter(node => (node.parentId || "__root__") === parent).sort((a, b) => a.order - b.order).forEach((node, index) => { node.order = index; });
}

function audiencePath(source, target) {
  return hierarchyPath(source, target);
}

function decodeSource(value) {
  const binary = atob(value); const bytes = Uint8Array.from(binary, char => char.charCodeAt(0)); return new TextDecoder().decode(bytes);
}

function cssEscape(value) { return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }
function centerOf(layout) { return { x: layout.x + layout.width / 2, y: layout.y + layout.height / 2 }; }
function distanceToCenter(layout, point) { const center = centerOf(layout); return Math.hypot(center.x - point.x, center.y - point.y); }
function layoutCenter(layout, view) { const center = centerOf(layout); return { x: center.x * view.scale + view.x, y: center.y * view.scale + view.y }; }
function rectDistance(rect, point) { return Math.hypot(rect.left + rect.width / 2 - point.x, rect.top + rect.height / 2 - point.y); }
function visibleRectRatio(rect, viewportRect) {
  const width = Math.max(0, Math.min(rect.right, viewportRect.right) - Math.max(rect.left, viewportRect.left));
  const height = Math.max(0, Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top));
  return width * height / Math.max(1, rect.width * rect.height);
}
