import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import {
  canvasDataPaths,
  escapeAttributeValue,
  normalizeText,
  prototypeNameFromPath,
  readJson,
  readUtf8,
  sha256,
  shortHash,
  slug,
  writeJson
} from "./common.mjs";
import { createEdge, createNode, normalizeManifest, validateManifest } from "./manifest-v2.mjs";
import { extractStaticPrototypeModel } from "./static-js.mjs";

const STATUS_WORDS = /待办|待审核|审核中|审核通过|审核不通过|不通过|已退回|已完成|办理中|待复核|通过|驳回|草稿|已发布|已停用|启用中|未处理|处理中/;
const PAGE_CLASS = /(^|\s)(page|screen|view|module-page|mobile-page|page-section|content-page)(\s|$)/i;
const OVERLAY_CLASS = /drawer|modal|dialog|sheet|popover|overlay|layer/i;
const HUMAN_TEXT = /[\u3400-\u9fffA-Za-z]/;

export function analyzePrototype(sourceFile, options = {}) {
  const html = readUtf8(sourceFile);
  const sourceHash = sha256(html);
  const paths = canvasDataPaths(sourceFile, sourceHash);
  const { document } = parseHTML(html);
  const staticModel = extractStaticPrototypeModel(document);
  const removedNavigationNames = extractRemovedNavigationNames(html);
  const platform = detectPlatform(document, html, sourceFile);
  const name = detectPrototypeName(document, sourceFile);
  const candidates = [];
  const candidateKeys = new Set();
  const warnings = [];
  const unresolved = [];
  const sourceSignals = [];
  warnings.push(...staticModel.warnings);

  const add = input => {
    const scope = normalizeText(input.scope);
    const selector = input.selector || (input.element ? stableSelector(document, input.element) : null);
    const key = scope || selector || `${input.type}:${input.title}`;
    if (!key || candidateKeys.has(key)) return null;
    const title = normalizeText(input.title || titleForElement(document, input.element), input.type === "page" ? "未命名页面" : "未命名交互");
    if (!HUMAN_TEXT.test(title) || title.length > 80) return null;
    const candidate = {
      key,
      element: input.element || null,
      type: input.type || "page",
      typeLabel: input.typeLabel || null,
      title,
      scope: scope || null,
      selector,
      target: input.target || (input.element ? locatorForElement(document, input.element) : { selector }),
      actions: input.actions || [],
      confidence: input.confidence ?? 0.7,
      evidence: input.evidence || [],
      source: input.source || "analysis",
      parentKey: input.parentKey || null
    };
    candidates.push(candidate);
    candidateKeys.add(key);
    return candidate;
  };

  for (const element of document.querySelectorAll("[data-proto-scope], [data-zann-scope], [data-zmann-scope]")) {
    const scope = element.getAttribute("data-proto-scope") || element.getAttribute("data-zann-scope") || element.getAttribute("data-zmann-scope");
    const type = typeFromScope(scope, element);
    add({
      element,
      type,
      scope,
      title: titleForElement(document, element, scope),
      confidence: 0.98,
      evidence: [`显式作用域 ${scope}`],
      source: "explicit-contract"
    });
  }
  if (candidates.length) sourceSignals.push(`识别到 ${candidates.length} 个显式作用域。`);

  const pageSelector = [
    "[data-mobile-page]",
    "[data-page-scope]",
    "[data-page-id]",
    "[data-page-key]",
    "main[data-page]",
    "section[data-view]",
    "[data-view][class*='page']"
  ].join(",");
  for (const element of document.querySelectorAll(pageSelector)) {
    const scope = element.getAttribute("data-proto-scope") || element.getAttribute("data-zann-scope") || element.getAttribute("data-zmann-scope") || pageScope(element);
    add({
      element,
      type: "page",
      scope,
      title: titleForElement(document, element, scope),
      confidence: element.hasAttribute("data-mobile-page") || element.hasAttribute("data-page-scope") ? 0.9 : 0.76,
      evidence: [`页面属性 ${firstAttribute(element, ["data-mobile-page", "data-page-scope", "data-page-id", "data-page-key", "data-view", "data-page"])[0] || "class"}`]
    });
  }
  for (const element of document.querySelectorAll("main, section, article")) {
    if (!PAGE_CLASS.test(element.getAttribute("class") || "")) continue;
    const heading = titleForElement(document, element);
    if (!heading) continue;
    add({ element, type: "page", scope: pageScope(element), title: heading, confidence: 0.58, evidence: ["页面类名与标题启发式识别"] });
  }

  for (const page of staticModel.pages) {
    if (removedNavigationNames.has(page.title)) continue;
    add({
      type: "page",
      title: page.title,
      scope: page.scope,
      selector: page.targetSelector,
      target: {
        selector: page.targetSelector,
        selectors: [page.targetSelector, `[data-page="${escapeAttributeValue(page.id.split("::").at(-1))}"]`].filter(Boolean),
        locator: { tag: "", role: "", text: page.title, attributes: {} }
      },
      actions: page.actions,
      confidence: 0.92,
      evidence: [`JavaScript 导航数据模型${page.moduleId ? `，模块 ${page.moduleId}` : ""}`],
      source: "script-ast",
      parentKey: page.parentId
        ? `${String(page.parentId).includes("::") ? "navigation" : "module"}:${page.parentId}`
        : page.moduleId ? `module:${page.moduleId}` : null
    });
  }
  for (const navigation of staticModel.navigation || []) {
    add({
      type: "navigation",
      title: navigation.title,
      scope: `navigation:${navigation.id}`,
      selector: null,
      actions: navigation.actions,
      confidence: 0.9,
      evidence: ["JavaScript 多级导航数据模型"],
      source: "script-ast",
      parentKey: navigation.parentId
        ? `${String(navigation.parentId).includes("::") ? "navigation" : "module"}:${navigation.parentId}`
        : navigation.moduleId ? `module:${navigation.moduleId}` : null
    });
  }
  for (const module of staticModel.modules || []) {
    if (removedNavigationNames.has(module.title)) continue;
    add({
      type: "navigation",
      title: module.title,
      scope: `module:${module.id}`,
      selector: null,
      actions: [module.action],
      confidence: 0.94,
      evidence: ["JavaScript 顶层导航数据模型"],
      source: "script-ast"
    });
  }
  if (staticModel.pages.length) sourceSignals.push(`从 JavaScript 导航数据模型识别到 ${staticModel.pages.length} 个页面。`);

  const roleTabs = document.querySelectorAll('[role="tab"], [data-list-tab], [data-detail-tab], [data-tab]');
  for (const element of roleTabs) {
    const title = titleForElement(document, element);
    const controls = element.getAttribute("aria-controls");
    const controlled = controls ? document.getElementById(controls) : null;
    const explicitScope = controlled?.getAttribute("data-proto-scope") || controlled?.getAttribute("data-zann-scope") || controlled?.getAttribute("data-zmann-scope") || element.getAttribute("data-proto-scope") || element.getAttribute("data-zann-scope") || element.getAttribute("data-zmann-scope");
    const status = STATUS_WORDS.test(title);
    if (!status && !explicitScope && !controls) continue;
    const selector = stableSelector(document, element);
    const tabIdentity = attributeValue(element) || controls || title;
    add({
      element: controlled || element,
      type: "tab",
      scope: `tab:${slug(tabIdentity, "tab")}`,
      selector: controlled ? stableSelector(document, controlled) : selector,
      title,
      actions: selector ? [{ type: "click", ...locatorForElement(document, element), delay: 120 }] : [],
      confidence: explicitScope ? 0.9 : status ? 0.78 : 0.63,
      evidence: [status ? `业务状态文字 Tab${explicitScope ? `，目标 ${explicitScope}` : ""}` : "具有独立受控面板的 Tab"]
    });
  }

  for (const element of document.querySelectorAll('[role="dialog"], [aria-modal="true"], .drawer, .modal, .dialog')) {
    const scopedAncestor = element.closest?.("[data-proto-scope], [data-zann-scope], [data-zmann-scope]");
    if (scopedAncestor && scopedAncestor !== element) continue;
    const scope = element.getAttribute("data-proto-scope") || element.getAttribute("data-zann-scope") || element.getAttribute("data-zmann-scope") || overlayScope(element);
    const type = typeFromScope(scope, element);
    const selector = stableSelector(document, element);
    const trigger = triggerForElement(document, element);
    add({
      element,
      type,
      scope,
      selector,
      title: titleForElement(document, element, scope),
      actions: trigger
        ? [{ type: "click", ...locatorForElement(document, trigger), delay: 120 }]
        : [{ type: "show-target", ...locatorForElement(document, element) }],
      confidence: element.hasAttribute("data-proto-scope") || element.hasAttribute("data-zann-scope") || element.hasAttribute("data-zmann-scope") ? 0.96 : trigger ? 0.8 : 0.6,
      evidence: [trigger ? "Dialog 与真实入口关联" : "Dialog 结构启发式识别"]
    });
  }

  const literalPages = extractDynamicPageNames(html);
  const structuredPageKeys = new Set(staticModel.pages.flatMap(page => [page.id, page.title]));
  for (const title of literalPages) {
    if (removedNavigationNames.has(title) || structuredPageKeys.has(title)) continue;
    const selector = `[data-page="${escapeAttributeValue(title)}"]`;
    add({
      type: "page",
      title,
      scope: `page:${slug(title, "page")}`,
      selector: null,
      actions: [{
        type: "click",
        selector,
        selectors: [selector],
        locator: { tag: "", role: "", text: title, attributes: { "data-page": title } },
        delay: 120
      }],
      confidence: 0.64,
      evidence: ["JavaScript 状态或导航文字识别"],
      source: "script-heuristic"
    });
  }

  if (!candidates.some(candidate => candidate.type === "page")) {
    add({
      element: document.body,
      type: "page",
      title: name,
      scope: "page:default",
      selector: "body",
      confidence: 0.4,
      evidence: ["未识别到明确页面容器，建立待复核主页面"],
      source: "analysis-fallback"
    });
    warnings.push("未识别到明确页面容器，已建立待复核主页面承接下钻交互。");
  }

  if (!candidates.length) {
    add({
      element: document.body,
      type: "page",
      title: name,
      scope: "page:default",
      selector: "body",
      confidence: 0.4,
      evidence: ["未识别到多页面，回退为单页面"]
    });
    warnings.push("未识别到明确页面结构，已回退为单页面节点。");
  }

  assignParents(document, candidates, unresolved);
  const { dimensions, profiles } = detectProfiles(document, staticModel);
  if (staticModel.profiles.length) sourceSignals.push(`从 JavaScript 身份数据模型识别到 ${staticModel.profiles.length} 个有效用户类型。`);
  const profileIds = profiles.map(profile => profile.id);
  const groups = [{ id: "group-main", name: "页面结构", collapsed: false }];
  const contentNodes = candidates.map(candidate => createNode({
    id: `node-${candidate.type}-${shortHash(candidate.key, 10)}`,
    type: candidate.type,
    typeLabel: candidate.typeLabel,
    title: candidate.title,
    descriptionHtml: descriptionForCandidate(candidate),
    descriptionSource: "analysis-draft",
    profileIds,
    groupId: "group-main",
    parentId: null,
    scope: candidate.scope,
    target: candidate.target || { selector: candidate.selector },
    actions: candidate.actions,
    evidence: candidate.evidence,
    confidence: candidate.confidence,
    source: candidate.source
  }));
  const startNode = createNode({
    id: `node-start-${shortHash(paths.prototypeKey, 10)}`,
    type: "start",
    title: name,
    descriptionHtml: `<p>${name}的故事起点，可继续添加导航、页面、情形或其他未关联节点。</p>`,
    profileIds,
    groupId: "group-main",
    confidence: 1,
    evidence: ["按原型名称生成系统起点"],
    source: "analysis"
  });
  const nodes = [startNode, ...contentNodes];
  const byKey = new Map(candidates.map((candidate, index) => [candidate.key, contentNodes[index]]));
  const edges = [];
  candidates.forEach((candidate, index) => {
    const node = contentNodes[index];
    const requestedParent = candidate.parentKey && byKey.has(candidate.parentKey) ? byKey.get(candidate.parentKey) : null;
    const detail = isDetailType(candidate.type);
    const requestedParentAllowed = requestedParent && (!detail || isDetailParentType(requestedParent.type));
    const fallbackCandidate = detail && !requestedParentAllowed ? fallbackDetailParent(candidates, candidate, index) : null;
    const parent = requestedParentAllowed ? requestedParent : fallbackCandidate ? byKey.get(fallbackCandidate.key) : startNode;
    node.parentId = parent.id;
    node.order = edges.filter(edge => edge.source === parent.id && edge.type === "hierarchy").length;
    edges.push(createEdge(parent.id, node.id, "hierarchy"));
  });
  profiles.forEach(profile => { profile.visibleNodeIds = nodes.map(node => node.id); });

  for (const node of nodes) {
    if (node.confidence < 0.65) warnings.push(`低置信度节点：${node.title}`);
    if (!["start", "page", "navigation", "scenario"].includes(node.type) && !node.parentId) unresolved.push({ nodeId: node.id, title: node.title, reason: "未确认所属页面" });
  }
  const average = nodes.reduce((sum, node) => sum + node.confidence, 0) / nodes.length;
  let manifest = normalizeManifest({
    format: "prototype-canvas@1",
    prototype: {
      key: paths.prototypeKey,
      name,
      platform,
      sourcePath: path.resolve(sourceFile),
      sourceHash,
      generatedAt: new Date().toISOString(),
      viewport: platform === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 }
    },
    dimensions,
    profiles,
    groups,
    nodes,
    edges,
    snapshots: {},
    viewState: {},
    analysis: {
      confidenceSummary: {
        average: Number(average.toFixed(3)),
        high: nodes.filter(node => node.confidence >= 0.85).length,
        medium: nodes.filter(node => node.confidence >= 0.65 && node.confidence < 0.85).length,
        low: nodes.filter(node => node.confidence < 0.65).length
      },
      warnings: [...new Set(warnings)],
      unresolved,
      sourceSignals
    }
  });
  const targetManifestPath = options.manifestPath || paths.manifestPath;
  if (options.preservePrevious !== false && fs.existsSync(targetManifestPath)) {
    const previous = normalizeManifest(readJson(targetManifestPath));
    if (previous.prototype.sourceHash === sourceHash) manifest = mergePreviousManifest(manifest, previous);
  }
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new Error(`Manifest 生成失败：\n${validation.errors.join("\n")}`);
  if (options.write !== false) writeJson(targetManifestPath, manifest);
  return { manifest, manifestPath: targetManifestPath, validation };
}

