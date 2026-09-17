export function createPrototypeReplayRuntime() {
  const ACTIONABLE_SELECTOR = 'button,a[href],input,select,textarea,summary,[role="button"],[role="tab"],[role="menuitem"],[role="option"],[onclick]';
  const SEMANTIC_ATTRIBUTES = [
    "data-testid", "data-test", "data-qa", "data-proto-scope", "data-zann-scope", "data-zmann-scope",
    "data-page-scope", "data-mobile-page", "data-page", "data-module", "data-center", "data-route",
    "data-view", "data-tab", "data-list-tab", "data-detail-tab", "data-key", "data-id", "data-action",
    "data-role", "data-department", "data-dept", "data-organization", "data-org", "data-tenant",
    "data-region", "data-value", "aria-controls", "aria-label", "name", "href"
  ];

  const wait = delay => new Promise(resolve => setTimeout(resolve, delay));
  const normalizeText = value => String(value || "").replace(/\s+/g, " ").trim();
  const escapeAttribute = value => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const cssEscape = value => globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, match => `\\${match}`);

  function visible(element) {
    if (!element || element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
  }

  function queryAllDeep(selector, scopeRoot = document, result = []) {
    if (!selector) return result;
    try { result.push(...scopeRoot.querySelectorAll(selector)); } catch {}
    for (const element of scopeRoot.querySelectorAll?.("*") || []) {
      if (element.shadowRoot) queryAllDeep(selector, element.shadowRoot, result);
    }
    return result;
  }

  function closestAcrossRoots(element, selector) {
    let current = element;
    while (current) {
      const match = current.closest?.(selector);
      if (match) return match;
      const root = current.getRootNode?.();
      current = root instanceof ShadowRoot ? root.host : null;
    }
    return null;
  }

  function roleOf(element) {
    const explicit = element.getAttribute?.("role");
    if (explicit) return explicit;
    if (element.matches?.("button")) return "button";
    if (element.matches?.("a[href]")) return "link";
    if (element.matches?.("select")) return "combobox";
    if (element.matches?.("input,textarea")) return "textbox";
    return "";
  }

  function selectorPath(element, scopeRoot) {
    const segments = [];
    let current = element;
    while (current && current !== scopeRoot && segments.length < 7) {
      let segment = current.localName || "div";
      const semanticClass = [...(current.classList || [])].find(name => !/^(active|open|show|selected|hover|focus|current|hidden|is-)/i.test(name));
      if (semanticClass) segment += `.${cssEscape(semanticClass)}`;
      const parent = current.parentElement;
      const siblings = parent ? [...parent.children].filter(item => item.localName === current.localName) : [];
      if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      segments.unshift(segment);
      const candidate = segments.join(" > ");
      try { if (scopeRoot.querySelectorAll(candidate).length === 1) return candidate; } catch {}
      current = parent;
    }
    return segments.join(" > ") || (element.localName || "body");
  }

  function locatorFor(element) {
    if (!element || element === document.documentElement || element === document.body) {
      return { selector: "body", selectors: ["body"], locator: { tag: "body", role: "", text: "", attributes: {} } };
    }
    const root = element.getRootNode?.() || document;
    const selectors = [];
    const attributes = {};
    const add = selector => { if (selector && !selectors.includes(selector)) selectors.push(selector); };
    if (element.id) {
      const selector = `#${cssEscape(element.id)}`;
      try { if (root.querySelectorAll(selector).length === 1) add(selector); } catch {}
    }
    for (const name of SEMANTIC_ATTRIBUTES) {
      const value = element.getAttribute?.(name);
      if (!value || value.length > 180 || value.includes("${")) continue;
      attributes[name] = value;
      add(`[${name}="${escapeAttribute(value)}"]`);
      add(`${element.localName}[${name}="${escapeAttribute(value)}"]`);
    }
    for (const attribute of [...(element.attributes || [])]) {
      if (!attribute.name.startsWith("data-") || attributes[attribute.name] != null) continue;
      if (!attribute.value || attribute.value.length > 180 || /^(active|open|selected|current|true|false)$/i.test(attribute.value)) continue;
      attributes[attribute.name] = attribute.value;
      add(`[${attribute.name}="${escapeAttribute(attribute.value)}"]`);
    }
    const localPath = selectorPath(element, root);
    add(localPath);
    const wrapped = root instanceof ShadowRoot
      ? selectors.map(selector => `${locatorFor(root.host).selector} >>> ${selector}`)
      : selectors;
    const text = normalizeText(element.getAttribute?.("aria-label") || element.getAttribute?.("title") || element.innerText || element.textContent).slice(0, 160);
    return {
      selector: wrapped[0] || localPath,
      selectors: wrapped,
      locator: { tag: element.localName || "", role: roleOf(element), text, attributes }
    };
  }

  function querySelectorDeep(selector) {
    const parts = String(selector || "").split(/\s*>>>\s*/).filter(Boolean);
    if (!parts.length) return [];
    let roots = [document];
    let matches = [];
    for (let index = 0; index < parts.length; index += 1) {
      matches = [];
      for (const root of roots) {
        try { matches.push(...root.querySelectorAll(parts[index])); } catch {}
      }
      if (index < parts.length - 1) roots = matches.map(item => item.shadowRoot).filter(Boolean);
    }
    return matches;
  }

  function locatorMatches(element, locator) {
    if (!element || !locator) return true;
    if (locator.tag && element.localName !== locator.tag) return false;
    if (locator.role && roleOf(element) !== locator.role) return false;
    const entries = Object.entries(locator.attributes || {});
    if (entries.length && !entries.some(([name, value]) => element.getAttribute?.(name) === value)) return false;
    const textIdentifiesControl = locator.text && (["button", "link", "tab", "menuitem", "option"].includes(locator.role) || ["button", "a", "summary", "option"].includes(locator.tag));
    if ((!entries.length || textIdentifiesControl) && locator.text) {
      const actual = normalizeText(element.getAttribute?.("aria-label") || element.getAttribute?.("title") || element.innerText || element.textContent);
      if (actual !== locator.text && !actual.startsWith(locator.text) && !locator.text.startsWith(actual)) return false;
    }
    return true;
  }

  function find(record, options = {}) {
    if (!record) return null;
    const descriptor = typeof record === "string" ? { selector: record } : record;
    const selectors = [...new Set([descriptor.selector, ...(descriptor.selectors || [])].filter(Boolean))];
    for (const selector of selectors) {
      const matches = querySelectorDeep(selector).filter(element => locatorMatches(element, descriptor.locator));
      const preferred = matches.find(visible) || (!options.visibleOnly ? matches[0] : null);
      if (preferred) return preferred;
    }
    const locator = descriptor.locator;
    if (!locator) return null;
    const pool = queryAllDeep(locator.tag || "*").filter(element => locatorMatches(element, locator));
    return pool.find(visible) || (!options.visibleOnly ? pool[0] : null) || null;
  }

  async function waitFor(record, options = {}) {
    const timeout = Math.max(0, Number(options.timeout ?? 2600));
    const startedAt = performance.now();
    do {
      const element = find(record, options);
      if (element) return element;
      await wait(50);
    } while (performance.now() - startedAt < timeout);
    return null;
  }

  function activate(element) {
    if (element instanceof HTMLElement) return HTMLElement.prototype.click.call(element);
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  function reveal(element) {
    if (!element) return false;
    for (let current = element; current && current !== document.documentElement;) {
      current.hidden = false;
      current.removeAttribute?.("hidden");
      current.setAttribute?.("aria-hidden", "false");
      if (current.style?.display === "none") current.style.display = "";
      if (current.style?.visibility === "hidden") current.style.visibility = "";
      const root = current.getRootNode?.();
      current = current.parentElement || (root instanceof ShadowRoot ? root.host : null);
    }
    if (element.matches?.('[role="dialog"],dialog') || /modal|drawer|popover|overlay|sheet/i.test(String(element.className))) {
      element.classList.add("open", "is-open", "active");
    }
    try { element.scrollIntoView?.({ block: "center", inline: "center" }); } catch {}
    return true;
  }

  function actionableElement(element) {
    return closestAcrossRoots(element, ACTIONABLE_SELECTOR) || element;
  }

  function activeSurface(fallback) {
    const overlays = queryAllDeep('[role="dialog"],dialog,.modal,.drawer,.popover,.overlay,.sheet')
      .filter(visible)
      .sort((left, right) => Number.parseInt(getComputedStyle(left).zIndex, 10) - Number.parseInt(getComputedStyle(right).zIndex, 10));
    if (overlays.length) return overlays.at(-1);
    const panels = queryAllDeep('[role="tabpanel"][aria-hidden="false"],[role="tabpanel"].active,[data-page].active,[data-page].is-active,.page.active,.page.is-active')
      .filter(visible);
    if (panels.length) return panels.at(-1);
    return closestAcrossRoots(fallback, "main,[role=main],[role=tabpanel]") || fallback || document.body;
  }

  function fingerprint(element) {
    const surface = activeSurface(element);
    const record = locatorFor(surface);
    return {
      ...record,
      scope: surface.getAttribute?.("data-proto-scope") || surface.getAttribute?.("data-zann-scope") || surface.getAttribute?.("data-zmann-scope") || surface.getAttribute?.("data-page-scope") || surface.getAttribute?.("data-mobile-page") || record.selector,
      text: normalizeText(surface.innerText || surface.textContent).slice(0, 160),
      title: document.title,
      visibleDialogs: queryAllDeep('[role="dialog"],dialog,.modal,.drawer,.popover,.overlay').filter(visible).map(item => locatorFor(item).selector).slice(0, 8),
      activeTabs: queryAllDeep('[role=tab][aria-selected=true],.tab.active,.tabs .active').filter(visible).map(item => normalizeText(item.textContent)).filter(Boolean).slice(0, 8)
    };
  }

  async function settle(delay = 120) {
    await wait(Math.max(40, Number(delay || 120)));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  // 界面状态判定：只描述“当前可见的界面由什么构成”，不依赖任何原型专属属性。
  const OVERLAY_SELECTOR = '[role="dialog"],dialog,[aria-modal="true"],[class*="modal"],[class*="drawer"],[class*="dialog"],[class*="overlay"],[class*="sheet"]';
  const REGION_SELECTOR = '[data-page-scope],[data-page-key],[data-mobile-page],[data-view],[role="tabpanel"],.page-scope,.page,.screen,.view,main > section,main > article';
  const CHANGE_SELECTOR = '[aria-expanded="true"],[aria-current="page"],[aria-current="step"]';
  const NON_REGION_TAGS = /^(a|b|button|i|input|label|li|option|p|select|span|strong|svg|td|textarea|th|tr|h1|h2|h3|h4)$/;

  function regionOrdinal(element) {
    const parent = element.parentElement;
    if (!parent) return 0;
    return [...parent.children].filter(item => item.localName === element.localName).indexOf(element);
  }

  function surfaceKey(element) {
    if (!element) return "";
    const explicit = element.id ? `#${element.id}` : element.getAttribute?.("data-page-scope")
      || element.getAttribute?.("data-page-key") || element.getAttribute?.("data-mobile-page")
      || element.getAttribute?.("data-view") || element.getAttribute?.("data-modal")
      || element.getAttribute?.("data-drawer") || element.getAttribute?.("data-panel") || null;
    if (explicit) return String(explicit);
    const classToken = [...(element.classList || [])].filter(name => !/^(active|open|show|selected|current|hidden|is-)/i.test(name)).slice(0, 2).join(".");
    return `${element.localName}${classToken ? `.${classToken}` : ""}:${regionOrdinal(element)}`;
  }

  function areaOf(element) {
    const rect = element.getBoundingClientRect();
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function isShell(element) {
    return element === document.body || element === document.documentElement
      || [...(element.attributes || [])].some(attribute => attribute.name.startsWith("data-shell"));
  }

  function overlayCandidates() {
    return queryAllDeep(OVERLAY_SELECTOR).filter(visible).sort((left, right) => areaOf(right) - areaOf(left));
  }

  function regionCandidates() {
    return queryAllDeep(REGION_SELECTOR)
      .filter(visible)
      .filter(element => !NON_REGION_TAGS.test(element.localName))
      .filter(element => areaOf(element) > 0);
  }

  function surfaceState() {
    const overlays = overlayCandidates().map(surfaceKey).slice(0, 6);
    const regions = regionCandidates().map(surfaceKey).slice(0, 12);
    const expanded = queryAllDeep(CHANGE_SELECTOR).filter(visible).map(surfaceKey).slice(0, 6);
    const activeTabs = queryAllDeep('[role=tab][aria-selected=true],.tab.active,.tabs .active').filter(visible).map(item => normalizeText(item.textContent)).filter(Boolean).slice(0, 8);
    const host = activeSurface(document.body);
    const text = normalizeText(host?.innerText || host?.textContent || "").slice(0, 160);
    return { overlays, regions, expanded, activeTabs, text, key: JSON.stringify([overlays, regions, expanded, activeTabs, text]) };
  }

  function sameSurface(left, right) {
    if (!left || !right) return false;
    return left.key === right.key;
  }

  // 给用户看的简短页面名，用于定位时提示“当前关联到哪个页面”。
  function labelFor(element) {
    if (!element) return "";
    const heading = element.querySelector?.("h1,h2,h3,[data-page-titlebar] h1,.page-title,.modal-title,.drawer-title,.overlay-title");
    return normalizeText(
      heading?.textContent
      || element.getAttribute?.("aria-label")
      || element.getAttribute?.("data-page-scope")
      || element.getAttribute?.("data-page-key")
      || element.getAttribute?.("data-mobile-page")
      || element.id
      || ""
    ).slice(0, 40);
  }

  // 目标页面按“这次操作把界面变成了什么”认定，优先本次新出现的容器，其次包含点击位置的最具体容器。
  function locateTarget(element, before) {
    const beforeOverlays = new Set(before?.overlays || []);
    const overlays = overlayCandidates();
    const appearedOverlay = overlays.find(item => !beforeOverlays.has(surfaceKey(item)));
    if (appearedOverlay) return appearedOverlay;
    if (overlays.length) return overlays[0];
    const beforeRegions = new Set(before?.regions || []);
    const regions = regionCandidates();
    const appeared = regions.filter(item => !beforeRegions.has(surfaceKey(item)));
    const containing = regions.filter(item => item === element || item.contains(element));
    const pool = (appeared.length ? appeared : containing.length ? containing : []).filter(item => !isShell(item));
    if (pool.length) return pool.sort((left, right) => areaOf(left) - areaOf(right))[0];
    return closestAcrossRoots(element, "main,[role=main],[role=tabpanel]") || element || document.body;
  }

  async function applyProfile(profile, dimensions = [], options = {}) {
    const applied = [];
    const unresolved = [];
    for (const [dimensionId, valueId] of Object.entries(profile?.attributes || {})) {
      const dimension = dimensions.find(item => item.id === dimensionId);
      const value = dimension?.values?.find(item => item.id === valueId);
      const rawValues = [...new Set([profile?.sourceAttributes?.[dimensionId], value?.sourceValue, valueId, value?.name].filter(Boolean).map(String))];
      const attributeNames = [`data-${dimensionId}`];
      if (dimensionId === "role") attributeNames.push("data-role");
      if (dimensionId === "department") attributeNames.push("data-dept");
      if (dimensionId === "organization") attributeNames.push("data-org");
      const findControl = () => {
        for (const rawValue of rawValues) {
          const selectors = attributeNames.map(name => `[${name}="${escapeAttribute(rawValue)}"]`);
          const semanticTarget = find({ selectors }, { visibleOnly: false });
          if (semanticTarget) return semanticTarget;
        }
        const selects = queryAllDeep("select");
        const matching = [];
        for (const select of selects) {
          for (const option of [...select.options]) {
            if (rawValues.includes(String(option.value)) || rawValues.includes(normalizeText(option.textContent))) matching.push({ select, option });
          }
        }
        const dimensionPattern = dimensionId === "role" ? /role|角色/i : dimensionId === "department" ? /department|dept|部门/i : new RegExp(dimensionId, "i");
        const preferred = matching.find(item => dimensionPattern.test(`${item.select.id} ${item.select.name} ${item.select.className} ${item.select.getAttribute("aria-label") || ""}`)) || (matching.length === 1 ? matching[0] : null);
        return preferred?.option || null;
      };
      let target = findControl();
      if (!target) {
        const waitStartedAt = performance.now();
        const waitTimeout = Math.min(1400, Number(options.timeout || 2600));
        do {
          await wait(50);
          target = findControl();
        } while (!target && performance.now() - waitStartedAt < waitTimeout);
      }
      if (!target) {
        unresolved.push({ dimensionId, valueId });
        continue;
      }
      if (target.localName === "option") {
        const select = target.closest("select");
        if (select) {
          select.value = target.value;
          select.dispatchEvent(new Event("input", { bubbles: true }));
          select.dispatchEvent(new Event("change", { bubbles: true }));
          applied.push({ dimensionId, valueId, selector: locatorFor(select).selector });
        }
      } else {
        activate(target);
        applied.push({ dimensionId, valueId, selector: locatorFor(target).selector });
      }
      await settle(120);
    }
    return { applied, unresolved };
  }

  async function replay(actions = [], target = null, options = {}) {
    const completedActions = [];
    let lastElement = null;
    await applyProfile(options.profile, options.dimensions, options);
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      try {
        if (!action?.type) continue;
        if (action.type === "wait-visible") {
          const element = await waitFor(action, { timeout: action.timeout || options.timeout, visibleOnly: true });
          if (!element) throw new Error(`等待入口超时 ${action.selector || "(未命名入口)"}`);
          lastElement = element;
          completedActions.push({ ...action, ...locatorFor(element) });
          continue;
        }
        const element = await waitFor(action, { timeout: action.timeout || options.timeout, visibleOnly: action.type !== "show-target" });
        if (!element) throw new Error(`找不到交互入口 ${action.selector || "(未命名入口)"}`);
        const resolved = locatorFor(element);
        if (action.type === "click") activate(element);
        else if (action.type === "change") {
          element.value = action.value ?? "";
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (action.type === "show-target") reveal(element);
        lastElement = element;
        const completed = { ...action, ...resolved };
        completedActions.push(completed);
        options.onAction?.(completed, index);
        await settle(action.delay || 120);
      } catch (error) {
        error.stepIndex = index;
        error.completedActions = completedActions;
        throw error;
      }
    }
    let targetElement = target?.selector || target?.selectors?.length || target?.locator
      ? await waitFor(target, { timeout: options.timeout, visibleOnly: false })
      : activeSurface(lastElement);
    if (!targetElement && completedActions.length && options.allowSurfaceFallback) targetElement = activeSurface(lastElement);
    if (!targetElement) {
      const error = new Error(`找不到关联页面 ${target?.selector || "(未命名目标)"}`);
      error.stepIndex = actions.length;
      error.completedActions = completedActions;
      throw error;
    }
    reveal(targetElement);
    await document.fonts?.ready?.catch?.(() => {});
    await Promise.all([...document.images].filter(image => !image.complete).map(image => new Promise(resolve => {
      const done = () => resolve();
      image.addEventListener("load", done, { once: true });
      image.addEventListener("error", done, { once: true });
      setTimeout(done, 1200);
    })));
    await settle(100);
    return { completedActions, target: locatorFor(targetElement), fingerprint: fingerprint(targetElement) };
  }

  return {
    visible,
    queryAllDeep,
    closestAcrossRoots,
    actionableElement,
    activeSurface,
    locatorFor,
    surfaceKey,
    surfaceState,
    sameSurface,
    locateTarget,
    labelFor,
    find,
    waitFor,
    activate,
    reveal,
    fingerprint,
    applyProfile,
    replay
  };
}
