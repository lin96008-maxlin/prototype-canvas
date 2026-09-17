import { escapeXml } from "./utils.js";
import { graphBounds } from "./tree-layout.js";
import { hierarchyPath, relationshipGeometry, relationshipPath } from "./relationship.js";

const TYPE_COLORS = {
  start: ["#0b2f74", "#ffffff"], navigation: ["#dff7ff", "#075985"], page: ["#eaf2ff", "#1d4ed8"],
  tab: ["#fff6db", "#92400e"], drawer: ["#f1eafe", "#6d28d9"], modal: ["#ffe8f2", "#9d174d"],
  dialog: ["#ffe8f2", "#9d174d"], sheet: ["#e8f7f1", "#047857"], popover: ["#effbe7", "#3f6212"],
  overlay: ["#edf0ff", "#4338ca"], step: ["#e5f8f5", "#0f766e"], state: ["#fff2df", "#9a3412"], scenario: ["#eef8ff", "#0369a1"]
};

export async function exportCanvas({ manifest, nodes, edges, mode, range, viewport, format, profileId }) {
  if (!nodes?.length) throw new Error("当前画布没有可导出的节点。");
  const bounds = range === "current" ? viewport : completeBounds(nodes, edges, mode);
  const width = Math.max(1, Math.ceil(bounds.width));
  const height = Math.max(1, Math.ceil(bounds.height));
  const filename = `${safeName(manifest.prototype.name || "原型")}-${mode === "snapshot" ? "快照导图" : "思维导图"}-${range === "current" ? "当前视图" : "完整画布"}`;
  if (format === "svg") {
    const svg = buildSvg({ manifest, nodes, edges, mode, bounds, width, height, profileId });
    if ((svg.match(/data-node-id=/g) || []).length !== nodes.length) throw new Error("导出内容校验失败，请重试。");
    await download(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `${filename}.svg`);
    return { format, width, height };
  }
  const maxSide = 16384;
  const pixelRatio = Math.min(2, maxSide / Math.max(width, height));
  if (pixelRatio < .25) throw new Error("画布尺寸超出浏览器 PNG 限制，请改用 SVG 导出。");
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * pixelRatio));
  canvas.height = Math.max(1, Math.round(height * pixelRatio));
  const context = canvas.getContext("2d", { alpha: false });
  context.scale(pixelRatio, pixelRatio);
  context.fillStyle = "#f5f9ff";
  context.fillRect(0, 0, width, height);
  context.translate(-bounds.x, -bounds.y);
  drawEdges(context, nodes, edges, mode);
  const images = await decodeSnapshots(manifest, nodes, profileId);
  for (const node of nodes) drawNode(context, node, mode, images.get(node.id));
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("浏览器未能生成 PNG。");
  await download(blob, `${filename}.png`);
  return { format, width: canvas.width, height: canvas.height };
}

function drawEdges(context, nodes, edges, mode) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const edge of edges) {
    const source = byId.get(edge.source)?.layouts[mode];
    const target = byId.get(edge.target)?.layouts[mode];
    if (!source || !target) continue;
    context.save();
    if (edge.type === "hierarchy") {
      context.strokeStyle = "#4b7bec";
      context.lineWidth = 2;
      context.stroke(new Path2D(hierarchyPath(source, target)));
    } else {
      const geometry = relationshipGeometry(edge, source, target);
      context.strokeStyle = "#ef7c24";
      context.lineWidth = 2.5;
      context.setLineDash([8, 6]);
      context.stroke(new Path2D(relationshipPath(geometry)));
      context.setLineDash([]);
      drawArrow(context, geometry.control2, geometry.end, "#ef7c24");
    }
    context.restore();
  }
}

