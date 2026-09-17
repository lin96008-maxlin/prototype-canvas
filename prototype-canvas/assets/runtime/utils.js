export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeXml(value) {
  return escapeHtml(value);
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

export function textFromHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  return (template.content.textContent || "").replace(/\s+/g, " ").trim();
}

export function sanitizeRichHtml(input) {
  const allowed = new Set(["P", "BR", "H2", "H3", "STRONG", "B", "EM", "I", "U", "UL", "OL", "LI", "BLOCKQUOTE", "A"]);
  const template = document.createElement("template");
  template.innerHTML = String(input || "");
  const visit = node => {
    for (const child of [...node.children]) {
      visit(child);
      if (!allowed.has(child.tagName)) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attribute of [...child.attributes]) {
        if (child.tagName === "A" && ["href", "title", "target", "rel"].includes(attribute.name)) continue;
        child.removeAttribute(attribute.name);
      }
      if (child.tagName === "A") {
        const href = child.getAttribute("href") || "";
        if (!/^(https?:|mailto:|#)/i.test(href)) child.removeAttribute("href");
        child.setAttribute("rel", "noopener noreferrer");
        if (/^https?:/i.test(href)) child.setAttribute("target", "_blank");
      }
    }
  };
  visit(template.content);
  const output = template.innerHTML.trim();
  return output || "<p>页面说明待补充。</p>";
}

export function snapshotKey(nodeId, profileId) {
  return `${nodeId}::${profileId}`;
}

export function debounce(callback, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), wait);
  };
}

export function uniqueId(prefix = "item") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function visibleText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