function mergePreviousManifest(next, previous) {
  const deletedNodeIds = new Set(previous.viewState?.deletedNodeIds || []);
  const deletedProfileIds = new Set(previous.viewState?.deletedProfileIds || []);
  next.nodes = next.nodes.filter(node => !deletedNodeIds.has(node.id));
  next.profiles = next.profiles.filter(profile => !deletedProfileIds.has(profile.id));
  next.edges = next.edges.filter(edge => !deletedNodeIds.has(edge.source) && !deletedNodeIds.has(edge.target));
  next.viewState.deletedNodeIds = [...deletedNodeIds];
  next.viewState.deletedProfileIds = [...deletedProfileIds];
  const previousNodes = new Map(previous.nodes.map(node => [node.id, node]));
  const previousNodeIds = new Set(previous.nodes.map(node => node.id));
  const nextNodeIds = new Set(next.nodes.map(node => node.id));
  const newNodeIds = next.nodes.filter(node => !previousNodeIds.has(node.id)).map(node => node.id);
  for (const node of next.nodes) {
    const old = previousNodes.get(node.id);
    if (!old) continue;
    node.layouts = old.layouts || node.layouts;
    node.descriptionHtml = old.descriptionHtml || node.descriptionHtml;
    node.descriptionSource = old.descriptionSource || node.descriptionSource;
    node.collapsed = old.collapsed;
    node.order = old.order;
    if (old.userEdited) {
      node.type = old.type;
      node.typeLabel = old.typeLabel;
      node.title = old.title;
      node.profileIds = old.profileIds;
      node.bindings = old.bindings;
      node.userEdited = true;
    }
    if ((old.evidence || []).includes("localhost 用户操作定位")) {
      node.title = old.title;
      node.target = old.target;
      node.actions = old.actions;
      node.confidence = old.confidence;
      node.evidence = old.evidence;
    }
  }
  for (const old of previous.nodes.filter(node => node.source === "user" && !nextNodeIds.has(node.id))) {
    next.nodes.push(old);
    nextNodeIds.add(old.id);
  }
  const previousProfiles = new Map(previous.profiles.map(profile => [profile.id, profile]));
  for (const profile of next.profiles) {
    const old = previousProfiles.get(profile.id);
    if (!old) continue;
    if (old.userEdited) {
      profile.name = old.name;
      profile.attributes = old.attributes;
      profile.userEdited = true;
    }
    const retained = (old.visibleNodeIds || []).filter(id => nextNodeIds.has(id));
    profile.visibleNodeIds = [...new Set([...retained, ...newNodeIds])];
  }
  for (const profile of previous.profiles.filter(item => item.source === "user" && !next.profiles.some(nextProfile => nextProfile.id === item.id))) {
    next.profiles.push(profile);
  }
  const previousDimensions = new Map(previous.dimensions.map(dimension => [dimension.id, dimension]));
  next.dimensions = next.dimensions.map(dimension => previousDimensions.get(dimension.id)?.userEdited ? previousDimensions.get(dimension.id) : dimension);
  for (const dimension of previous.dimensions.filter(item => item.source === "user" && !next.dimensions.some(nextDimension => nextDimension.id === item.id))) {
    next.dimensions.push(dimension);
  }
  const validNodeIds = new Set(next.nodes.map(node => node.id));
  const userEdges = previous.edges.filter(edge => edge.sourceKind === "user" && validNodeIds.has(edge.source) && validNodeIds.has(edge.target));
  const userEdgeTargets = new Set(userEdges.filter(edge => edge.type === "hierarchy").map(edge => edge.target));
  next.edges = [...next.edges.filter(edge => !userEdgeTargets.has(edge.target)), ...userEdges]
    .filter((edge, index, list) => list.findIndex(item => item.id === edge.id) === index);
  const nextProfileIds = new Set(next.profiles.map(profile => profile.id));
  if (!nextProfileIds.size) nextProfileIds.add("all");
  next.snapshots = Object.fromEntries(Object.entries(previous.snapshots || {}).filter(([key, snapshot]) => {
    const [nodeId, profileId] = key.split("::");
    return nextNodeIds.has(nodeId) && nextProfileIds.has(profileId) && snapshot.sourceHash === next.prototype.sourceHash;
  }));
  const assetHashes = new Set(Object.values(next.snapshots).map(snapshot => snapshot.assetHash || snapshot.hash).filter(Boolean));
  next.snapshotAssets = Object.fromEntries(Object.entries(previous.snapshotAssets || {}).filter(([hash]) => assetHashes.has(hash)));
  next.audience = previous.audience || next.audience;
  next.canvases = previous.canvases || next.canvases;
  const previousCanvasByProfile = new Map(previous.profiles.map(profile => [profile.id, profile.canvasId]));
  for (const profile of next.profiles) profile.canvasId = previousCanvasByProfile.get(profile.id) || profile.canvasId;
  next.viewState = previous.viewState || next.viewState;
  return normalizeManifest(next);
}