function drawNode(context, node, mode, image) {
  const layout = node.layouts[mode];
  context.save();
  context.shadowColor = "rgba(33, 77, 140, .13)";
  context.shadowBlur = 12;
  context.shadowOffsetY = 4;
  context.fillStyle = "#ffffff";
  roundedRect(context, layout.x, layout.y, layout.width, layout.height, 7);
  context.fill();
  context.shadowColor = "transparent";
  context.strokeStyle = "#8eb5f6";
  context.lineWidth = 1.5;
  context.stroke();
  const colors = TYPE_COLORS[node.type] || TYPE_COLORS.page;
  const label = node.typeLabel || "页面";
  context.font = "12px Microsoft YaHei, Segoe UI, sans-serif";
  const labelWidth = Math.min(92, Math.max(44, context.measureText(label).width + 18));
  context.fillStyle = colors[0];
  roundedRect(context, layout.x + 12, layout.y + 16, labelWidth, 26, 4);
  context.fill();
  context.fillStyle = colors[1];
  context.textBaseline = "middle";
  context.fillText(label, layout.x + 21, layout.y + 29);
  context.fillStyle = "#102344";
  context.font = "600 14px Microsoft YaHei, Segoe UI, sans-serif";
  drawEllipsis(context, node.title, layout.x + labelWidth + 22, layout.y + 29, layout.width - labelWidth - 36);
  if (mode === "snapshot" && layout.height > 80) {
    const box = { x: layout.x + 10, y: layout.y + 54, width: layout.width - 20, height: layout.height - 64 };
    context.fillStyle = "#eef4fc";
    roundedRect(context, box.x, box.y, box.width, box.height, 4);
    context.fill();
    if (image) drawContain(context, image, box);
    else {
      context.fillStyle = "#6b7f9e";
      context.font = "13px Microsoft YaHei, Segoe UI, sans-serif";
      context.textAlign = "center";
      context.fillText("快照待采集", box.x + box.width / 2, box.y + box.height / 2);
      context.textAlign = "left";
    }
  }
  context.restore();
}

async function decodeSnapshots(manifest, nodes, profileId) {
  const result = new Map();
  await Promise.all(nodes.map(async node => {
    const snapshot = manifest.snapshots?.[`${node.id}::${profileId || "all"}`] || manifest.snapshots?.[`${node.id}::all`] || manifest.snapshots?.[`${node.id}::global`];
    const uri = snapshot?.dataUri || manifest.snapshotAssets?.[snapshot?.assetHash || snapshot?.hash]?.dataUri;
    if (!uri) return;
    try {
      const response = await fetch(uri);
      const bitmap = await createImageBitmap(await response.blob());
      result.set(node.id, bitmap);
    } catch {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = uri; });
      result.set(node.id, image);
    }
  }));
  return result;
}

