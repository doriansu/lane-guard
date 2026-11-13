import { initialState, plan, SCOPES, SCOPE, RESOURCE_TYPES, TASK_ID, ENV_NAME, MAX_TASKS, MAX_TABS } from "./policy.js";
import { headersMatch } from "./monitor.js";

export const RECORD = "laneGuardV2";
export const PENDING = "laneGuardPendingV2";
export const QUARANTINE_ID = 3;

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized).sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, normalized(value[key])]));
  return value;
}

function equal(a, b) {
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

export function quarantine(tabIds) {
  const condition = { regexFilter: tabIds?.length ? SCOPE : SCOPES[0], resourceTypes: RESOURCE_TYPES };
  if (tabIds?.length) condition.tabIds = tabIds;
  return { id: QUARANTINE_ID, priority: 100000, action: { type: "block" }, condition };
}

function validRecord(record) {
  const state = record?.state;
  return record?.version === 2 && Array.isArray(record.rules) &&
    state && ["tasks", "tabs", "windows"].every(key =>
      state[key] && typeof state[key] === "object" && !Array.isArray(state[key])) &&
    Number.isSafeInteger(state.nextRuleId) && state.nextRuleId >= 1000 &&
    Object.keys(state.tasks).length <= MAX_TASKS &&
    Object.keys(state.tabs).length <= MAX_TABS &&
    Object.entries(state.tasks).every(([id, task]) => TASK_ID.test(id) && task &&
      typeof task.env === "string" && ENV_NAME.test(task.env) && ["active", "blocked"].includes(task.status)) &&
    Object.entries(state.tabs).every(([id, binding]) =>
      /^\d+$/.test(id) && binding && Number.isSafeInteger(binding.windowId) &&
      Array.isArray(binding.ids) && binding.ids.length === 3 &&
      binding.ids.every(ruleId => Number.isSafeInteger(ruleId) && ruleId >= 1000) &&
      ["manual", "task"].includes(binding.owner?.kind) &&
      (binding.owner.kind === "manual" || Object.hasOwn(state.tasks, binding.owner.taskId))) &&
    Object.values(state.windows).every(owner => ["manual", "task"].includes(owner?.kind) &&
      (owner.kind === "manual" || Object.hasOwn(state.tasks, owner.taskId)));
}

// Storage and DNR cannot commit atomically. Keep affected tabs blocked until
// both are durable, and treat any incomplete commit as a failed test run.
export function createCoordinator({ storage, dnr, getTab, getTabs }) {
  let queue = Promise.resolve();
  const observed = new Map();
  let lastTaskTabs = [];

  async function reconcile(force = false) {
    let data, actual;
    try {
      data = await storage.get([RECORD, PENDING]);
      actual = await dnr.getSessionRules();
    } catch (error) {
      // Do not quarantine unrelated manual tabs if storage is unavailable.
      const rules = actual || await dnr.getSessionRules();
      const tabs = [...new Set(lastTaskTabs.concat(rules
        .filter(rule => ["block", "modifyHeaders"].includes(rule.action.type))
        .flatMap(rule => rule.condition.tabIds || [])))];
      await dnr.updateSessionRules({
        removeRuleIds: [QUARANTINE_ID], addRules: [quarantine(tabs)],
      });
      throw error;
    }
    let record = data[RECORD];
    if (!record && !data[PENDING] && actual.length === 0) {
      record = { version: 2, state: initialState(), rules: [] };
      await storage.set({ [RECORD]: record });
      return record;
    }
    if (validRecord(record)) lastTaskTabs = Object.entries(record.state.tabs)
      .filter(([, binding]) => binding.owner.kind === "task").map(([id]) => Number(id));
    if (!force && validRecord(record) && !data[PENDING] && equal(actual, record.rules)) return record;

    const taskTabs = [...new Set(lastTaskTabs.concat(actual
      .filter(rule => ["block", "modifyHeaders"].includes(rule.action.type))
      .flatMap(rule => rule.condition.tabIds || [])))];
    await dnr.updateSessionRules({
      removeRuleIds: [QUARANTINE_ID], addRules: [quarantine(taskTabs)],
    });
    // Recovery removes admissions before touching potentially broken storage.
    await dnr.updateSessionRules({
      removeRuleIds: actual.filter(rule => rule.id !== QUARANTINE_ID).map(rule => rule.id),
    });
    const state = validRecord(record) ? structuredClone(record.state) : initialState();
    for (const task of Object.values(state.tasks)) {
      task.status = "blocked";
      task.failure = "Incomplete commit or rule/state mismatch";
    }
    // Keep a tab-scoped denial when no admission remains. Targets have no global deny.
    const rules = taskTabs.length ? [quarantine(taskTabs)] : [];
    record = { version: 2, state, rules, recovery: "All task admissions revoked" };
    await storage.set({ [RECORD]: record });
    await storage.remove(PENDING);
    await dnr.updateSessionRules({
      removeRuleIds: [QUARANTINE_ID], addRules: rules,
    });
    return record;
  }

  async function execute(command) {
    if (!command || typeof command !== "object" || typeof command.type !== "string") {
      throw new Error("Invalid command");
    }
    if (["bindTask", "stopTask", "assertTask", "reportMismatch"].includes(command.type) &&
        (typeof command.taskId !== "string" || !TASK_ID.test(command.taskId))) throw new Error("Invalid task ID");
    if (["bindTask", "bindManual", "gate", "observeHeaders", "tabMoved", "removeTab"].includes(command.type) &&
        (!Number.isSafeInteger(command.tabId) || command.tabId < 0)) throw new Error("Invalid tab ID");
    if (command.type === "removeWindow" &&
        (!Number.isSafeInteger(command.windowId) || command.windowId < 0)) throw new Error("Invalid window ID");
    const current = await reconcile(command.type === "forceStopAll");
    // A recovered session keeps its denial until its bound tabs are closed.
    // New tasks use a fresh browser session; never replace a recovery quarantine
    // with a transaction's temporary quarantine.
    if (command.type === "resetClosedTasks") {
      const protectedIds = new Set(Object.entries(current.state.tabs)
        .filter(([, binding]) => binding.owner.kind === "task").map(([id]) => Number(id)));
      for (const rule of current.rules) {
        if (rule.action.type === "block") {
          for (const id of rule.condition.tabIds || []) protectedIds.add(id);
        }
      }
      if ((await getTabs()).some(tab => protectedIds.has(tab.id))) {
        throw new Error("Close all guarded task tabs before resetting the session");
      }
      const record = { version: 2, state: initialState(), rules: [] };
      await storage.set({ [PENDING]: true });
      await dnr.updateSessionRules({ removeRuleIds: current.rules.map(rule => rule.id) });
      await storage.set({ [RECORD]: record });
      await storage.remove(PENDING);
      lastTaskTabs = [];
      observed.clear();
      return { committed: true, reset: true };
    }
    if (current.recovery && !["status", "assertTask", "forceStopAll"].includes(command.type)) {
      if (["removeTab", "removeWindow", "observeHeaders", "tabMoved"].includes(command.type)) {
        return { ignored: true };
      }
      throw new Error("Recovered session: close guarded tabs, then call resetClosedTasks before binding");
    }
    if (command.type === "forceStopAll") return { revoked: true };
    if (command.type === "status") return {
      state: current.state, sessionRules: current.rules, recovery: current.recovery,
      observations: Object.fromEntries(observed),
    };
    if (command.type === "observeHeaders" || command.type === "tabMoved") {
      const binding = current.state.tabs[command.tabId];
      if (binding?.owner.kind !== "task") return { ignored: true };
      const taskId = binding.owner.taskId;
      if (current.state.tasks[taskId]?.status !== "active") return { ignored: true };
      if (command.type === "observeHeaders" && headersMatch(command, current.state.tasks[taskId].env)) {
        const count = observed.get(taskId) || { checked: 0, mismatched: 0 };
        observed.set(taskId, { ...count, checked: Math.min(count.checked + 1, Number.MAX_SAFE_INTEGER) });
        return { observed: true };
      }
      if (command.type === "observeHeaders") {
        const count = observed.get(taskId) || { checked: 0, mismatched: 0 };
        observed.set(taskId, { checked: count.checked + 1, mismatched: count.mismatched + 1 });
      }
      command = { type: "stopTask", taskId, failure: command.type === "tabMoved"
        ? "Task tab moved between windows" : "Observed outgoing environment mismatch" };
    }
    if (command.type === "assertTask") {
      const task = current.state.tasks[command.taskId];
      if (task?.status !== "active") throw new Error(task?.failure || "Task is not active");
      if (command.tabIds !== undefined && (!Array.isArray(command.tabIds) || !command.tabIds.length ||
          !command.tabIds.every(id => Number.isSafeInteger(id) &&
            current.state.tabs[id]?.owner.taskId === command.taskId))) {
        throw new Error("Every operation tab must be bound to this task before navigation");
      }
      return { active: true, env: task.env };
    }
    if (command.type === "reportMismatch") {
      command = { type: "stopTask", taskId: command.taskId, failure: "Reported environment mismatch" };
    }
    if (command.type === "removeTab" && !current.state.tabs[command.tabId]) return { committed: true };
    if (command.type === "removeWindow" && !current.state.windows[command.windowId]) return { committed: true };
    const tab = ["bindTask", "bindManual", "gate"].includes(command.type)
      ? await getTab(command.tabId) : undefined;
    const change = plan(current.state, command, tab);
    if (command.failure) change.state.tasks[command.taskId].failure = command.failure;
    const removed = new Set(change.removeRuleIds);
    const rules = current.rules.filter(rule => !removed.has(rule.id)).concat(change.addRules);
    const affected = [...new Set(current.rules.filter(rule => removed.has(rule.id))
      .concat(change.addRules).flatMap(rule => rule.condition.tabIds || []))];

    // A closed tab or task with no rules needs no network transition.
    if (affected.length) await dnr.updateSessionRules({
      removeRuleIds: [QUARANTINE_ID], addRules: [quarantine(affected)],
    });
    await storage.set({ [PENDING]: true });
    await dnr.updateSessionRules({
      removeRuleIds: change.removeRuleIds, addRules: change.addRules,
    });
    await storage.set({ [RECORD]: { version: 2, state: change.state, rules } });
    await storage.remove(PENDING);
    if (affected.length) await dnr.updateSessionRules({ removeRuleIds: [QUARANTINE_ID] });
    return { committed: true, owner: change.owner, env: change.env };
  }

  return command => {
    const next = queue.then(() => execute(command));
    queue = next.catch(() => {});
    return next;
  };
}