function detectPlatform(document, html, sourceFile) {
  const declared = document.querySelector("[data-proto-platform]")?.getAttribute("data-proto-platform");
  if (declared === "mobile" || declared === "web") return declared;
  if (document.querySelector("[data-mobile-app], .mobile-app, .phone-shell") || /移动端|mobile/i.test(sourceFile)) return "mobile";
  if (/width\s*=\s*device-width/i.test(html) && /max-width\s*:\s*(390|414|430)px/i.test(html)) return "mobile";
  return "web";
}

function detectPrototypeName(document, sourceFile) {
  const title = normalizeText(document.querySelector("title")?.textContent);
  return title && title.length <= 80 ? title : prototypeNameFromPath(sourceFile);
}

function typeFromScope(scope = "", element) {
  const prefix = String(scope).split(":", 1)[0].toLowerCase();
  if (["page", "tab", "drawer", "modal", "dialog", "sheet", "popover", "overlay", "step", "state"].includes(prefix)) return prefix;
  const classes = element?.getAttribute("class") || "";
  if (/drawer/i.test(classes)) return "drawer";
  if (/sheet/i.test(classes)) return "sheet";
  if (/popover/i.test(classes)) return "popover";
  if (/overlay|layer/i.test(classes)) return "overlay";
  if (/modal/i.test(classes)) return "modal";
  if (/dialog|overlay|layer/i.test(classes) || element?.getAttribute("role") === "dialog") return "dialog";
  return "page";
}

