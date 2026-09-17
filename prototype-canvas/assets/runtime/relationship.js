export function nodeRect(node, mode) {
  const layout = node.layouts[mode];
  return { x: layout.x, y: layout.y, width: layout.width, height: layout.height };
}

export function anchorPoint(rect, anchor) {
  const ratio = clamp(anchor?.ratio ?? 0.5, 0, 1);
  switch (anchor?.side) {
    case "top": return { x: rect.x + rect.width * ratio, y: rect.y };
    case "bottom": return { x: rect.x + rect.width * ratio, y: rect.y + rect.height };
    case "left": return { x: rect.x, y: rect.y + rect.height * ratio };
    default: return { x: rect.x + rect.width, y: rect.y + rect.height * ratio };
  }
}

export function projectToBoundary(rect, point) {
  const candidates = [
    { side: "top", distance: Math.abs(point.y - rect.y), ratio: (point.x - rect.x) / rect.width },
    { side: "bottom", distance: Math.abs(point.y - rect.y - rect.height), ratio: (point.x - rect.x) / rect.width },
    { side: "left", distance: Math.abs(point.x - rect.x), ratio: (point.y - rect.y) / rect.height },
    { side: "right", distance: Math.abs(point.x - rect.x - rect.width), ratio: (point.y - rect.y) / rect.height }
  ].map(item => ({ ...item, ratio: clamp(item.ratio, 0, 1) }));
  candidates.sort((left, right) => left.distance - right.distance);
  return { side: candidates[0].side, ratio: candidates[0].ratio, manual: true };
}

export function closestAnchors(sourceRect, targetRect) {
  const sourceCenter = center(sourceRect);
  const targetCenter = center(targetRect);
  return {
    source: projectToBoundary(sourceRect, targetCenter),
    target: projectToBoundary(targetRect, sourceCenter)
  };
}

export function relationshipGeometry(edge, sourceRect, targetRect) {
  const automatic = closestAnchors(sourceRect, targetRect);
  const sourceAnchor = edge.anchors?.source?.manual ? edge.anchors.source : automatic.source;
  const targetAnchor = edge.anchors?.target?.manual ? edge.anchors.target : automatic.target;
  const start = anchorPoint(sourceRect, sourceAnchor);
  const end = anchorPoint(targetRect, targetAnchor);
  const distance = Math.max(70, Math.hypot(end.x - start.x, end.y - start.y));
  const sourceNormal = normal(sourceAnchor.side);
  const targetNormal = normal(targetAnchor.side);
  const sourceOffset = edge.controlOffsets?.source || { x: 0, y: 0 };
  const targetOffset = edge.controlOffsets?.target || { x: 0, y: 0 };
  const control1 = {
    x: start.x + sourceNormal.x * Math.min(180, distance * 0.34) + Number(sourceOffset.x || 0),
    y: start.y + sourceNormal.y * Math.min(180, distance * 0.34) + Number(sourceOffset.y || 0)
  };
  const control2 = {
    x: end.x + targetNormal.x * Math.min(180, distance * 0.34) + Number(targetOffset.x || 0),
    y: end.y + targetNormal.y * Math.min(180, distance * 0.34) + Number(targetOffset.y || 0)
  };
  return { start, end, control1, control2, sourceAnchor, targetAnchor };
}

export function relationshipPath(geometry) {
  const { start, end, control1, control2 } = geometry;
  return `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`;
}

export function hierarchyPath(sourceRect, targetRect) {
  const start = { x: sourceRect.x + sourceRect.width, y: sourceRect.y + sourceRect.height / 2 };
  const end = { x: targetRect.x, y: targetRect.y + targetRect.height / 2 };
  const bend = Math.max(34, Math.abs(end.x - start.x) * 0.5);
  return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`;
}

function normal(side) {
  if (side === "top") return { x: 0, y: -1 };
  if (side === "bottom") return { x: 0, y: 1 };
  if (side === "left") return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

function center(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}
