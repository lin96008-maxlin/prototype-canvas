const MODE_GAPS = {
  mindmap: { horizontal: 104, vertical: 28 },
  snapshot: { horizontal: 132, vertical: 44 }
};

export function hierarchyEdges(edges, canvasId = null) {
  return edges.filter(edge => edge.type === "hierarchy" && (!canvasId || edge.canvasId === canvasId));
}

export function childrenOf(nodeId, nodes, edges) {
  const allowed = new Set(nodes.map(node => node.id));
  return hierarchyEdges(edges)
    .filter(edge => edge.source === nodeId && allowed.has(edge.target))
    .map(edge => nodes.find(node => node.id === edge.target))
    .filter(Boolean)
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
}

export function subtreeIds(rootId, nodes, edges) {
  const result = [];
  const seen = new Set();
  const visit = id => {
    if (seen.has(id)) return;
    seen.add(id);
    result.push(id);
    for (const child of childrenOf(id, nodes, edges)) visit(child.id);
  };
  visit(rootId);
  return result;
}

export function visibleNodes(nodes, edges) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const hidden = new Set();
  const hideChildren = id => {
    for (const child of childrenOf(id, nodes, edges)) {
      hidden.add(child.id);
      hideChildren(child.id);
    }
  };
  for (const node of nodes) if (node.collapsed) hideChildren(node.id);
  return nodes.filter(node => byId.has(node.id) && !hidden.has(node.id));
}

export function rootNodes(nodes, edges) {
  const targets = new Set(hierarchyEdges(edges).map(edge => edge.target));
  return nodes.filter(node => !targets.has(node.id));
}

export function normalizeTree(nodes, edges) {
  const ids = new Set(nodes.map(node => node.id));
  const parentByChild = new Map();
  const valid = [];
  for (const edge of hierarchyEdges(edges)) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target || parentByChild.has(edge.target)) continue;
    if (wouldCycle(edge.source, edge.target, parentByChild)) continue;
    parentByChild.set(edge.target, edge.source);
    valid.push(edge);
  }
  for (const node of nodes) node.parentId = parentByChild.get(node.id) || null;
  renumberSiblings(nodes);
  return valid;
}

export function layoutForest(nodes, edges, mode, options = {}) {
  if (!nodes.length) return;
  const gaps = MODE_GAPS[mode] || MODE_GAPS.mindmap;
  const roots = rootNodes(nodes, edges).sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const spans = new Map();
  const span = node => {
    if (spans.has(node.id)) return spans.get(node.id);
    const layout = node.layouts[mode];
    const children = node.collapsed ? [] : childrenOf(node.id, nodes, edges);
    const childHeight = children.reduce((total, child, index) => total + span(child) + (index ? gaps.vertical : 0), 0);
    const value = Math.max(layout.height, childHeight);
    spans.set(node.id, value);
    return value;
  };
  const place = (node, centerY, x) => {
    const layout = node.layouts[mode];
    layout.x = Math.round(x);
    layout.y = Math.round(centerY - layout.height / 2);
    const children = node.collapsed ? [] : childrenOf(node.id, nodes, edges);
    if (!children.length) return;
    const total = children.reduce((sum, child, index) => sum + span(child) + (index ? gaps.vertical : 0), 0);
    let cursor = centerY - total / 2;
    const childX = layout.x + layout.width + gaps.horizontal;
    for (const child of children) {
      const childSpan = span(child);
      place(child, cursor + childSpan / 2, childX);
      cursor += childSpan + gaps.vertical;
    }
  };
  roots.forEach((root, index) => {
    const layout = root.layouts[mode];
    if (options.initialize && !layout.x && !layout.y) {
      layout.x = 100;
      layout.y = 100 + index * (span(root) + 96);
    }
    place(root, layout.y + layout.height / 2, layout.x);
  });
}

export function resolveForestOverlaps(nodes, edges, mode, preferredRootIds = []) {
  if (nodes.length < 2) return;
  const preferred = new Set(preferredRootIds);
  const roots = rootNodes(nodes, edges).sort((left, right) => {
    const preference = Number(preferred.has(right.id)) - Number(preferred.has(left.id));
    if (preference) return preference;
    const leftLayout = left.layouts[mode];
    const rightLayout = right.layouts[mode];
    return leftLayout.x - rightLayout.x || leftLayout.y - rightLayout.y || Number(left.order || 0) - Number(right.order || 0);
  });
  const placed = [];
  for (const root of roots) {
    let bounds = visibleSubtreeBounds(root.id, nodes, edges, mode);
    let attempts = 0;
    while (attempts < roots.length * 2) {
      const collision = placed.find(item => overlaps(bounds, item, 52));
      if (!collision) break;
      root.layouts[mode].y += collision.y + collision.height + 52 - bounds.y;
      layoutForest(nodes, edges, mode);
      bounds = visibleSubtreeBounds(root.id, nodes, edges, mode);
      attempts += 1;
    }
    placed.push(bounds);
  }
}

export function reorderNode(nodeId, direction, nodes, edges) {
  const node = nodes.find(item => item.id === nodeId);
  if (!node) return false;
  const siblings = nodes
    .filter(item => (item.parentId || null) === (node.parentId || null))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const index = siblings.findIndex(item => item.id === nodeId);
  const next = Math.max(0, Math.min(siblings.length - 1, index + direction));
  if (index === next) return false;
  const [moved] = siblings.splice(index, 1);
  siblings.splice(next, 0, moved);
  siblings.forEach((item, order) => { item.order = order; });
  return true;
}

export function renumberSiblings(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const key = node.parentId || "__root__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  for (const siblings of groups.values()) {
    siblings.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    siblings.forEach((node, index) => { node.order = index; });
  }
}

export function graphBounds(nodes, mode, padding = 80) {
  if (!nodes.length) return { x: -400, y: -260, width: 800, height: 520 };
  const minX = Math.min(...nodes.map(node => node.layouts[mode].x)) - padding;
  const minY = Math.min(...nodes.map(node => node.layouts[mode].y)) - padding;
  const maxX = Math.max(...nodes.map(node => node.layouts[mode].x + node.layouts[mode].width)) + padding;
  const maxY = Math.max(...nodes.map(node => node.layouts[mode].y + node.layouts[mode].height)) + padding;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function visibleSubtreeBounds(rootId, nodes, edges, mode) {
  const visibleIds = new Set();
  const visit = id => {
    visibleIds.add(id);
    const node = nodes.find(item => item.id === id);
    if (node?.collapsed) return;
    for (const child of childrenOf(id, nodes, edges)) visit(child.id);
  };
  visit(rootId);
  const branch = nodes.filter(node => visibleIds.has(node.id));
  const minX = Math.min(...branch.map(node => node.layouts[mode].x));
  const minY = Math.min(...branch.map(node => node.layouts[mode].y));
  const maxX = Math.max(...branch.map(node => node.layouts[mode].x + node.layouts[mode].width));
  const maxY = Math.max(...branch.map(node => node.layouts[mode].y + node.layouts[mode].height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function overlaps(left, right, gap) {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y;
}

function wouldCycle(source, target, parentByChild) {
  let current = source;
  while (current) {
    if (current === target) return true;
    current = parentByChild.get(current);
  }
  return false;
}