function pageScope(element) {
  const [name, value] = firstAttribute(element, ["data-mobile-page", "data-page-scope", "data-page-id", "data-page-key", "data-view", "data-page"]);
  return value ? `page:${slug(value, "page")}` : null;
}

function overlayScope(element) {
  const id = element.getAttribute("id");
  const type = typeFromScope("", element);
  return `${type}:${slug(id || titleForElement(element.ownerDocument, element), type)}`;
}

function firstAttribute(element, names) {
  for (const name of names) {
    const value = element?.getAttribute?.(name);
    if (value) return [name, value];
  }
  return [null, null];
}

function attributeValue(element) {
  const attributes = ["data-list-tab", "data-detail-tab", "data-tab", "data-page", "data-view"];
  return firstAttribute(element, attributes)[1];
}

function titleForElement(document, element, fallback = "") {
  if (!element) return humanize(fallback);
  for (const attribute of ["data-title", "aria-label", "title"]) {
    const value = normalizeText(element.getAttribute?.(attribute));
    if (value && !/关闭|close/i.test(value)) return value.slice(0, 80);
  }
  const labelledBy = element.getAttribute?.("aria-labelledby");
  if (labelledBy) {
    const label = normalizeText(document.getElementById(labelledBy)?.textContent);
    if (label) return label.slice(0, 80);
  }
  const heading = element.matches?.("h1,h2,h3,strong") ? element : element.querySelector?.("h1,h2,h3,.page-title,.modal-title,.drawer-title,.action-extra,strong");
  const headingText = normalizeText(heading?.textContent);
  if (headingText) return headingText.slice(0, 80);
  const direct = normalizeText(element.textContent);
  if (direct && direct.length <= 32) return direct;
  const [, attrValue] = firstAttribute(element, ["data-mobile-page", "data-page-scope", "data-page-id", "data-page-key", "data-view", "data-list-tab", "data-detail-tab"]);
  return humanize(attrValue || element.id || fallback);
}