function buildSvg({ manifest, nodes, edges, mode, bounds, width, height, profileId }) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const edgeSvg = edges.map(edge => {
    const source = byId.get(edge.source)?.layouts[mode];
    const target = byId.get(edge.target)?.layouts[mode];
    if (!source || !target) return "";
    const path = edge.type === "hierarchy" ? hierarchyPath(source, target) : relationshipPath(relationshipGeometry(edge, source, target));
    return `<path d="${path}" fill="none" stroke="${edge.type === "hierarchy" ? "#4b7bec" : "#ef7c24"}" stroke-width="${edge.type === "hierarchy" ? 2 : 2.5}"${edge.type === "cross" ? ' stroke-dasharray="8 6" marker-end="url(#arrow)"' : ""}/>`;
  }).join("");
  const nodeSvg = nodes.map(node => {
    const layout = node.layouts[mode];
    const colors = TYPE_COLORS[node.type] || TYPE_COLORS.page;
    const label = escapeXml(node.typeLabel || "页面");
    const snapshot = manifest.snapshots?.[`${node.id}::${profileId || "all"}`] || manifest.snapshots?.[`${node.id}::all`] || manifest.snapshots?.[`${node.id}::global`];
    const uri = snapshot?.dataUri || manifest.snapshotAssets?.[snapshot?.assetHash || snapshot?.hash]?.dataUri;
    const media = mode === "snapshot" && layout.height > 80 ? `<rect x="${layout.x + 10}" y="${layout.y + 54}" width="${layout.width - 20}" height="${layout.height - 64}" rx="4" fill="#eef4fc"/>${uri ? `<image href="${escapeXml(uri)}" x="${layout.x + 10}" y="${layout.y + 54}" width="${layout.width - 20}" height="${layout.height - 64}" preserveAspectRatio="xMidYMid meet"/>` : `<text x="${layout.x + layout.width / 2}" y="${layout.y + layout.height / 2 + 20}" text-anchor="middle" fill="#6b7f9e" font-size="13">快照待采集</text>`}` : "";
    return `<g data-node-id="${escapeXml(node.id)}"><rect x="${layout.x}" y="${layout.y}" width="${layout.width}" height="${layout.height}" rx="7" fill="#fff" stroke="#8eb5f6" stroke-width="1.5"/><rect x="${layout.x + 12}" y="${layout.y + 16}" width="64" height="26" rx="4" fill="${colors[0]}"/><text x="${layout.x + 44}" y="${layout.y + 33}" text-anchor="middle" fill="${colors[1]}" font-size="12" font-family="Microsoft YaHei,Segoe UI,sans-serif">${label}</text><text x="${layout.x + 88}" y="${layout.y + 34}" fill="#102344" font-size="14" font-weight="600" font-family="Microsoft YaHei,Segoe UI,sans-serif">${escapeXml(truncate(node.title, 20))}</text>${media}</g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}"><defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#ef7c24"/></marker></defs><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="#f5f9ff"/>${legendSvg(mode, bounds)}${edgeSvg}${nodeSvg}</svg>`;
}

function completeBounds(nodes, edges, mode) {
  const base = graphBounds(nodes, mode, 58);
  let minX = base.x;
  let minY = base.y;
  let maxX = base.x + base.width;
  let maxY = base.y + base.height;
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const edge of edges.filter(edge => edge.type !== "hierarchy")) {
    const source = byId.get(edge.source)?.layouts[mode];
    const target = byId.get(edge.target)?.layouts[mode];
    if (!source || !target) continue;
    const geometry = relationshipGeometry(edge, source, target);
    for (const point of [geometry.start, geometry.control1, geometry.control2, geometry.end]) {
      minX = Math.min(minX, point.x - 18);
      minY = Math.min(minY, point.y - 18);
      maxX = Math.max(maxX, point.x + 18);
      maxY = Math.max(maxY, point.y + 18);
    }
  }
  minY -= 104;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function legendSvg(mode, bounds) {
  const x = bounds.x + 16;
  const y = bounds.y + 16;
  if (mode === "snapshot") {
    return `<g transform="translate(${x} ${y})"><rect width="286" height="76" rx="7" fill="#fff" stroke="#b9cfee"/><text x="14" y="23" fill="#102344" font-size="13" font-weight="600" font-family="Microsoft YaHei,Segoe UI,sans-serif">图例 · 页面快照</text><path d="M58 51 H82 M142 51 H166" fill="none" stroke="#4b7bec" stroke-width="2"/><g fill="#fff" stroke="#79a9ef"><rect x="14" y="34" width="44" height="32" rx="4"/><rect x="82" y="29" width="60" height="42" rx="4"/><rect x="166" y="34" width="44" height="32" rx="4"/></g><g fill="#dbeafe"><rect x="19" y="45" width="34" height="16"/><rect x="88" y="42" width="48" height="23"/><rect x="171" y="45" width="34" height="16"/></g><text x="224" y="54" fill="#60738e" font-size="11" font-family="Microsoft YaHei,Segoe UI,sans-serif">节点含原型</text></g>`;
  }
  return `<g transform="translate(${x} ${y})"><rect width="268" height="76" rx="7" fill="#fff" stroke="#b9cfee"/><text x="14" y="23" fill="#102344" font-size="13" font-weight="600" font-family="Microsoft YaHei,Segoe UI,sans-serif">图例 · 思维导图</text><path d="M58 52 C78 52 76 39 94 39 M58 52 C78 52 76 64 94 64 M132 39 H163 M132 64 H163" fill="none" stroke="#4b7bec" stroke-width="2"/><rect x="14" y="39" width="44" height="27" rx="5" fill="#1768e5"/><rect x="94" y="30" width="38" height="19" rx="4" fill="#fff" stroke="#79a9ef"/><rect x="94" y="55" width="38" height="19" rx="4" fill="#fff" stroke="#79a9ef"/><circle cx="163" cy="39" r="4" fill="#8eb5f6"/><circle cx="163" cy="64" r="4" fill="#8eb5f6"/><text x="178" y="55" fill="#60738e" font-size="11" font-family="Microsoft YaHei,Segoe UI,sans-serif">层级骨架</text></g>`;
}

function drawContain(context, image, box) {
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  context.save();
  roundedRect(context, box.x, box.y, box.width, box.height, 4);
  context.clip();
  context.drawImage(image, box.x + (box.width - width) / 2, box.y + (box.height - height) / 2, width, height);
  context.restore();
}

function drawEllipsis(context, text, x, y, maxWidth) {
  let value = String(text || "");
  while (value.length > 1 && context.measureText(value).width > maxWidth) value = `${value.slice(0, -2)}…`;
  context.fillText(value, x, y);
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function drawArrow(context, from, to, color) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(to.x, to.y);
  context.lineTo(to.x - 11 * Math.cos(angle - Math.PI / 6), to.y - 11 * Math.sin(angle - Math.PI / 6));
  context.lineTo(to.x - 11 * Math.cos(angle + Math.PI / 6), to.y - 11 * Math.sin(angle + Math.PI / 6));
  context.closePath(); context.fill();
}

function truncate(value, max) { const text = String(value || ""); return text.length > max ? `${text.slice(0, max - 1)}…` : text; }
function safeName(value) { return String(value).replace(/[\\/:*?"<>|]/g, "-"); }
async function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  await new Promise(resolve => requestAnimationFrame(resolve));
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
