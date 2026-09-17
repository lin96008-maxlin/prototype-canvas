import { parse } from "acorn";
import { escapeAttributeValue, normalizeText, slug } from "./common.mjs";

function semanticClick(attribute, value, text, delay = 120) {
  const selector = `[${attribute}="${escapeAttributeValue(value)}"]`;
  return {
    type: "click",
    selector,
    selectors: [selector],
    locator: { tag: "", role: "", text: normalizeText(text), attributes: { [attribute]: String(value) } },
    delay
  };
}

export function extractStaticPrototypeModel(document) {
  const variables = new Map();
  const warnings = [];
  for (const script of document.querySelectorAll("script:not([src])")) {
    const source = String(script.textContent || "").trim();
    if (!source) continue;
    try {
      const ast = parse(source, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true });
      collectVariables(ast, variables);
    } catch (error) {
      warnings.push(`有一段内联 JavaScript 无法静态解析：${String(error.message).split(/\r?\n/)[0]}`);
    }
  }
  const { pages, modules, navigation } = extractPages(variables);
  const identity = extractIdentity(variables);
  return { pages, modules, navigation, ...identity, warnings };
}

function collectVariables(node, variables) {
  if (!node || typeof node !== "object") return;
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
    const value = staticValue(node.init);
    if (value !== undefined && !variables.has(node.id.name)) variables.set(node.id.name, value);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    if (Array.isArray(value)) value.forEach(item => collectVariables(item, variables));
    else if (value && typeof value === "object" && typeof value.type === "string") collectVariables(value, variables);
  }
}

function staticValue(node) {
  if (!node) return undefined;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis.map(item => item.value.cooked).join("");
  if (node.type === "ArrayExpression") {
    const result = [];
    for (const element of node.elements) {
      const value = staticValue(element);
      if (value !== undefined) result.push(value);
    }
    return result;
  }
  if (node.type === "ObjectExpression") {
    const result = {};
    for (const property of node.properties) {
      if (property.type !== "Property" || property.computed) continue;
      const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
      const value = staticValue(property.value);
      if (key !== undefined && value !== undefined) result[key] = value;
    }
    return result;
  }
  return undefined;
}

function extractPages(variables) {
  const pages = [];
  const modules = [];
  const navigation = [];
  const seen = new Set();
  const moduleSeen = new Set();
  const navigationSeen = new Set();
  for (const [name, value] of variables) {
    if (/(^|_)(modules?|menus?|navigation|navItems?|routes?|pages?)$/i.test(name) && Array.isArray(value)) {
      value.forEach(item => {
        const id = normalizeText(item?.id || item?.key);
        const title = normalizeText(item?.label || item?.name || item?.title);
        const moduleChildren = ["items", "children", "pages", "routes"].flatMap(key => Array.isArray(item?.[key]) ? item[key] : []);
        if (id && title && !moduleSeen.has(id) && moduleChildren.length) {
          moduleSeen.add(id);
          modules.push({ id, title, action: semanticClick("data-module", id, title) });
          moduleChildren.forEach(child => visitNavigation(child, id, pages, seen, navigation, navigationSeen));
          return;
        }
        visitNavigation(item, id || null, pages, seen, navigation, navigationSeen);
      });
    }
    if (/^(nav|menu|navigation)Tree$/i.test(name) && value && typeof value === "object" && !Array.isArray(value)) {
      Object.entries(value).forEach(([center, items]) => {
        if (!moduleSeen.has(center)) {
          moduleSeen.add(center);
          modules.push({ id: center, title: center, action: semanticClick("data-center", center, center) });
        }
        visitNavigationTree(items, center, pages, seen, navigation, navigationSeen);
      });
    }
  }
  return { pages, modules, navigation };
}