function humanize(value) {
  return normalizeText(String(value || "")
    .replace(/^(page|tab|drawer|modal|dialog|sheet|popover|state):/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2"), "未命名页面");
}

function locatorForElement(document, element) {
  if (!element?.getAttribute) return { selector: null, selectors: [], locator: { tag: "", role: "", text: "", attributes: {} } };
  const selector = stableSelector(document, element);
  const selectors = [];
  const attributes = {};
  if (selector) selectors.push(selector);
  for (const name of [
    "data-testid", "data-test", "data-qa", "data-proto-scope", "data-zann-scope", "data-zmann-scope",
    "data-page-scope", "data-mobile-page", "data-page", "data-module", "data-center", "data-route",
    "data-view", "data-tab", "data-list-tab", "data-detail-tab", "data-action", "data-role",
    "aria-controls", "aria-label", "name", "href"
  ]) {
    const value = element.getAttribute(name);
    if (!value || value.length > 180 || value.includes("${")) continue;
    attributes[name] = value;
    const candidate = `[${name}="${escapeAttributeValue(value)}"]`;
    if (!selectors.includes(candidate)) selectors.push(candidate);
  }
  return {
    selector: selector || selectors[0] || null,
    selectors,
    locator: {
      tag: element.localName || "",
      role: element.getAttribute("role") || (element.localName === "button" ? "button" : element.localName === "a" ? "link" : ""),
      text: normalizeText(element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent).slice(0, 160),
      attributes
    }
  };
}

function stableSelector(document, element) {
  if (!element?.getAttribute) return null;
  const scope = element.getAttribute("data-proto-scope");
  if (scope) return `[data-proto-scope="${escapeAttributeValue(scope)}"]`;
  const zannScope = element.getAttribute("data-zann-scope");
  if (zannScope) return `[data-zann-scope="${escapeAttributeValue(zannScope)}"]`;
  const zmannScope = element.getAttribute("data-zmann-scope");
  if (zmannScope) return `[data-zmann-scope="${escapeAttributeValue(zmannScope)}"]`;
  if (element.id) return `#${cssIdentifier(element.id)}`;
  for (const name of ["data-mobile-page", "data-page-scope", "data-page-id", "data-page-key", "data-page", "data-module", "data-center", "data-route", "data-view", "data-tab", "data-list-tab", "data-detail-tab", "data-open-layer", "data-open-sheet", "data-zmann-scope-route", "data-action", "data-role"]) {
    const value = element.getAttribute(name);
    if (!value || value.includes("${")) continue;
    const selector = `[${name}="${escapeAttributeValue(value)}"]`;
    try {
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch {}
  }
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    const selector = `${element.localName}[aria-label="${escapeAttributeValue(ariaLabel)}"]`;
    try {
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch {}
  }
  const classes = (element.getAttribute("class") || "").split(/\s+/).filter(Boolean).filter(item => !/active|selected|open|show|hidden|current/.test(item));
  if (classes.length) {
    const selector = `${element.localName}.${classes.slice(0, 2).map(cssIdentifier).join(".")}`;
    try {
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch {}
  }
  return null;
}

function cssIdentifier(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, match => `\\${match.codePointAt(0).toString(16)} `);
}

function triggerForElement(document, element) {
  const id = element.getAttribute("id");
  const scope = element.getAttribute("data-proto-scope") || element.getAttribute("data-zann-scope") || element.getAttribute("data-zmann-scope");
  const selectors = [];
  if (id) {
    selectors.push(`[data-open-layer="${escapeAttributeValue(id)}"]`, `[data-open-sheet="${escapeAttributeValue(id)}"]`, `[data-open-overlay="${escapeAttributeValue(id)}"]`, `[aria-controls="${escapeAttributeValue(id)}"]`, `[data-target="#${escapeAttributeValue(id)}"]`);
  }
  if (scope) selectors.push(`[data-proto-route="${escapeAttributeValue(scope)}"]`, `[data-zann-scope-route="${escapeAttributeValue(scope)}"]`, `[data-zmann-scope-route="${escapeAttributeValue(scope)}"]`);
  for (const selector of selectors) {
    try {
      const found = document.querySelector(selector);
      if (found) return found;
    } catch {}
  }
  return null;
}

function assignParents(document, candidates, unresolved) {
  const elementCandidates = candidates.filter(candidate => candidate.element);
  for (const candidate of candidates) {
    if (!candidate.element || candidate.type === "page") continue;
    let ancestor = candidate.element.parentElement;
    while (ancestor) {
      const parent = elementCandidates.find(item => item !== candidate && item.type === "page" && item.element === ancestor);
      if (parent) {
        candidate.parentKey = parent.key;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (candidate.parentKey) continue;
    const trigger = triggerForElement(document, candidate.element);
    if (trigger) {
      const parent = elementCandidates
        .filter(item => item !== candidate && item.element?.contains?.(trigger))
        .sort((a, b) => depth(b.element) - depth(a.element))[0];
      if (parent) candidate.parentKey = parent.key;
    }
    if (!candidate.parentKey) {
      candidate.unresolvedParent = true;
      unresolved.push({ title: candidate.title, reason: "需要确认所属页面" });
    }
  }
}

function fallbackDetailParent(candidates, candidate, index) {
  const pages = candidates.filter(item => item !== candidate && item.type === "page");
  if (!pages.length) return null;
  if (pages.length === 1) return pages[0];
  const triggerSelector = candidate.actions?.find(action => action.type === "click")?.selector;
  const trigger = triggerSelector ? safeQuery(candidate.element?.ownerDocument, triggerSelector) : null;
  if (trigger) {
    const containing = pages
      .filter(page => page.element?.contains?.(trigger))
      .sort((left, right) => depth(right.element) - depth(left.element))[0];
    if (containing) return containing;
  }
  const previous = candidates.slice(0, index).reverse().find(item => item.type === "page");
  return previous || pages[0];
}

function safeQuery(document, selector) {
  if (!document || !selector || selector.includes(">>>")) return null;
  try { return document.querySelector(selector); } catch { return null; }
}

function isDetailType(type) {
  return ["tab", "drawer", "modal", "dialog", "sheet", "popover", "overlay", "step", "state"].includes(type);
}

function isDetailParentType(type) {
  return ["page", "tab", "drawer", "modal", "dialog", "sheet", "popover", "overlay", "step", "state"].includes(type);
}

function depth(element) {
  let value = 0;
  for (let current = element; current; current = current.parentElement) value += 1;
  return value;
}

function extractDynamicPageNames(html) {
  const values = new Set();
  const patterns = [
    /data-page=["']([^"'$<{][^"']{0,60})["']/g,
    /state\.page\s*===?\s*["'`]([^"'`$]{1,60})["'`]/g,
    /(?<![\w])(?:page|currentPage|activePage)\s*:\s*["'`]([^"'`$]{1,60})["'`]/g,
    /case\s+["'`]([^"'`$]{1,60})["'`]\s*:/g
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const value = normalizeText(match[1]);
      if (value && HUMAN_TEXT.test(value) && /^[\p{L}\p{N}_-]+$/u.test(value) && !/^(true|false|null|undefined|all)$/i.test(value)) values.add(value);
    }
  }
  return [...values].slice(0, 120);
}

function extractRemovedNavigationNames(html) {
  const values = new Set();
  const pattern = /\.items\s*=\s*[^;\n]{0,220}\.filter\([^;\n]{0,180}?!==\s*["'`]([^"'`]{1,60})["'`]/g;
  for (const match of html.matchAll(pattern)) values.add(normalizeText(match[1]));
  return values;
}

function detectProfiles(document, staticModel = { dimensions: [], profiles: [] }) {
  const configs = [
    { id: "role", name: "角色", selectors: ["[data-role]", ".role-switch option", "select[name*='role' i] option", "select[id*='role' i] option"] },
    { id: "department", name: "部门", selectors: ["[data-department]", "[data-dept]", "select[name*='department' i] option", "select[id*='dept' i] option"] },
    { id: "organization", name: "组织", selectors: ["[data-organization]", "[data-org]"] },
    { id: "tenant", name: "租户", selectors: ["[data-tenant]"] },
    { id: "region", name: "区域", selectors: ["[data-region]"] }
  ];
  const dimensions = [];
  for (const config of configs) {
    const seen = new Map();
    for (const selector of config.selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const raw = element.getAttribute(`data-${config.id}`)
          || (config.id === "department" ? element.getAttribute("data-dept") : null)
          || (config.id === "organization" ? element.getAttribute("data-org") : null)
          || element.getAttribute("value")
          || normalizeText(element.textContent);
        const name = normalizeText(element.querySelector?.("strong")?.textContent || element.textContent || raw);
        if (!raw || !name || /选择|全部|切换/.test(name) && !element.hasAttribute(`data-${config.id}`)) continue;
        const id = slug(raw, config.id);
        if (!seen.has(id)) seen.set(id, { id, name: name.slice(0, 40), sourceValue: raw });
      }
    }
    if (seen.size) dimensions.push({ id: config.id, name: config.name, values: [...seen.values()] });
  }
  for (const staticDimension of staticModel.dimensions || []) {
    const existing = dimensions.find(item => item.id === staticDimension.id);
    if (!existing) dimensions.push(staticDimension);
    else {
      const ids = new Set(existing.values.map(item => item.id));
      existing.values.push(...staticDimension.values.filter(item => !ids.has(item.id)));
    }
  }
  if (staticModel.profiles?.length) return { dimensions, profiles: staticModel.profiles };
  if (!dimensions.length) {
    return { dimensions: [], profiles: [] };
  }
  const primary = dimensions.find(item => item.id === "role") || dimensions[0];
  const profiles = primary.values.map(value => ({
    id: `profile-${primary.id}-${value.id}`,
    name: value.name,
    attributes: { [primary.id]: value.id },
    visibleNodeIds: [],
    source: "prototype",
    confidence: dimensions.length === 1 ? 0.9 : 0.7
  }));
  return { dimensions, profiles };
}

function descriptionForCandidate(candidate) {
  const title = escapeBusinessText(candidate.title);
  const visibleTerms = candidate.element ? extractBusinessTerms(candidate.element, candidate.title) : [];
  const focus = visibleTerms.length ? `，主要涉及${visibleTerms.slice(0, 4).join("、")}` : "";
  if (candidate.type === "navigation") return `<p>用于进入“${title}”相关业务功能，帮助用户继续查看和处理该模块下的信息与任务${focus}。</p>`;
  if (["drawer", "modal", "dialog", "sheet", "popover", "overlay"].includes(candidate.type)) return `<p>用于在当前业务页面内完成“${title}”相关查看或处理，用户无需离开当前工作上下文${focus}。</p>`;
  if (["tab", "state", "step"].includes(candidate.type)) return `<p>用于呈现“${title}”对应的业务阶段或数据状态，支持用户据此继续查看和处理相关事项${focus}。</p>`;
  return `<p>用于查看和处理“${title}”相关业务信息，为用户提供当前事项所需的信息与操作入口${focus}。</p>`;
}

function extractBusinessTerms(element, title) {
  const terms = [];
  for (const item of element.querySelectorAll?.("h1,h2,h3,h4,label,button,[role=tab],th") || []) {
    const value = normalizeText(item.textContent);
    if (!value || value === title || value.length > 18 || !HUMAN_TEXT.test(value) || terms.includes(value)) continue;
    terms.push(escapeBusinessText(value));
    if (terms.length >= 6) break;
  }
  return terms;
}

function escapeBusinessText(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function typeLabel(type) {
  return { navigation: "导航", page: "页面", tab: "标签页", drawer: "抽屉", modal: "弹窗", dialog: "对话框", sheet: "底部面板", popover: "气泡浮层", overlay: "浮层", step: "表单步骤", state: "页面状态", scenario: "情形" }[type] || "页面";
}
