import { CONFIG } from "./config.js";

export const MAX_TASKS = 64;
export const MAX_TABS = 256;
export const TASK_ID = /^task_[A-Za-z0-9_-]{1,40}$/;
export const ENV_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
export const GATE_RULE_BASE = 2;
export const RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport",
  "webbundle", "other",
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scopeRegex(target) {
  return `^${escapeRegex(target.origin + target.pathPrefix)}`;
}

export const SCOPES = CONFIG.targets.map(scopeRegex);
export const SCOPE = `(${SCOPES.join("|")})`;
export const SCOPE_RE = new RegExp(SCOPE);
export const GATE_TARGETS = CONFIG.targets.filter(target => target.gate);

export function initialState() {
  return { tasks: {}, windows: {}, tabs: {}, nextRuleId: 1000 };
}

export function checkedUrl(value) {
  const url = new URL(value);
  const inScope = CONFIG.targets.some(target =>
    url.origin === target.origin && url.pathname.startsWith(target.pathPrefix));
  if (!inScope || url.username || url.password) {
    throw new Error("URL is outside the configured scopes");
  }
  return url.href;
}

// One redirect rule per gated target. Ids are reserved so `init` can replace
// them without touching session rules owned by the coordinator.
export function gateRules(extensionOrigin) {
  return GATE_TARGETS.map((target, index) => ({
    id: GATE_RULE_BASE + index,
    priority: 2,
    action: {
      type: "redirect",
      redirect: { regexSubstitution: `${extensionOrigin}/gate.html#\\0` },
    },
    condition: { regexFilter: scopeRegex(target), resourceTypes: ["main_frame"], requestMethods: ["get"] },
  }));
}

export const GATE_RULE_IDS = GATE_TARGETS.map((_, index) => GATE_RULE_BASE + index);

function sameOwner(a, b) {
  return a?.kind === b?.kind && a?.taskId === b?.taskId;
}

function routingHeaders(env) {
  const headers = [{ header: CONFIG.envHeader, operation: "set", value: env }];
  if (CONFIG.flagHeader) {
    headers.push({ header: CONFIG.flagHeader, operation: "set", value: CONFIG.flagValue });
  }
  return headers;
}

function attach(state, tab, owner) {
  if (!Number.isInteger(tab.id) || tab.id < 0 || !Number.isInteger(tab.windowId) ||
      tab.windowId < 0) throw new Error("Invalid tab or window");
  const existing = state.tabs[tab.id];
  if (!existing && Object.keys(state.tabs).length >= MAX_TABS) throw new Error("Tab capacity reached");
  const windowOwner = state.windows[tab.windowId];
  if ((existing && !sameOwner(existing.owner, owner)) ||
      (windowOwner && !sameOwner(windowOwner, owner))) {
    throw new Error("Conflicting tab/window ownership");
  }
  const task = owner.kind === "task" ? state.tasks[owner.taskId] : null;
  if (owner.kind === "task" && task?.status !== "active") throw new Error("Task is blocked");
  const ids = existing?.ids || [state.nextRuleId++, state.nextRuleId++, state.nextRuleId++];
  // DNR's implicit resource list excludes main_frame.
  const condition = { regexFilter: SCOPE, tabIds: [tab.id], resourceTypes: RESOURCE_TYPES };
  const addRules = [{ id: ids[0], priority: 3, action: { type: "allow" }, condition }];
  if (task) {
    // A stopped task keeps this deny so its tabs cannot silently fall back to
    // whatever routing the browser would otherwise apply.
    addRules.push({
      id: ids[2], priority: 1, action: { type: "block" }, condition,
    });
    addRules.push({
      id: ids[1],
      priority: 4,
      action: { type: "modifyHeaders", requestHeaders: routingHeaders(task.env) },
      condition,
    });
  }
  state.windows[tab.windowId] = owner;
  state.tabs[tab.id] = { owner, ids, windowId: tab.windowId };
  return { addRules, removeRuleIds: ids, owner, env: task?.env ?? null };
}

// Pure planner; the background worker serializes and commits each plan.
export function plan(current, command, tab) {
  if (["bindTask", "stopTask"].includes(command.type) &&
      (typeof command.taskId !== "string" || !TASK_ID.test(command.taskId))) {
    throw new Error("Invalid task ID");
  }
  const state = structuredClone(current);
  let change;
  if (command.type === "bindTask") {
    if (typeof command.env !== "string" || !ENV_NAME.test(command.env)) throw new Error("Invalid task or environment");
    const prior = state.tasks[command.taskId];
    if (!prior && Object.keys(state.tasks).length >= MAX_TASKS) throw new Error("Task capacity reached; restart browser after all tasks finish");
    if (prior && (prior.env !== command.env || prior.status !== "active")) {
      throw new Error("Task environment is immutable; create a new task");
    }
    state.tasks[command.taskId] = prior || {
      env: command.env, status: "active", rootWindowId: tab.windowId,
    };
    change = attach(state, tab, { kind: "task", taskId: command.taskId });
  } else if (command.type === "bindManual") {
    change = attach(state, tab, { kind: "manual" });
  } else if (command.type === "gate") {
    checkedUrl(command.url);
    const direct = state.tabs[tab.id]?.owner;
    const opener = state.tabs[tab.openerTabId]?.owner;
    const windowOwner = state.windows[tab.windowId];
    const owners = [direct, opener, windowOwner].filter(Boolean);
    if (!owners.length) throw new Error("Unknown window: register a task or manual window first");
    if (owners.some(owner => !sameOwner(owner, owners[0]))) {
      throw new Error("Conflicting opener/window ownership");
    }
    change = attach(state, tab, owners[0]);
  } else if (command.type === "stopTask") {
    if (!state.tasks[command.taskId]) throw new Error("Unknown task");
    state.tasks[command.taskId].status = "blocked";
    change = {
      addRules: [],
      removeRuleIds: Object.values(state.tabs)
        .filter(binding => binding.owner.taskId === command.taskId)
        .flatMap(binding => binding.ids.slice(0, 2)),
    };
  } else if (command.type === "removeTab") {
    change = { addRules: [], removeRuleIds: state.tabs[command.tabId]?.ids || [] };
    delete state.tabs[command.tabId];
  } else if (command.type === "removeWindow") {
    const owner = state.windows[command.windowId];
    const stopTask = owner?.kind === "task" &&
      (state.tasks[owner.taskId].rootWindowId === undefined ||
        state.tasks[owner.taskId].rootWindowId === command.windowId);
    change = { addRules: [], removeRuleIds: [] };
    for (const [id, binding] of Object.entries(state.tabs)) {
      if (binding.windowId === command.windowId ||
          (stopTask && binding.owner.taskId === owner.taskId)) {
        change.removeRuleIds.push(...(binding.windowId === command.windowId
          ? binding.ids : binding.ids.slice(0, 2)));
        if (binding.windowId === command.windowId) delete state.tabs[id];
      }
    }
    if (stopTask) {
      state.tasks[owner.taskId].status = "blocked";
      state.tasks[owner.taskId].failure = "Task window closed";
    }
    delete state.windows[command.windowId];
  } else {
    throw new Error("Unknown command");
  }
  return { state, ...change };
}