function visitNavigationTree(value, center, pages, seen, navigation, navigationSeen, parentId = null, inheritedActions = []) {
  if (typeof value === "string") {
    const pageKey = `${center}::${value}`;
    if (seen.has(pageKey)) return;
    seen.add(pageKey);
    pages.push({
      id: pageKey,
      title: value,
      scope: `page:${slug(value, "page")}`,
      targetSelector: null,
      actions: [
        semanticClick("data-center", center, center),
        ...inheritedActions,
        semanticClick("data-page", value, value)
      ],
      moduleId: center,
      parentId: parentId || center
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => visitNavigationTree(item, center, pages, seen, navigation, navigationSeen, parentId, inheritedActions));
    return;
  }
  if (!value || typeof value !== "object") return;
  const id = normalizeText(value.id || value.key || value.value);
  const title = normalizeText(value.label || value.name || value.title);
  const structuralChildren = ["items", "children", "pages", "routes"].flatMap(key => Array.isArray(value[key]) ? value[key] : []);
  if (id && title && structuralChildren.length) {
    const navigationId = `${center}::${id}`;
    const actions = [...inheritedActions, semanticClick("data-page", id, title, 100)];
    if (!navigationSeen.has(navigationId)) {
      navigationSeen.add(navigationId);
      navigation.push({ id: navigationId, title, moduleId: center, parentId: parentId || center, actions });
    }
    structuralChildren.forEach(item => visitNavigationTree(item, center, pages, seen, navigation, navigationSeen, navigationId, actions));
    return;
  }
  for (const key of ["items", "children", "pages", "routes"]) {
    if (value[key] != null) visitNavigationTree(value[key], center, pages, seen, navigation, navigationSeen, parentId, inheritedActions);
  }
}

function visitNavigation(item, moduleId, pages, seen, navigation, navigationSeen, parentId = null, inheritedActions = []) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return;
  const id = normalizeText(item.id || item.key || item.value);
  const title = normalizeText(item.label || item.name || item.title);
  const childKeys = ["items", "children", "pages", "routes"];
  const children = childKeys.flatMap(key => Array.isArray(item[key]) ? item[key] : []);
  if (children.length) {
    if (!id || !title) {
      children.forEach(child => visitNavigation(child, moduleId, pages, seen, navigation, navigationSeen, parentId, inheritedActions));
      return;
    }
    const navigationId = `${moduleId || "root"}::${id}`;
    const actions = [...inheritedActions, semanticClick("data-page", id, title, 100)];
    if (!navigationSeen.has(navigationId)) {
      navigationSeen.add(navigationId);
      navigation.push({ id: navigationId, title, moduleId, parentId: parentId || moduleId, actions });
    }
    children.forEach(child => visitNavigation(child, moduleId || id, pages, seen, navigation, navigationSeen, navigationId, actions));
    return;
  }
  const pageKey = `${moduleId || "root"}::${id}`;
  if (!id || !title || seen.has(pageKey)) return;
  seen.add(pageKey);
  const actions = [];
  if (moduleId && moduleId !== id) actions.push(semanticClick("data-module", moduleId, ""));
  actions.push(...inheritedActions);
  actions.push(semanticClick("data-page", id, title));
  pages.push({
    id: pageKey,
    title,
    scope: `page:${id}`,
    targetSelector: `[data-proto-scope="page:${escapeAttributeValue(id)}"], [data-zann-scope="page:${escapeAttributeValue(id)}"]`,
    actions,
    moduleId,
    parentId: parentId || moduleId
  });
}

function extractIdentity(variables) {
  const roleEntry = findVariable(variables, /(^|_)(roles?|userRoles?|roleTypes?)$/i);
  const departmentEntry = findVariable(variables, /(^|_)(departments?|depts?|organizations?|orgs?)$/i);
  const roleValues = collectionValues(roleEntry?.[1]);
  const departmentValues = collectionValues(departmentEntry?.[1]);
  const dimensions = [];
  if (departmentValues.length) dimensions.push({ id: "department", name: "部门", values: departmentValues.map(toDimensionValue) });
  if (roleValues.length) dimensions.push({ id: "role", name: "角色", values: roleValues.map(toDimensionValue) });

  const profiles = [];
  const departmentRows = Array.isArray(departmentEntry?.[1]) ? departmentEntry[1] : [];
  const roleNames = new Map(roleValues.map(item => [String(item.raw), item.name]));
  for (const department of departmentRows) {
    const departmentId = department?.id ?? department?.key ?? department?.value;
    const departmentName = department?.name ?? department?.label ?? department?.title;
    if (!departmentId || !departmentName || !Array.isArray(department.roles)) continue;
    for (const roleId of department.roles) {
      const roleName = roleNames.get(String(roleId)) || String(roleId);
      profiles.push({
        id: `profile-department-${slug(departmentId, "department")}-role-${slug(roleId, "role")}`,
        name: `${departmentName} · ${roleName}`,
        attributes: { department: slug(departmentId, "department"), role: slug(roleId, "role") },
        sourceAttributes: { department: String(departmentId), role: String(roleId) },
        visibleNodeIds: [],
        source: "prototype-static-model",
        confidence: 0.96
      });
    }
  }
  if (!profiles.length && roleValues.length) {
    roleValues.forEach(role => profiles.push({ id: `profile-role-${slug(role.raw, "role")}`, name: role.name, attributes: { role: slug(role.raw, "role") }, sourceAttributes: { role: String(role.raw) }, visibleNodeIds: [], source: "prototype-static-model", confidence: 0.9 }));
  }
  if (!profiles.length && departmentValues.length) {
    departmentValues.forEach(department => profiles.push({ id: `profile-department-${slug(department.raw, "department")}`, name: department.name, attributes: { department: slug(department.raw, "department") }, sourceAttributes: { department: String(department.raw) }, visibleNodeIds: [], source: "prototype-static-model", confidence: 0.86 }));
  }
  return { dimensions, profiles };
}

function findVariable(variables, pattern) {
  return [...variables.entries()].find(([name]) => pattern.test(name));
}

function collectionValues(value) {
  if (Array.isArray(value)) {
    return value.map(item => typeof item === "object" ? ({ raw: item.id ?? item.key ?? item.value, name: item.name ?? item.label ?? item.title }) : ({ raw: item, name: item }))
      .filter(item => item.raw != null && normalizeText(item.name));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).map(([raw, item]) => ({ raw, name: typeof item === "object" ? item.name ?? item.label ?? item.title : item }))
      .filter(item => normalizeText(item.name));
  }
  return [];
}

function toDimensionValue(item) {
  return { id: slug(item.raw, "value"), name: normalizeText(item.name).slice(0, 60), sourceValue: String(item.raw) };
}
