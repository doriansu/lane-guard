import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initialState, plan, checkedUrl, gateRules, GATE_RULE_IDS, SCOPES, SCOPE, RESOURCE_TYPES } from "../extension/policy.js";
import { CONFIG } from "../extension/config.js";

const task = { type: "bindTask", taskId: "task_A", env: "staging" };
const parent = { id: 10, windowId: 100 };
const target = "http://127.0.0.1:51843/__env_probe/page?task=A";

test("static fallback and generated rules have the same narrow scope", async () => {
  const rules = JSON.parse(await readFile(new URL("../extension/deny.json", import.meta.url)));
  assert.equal(rules[0].condition.regexFilter, SCOPES[0]);
  assert.equal(rules[0].action.type, "block");
  assert.deepEqual(rules[0].condition.resourceTypes, RESOURCE_TYPES);
  assert.ok(RESOURCE_TYPES.includes("main_frame"));
  assert.deepEqual(gateRules("chrome-extension://test").map(rule => rule.condition.regexFilter), SCOPES.slice(0, 1));
  assert.deepEqual(GATE_RULE_IDS, [2]);
  assert.equal(checkedUrl(target), target);
  for (const url of ["https://example.com/", "http://127.0.0.1:51844/__env_probe/",
    "http://127.0.0.1:51843/other", "http://user@127.0.0.1:51843/__env_probe/"]) {
    assert.throws(() => checkedUrl(url));
  }
});

test("admission and routing headers are planned together for one exact tab", () => {
  const before = initialState();
  const result = plan(before, task, parent);
  assert.deepEqual(before, initialState());
  assert.equal(result.addRules.length, 3);
  assert.ok(result.addRules.every(rule => rule.condition.tabIds[0] === 10));
  assert.ok(result.addRules.every(rule => rule.condition.resourceTypes.includes("main_frame")));
  const headers = result.addRules.find(rule => rule.action.type === "modifyHeaders");
  assert.ok(headers.priority > result.addRules[0].priority);
  assert.deepEqual(headers.action.requestHeaders, [
    { header: CONFIG.envHeader, operation: "set", value: "staging" },
    { header: CONFIG.flagHeader, operation: "set", value: CONFIG.flagValue },
  ]);
});

test("independent tasks preserve each other's bindings", () => {
  const a = plan(initialState(), task, parent);
  const b = plan(a.state, { ...task, taskId: "task_B", env: "prod" }, { id: 20, windowId: 200 });
  assert.equal(b.state.tasks.task_A.env, "staging");
  assert.equal(b.state.tasks.task_B.env, "prod");
  assert.ok(b.removeRuleIds.every(id => !a.addRules.some(rule => rule.id === id)));
});

test("task environment cannot change or take over a different task window", () => {
  const { state } = plan(initialState(), task, parent);
  assert.throws(() => plan(state, { ...task, env: "changed" }, parent), /immutable/);
  assert.throws(() => plan(state, { ...task, taskId: "task_B" }, { id: 11, windowId: 100 }), /ownership/);
  assert.throws(() => plan(state, { type: "bindManual" }, parent), /ownership/);
});

test("a tab that already reached a guarded target cannot be bound", () => {
  const arrived = { ...parent, url: "http://127.0.0.1:51843/__env_probe/page" };
  assert.throws(() => plan(initialState(), task, arrived), /fresh tab/);
  // A blocked first navigation parks the tab on the gate page, which names the
  // target in its hash; that tab is not fresh either.
  const gated = { ...parent, url: "chrome-extension://test/gate.html#http://127.0.0.1:51843/__env_probe/page" };
  assert.throws(() => plan(initialState(), task, gated), /fresh tab/);
  assert.equal(plan(initialState(), task, { ...parent, url: "https://elsewhere.example/" }).addRules.length, 3);
  assert.equal(plan(initialState(), task, { ...parent, url: "chrome-extension://test/control.html" }).addRules.length, 3);
  assert.equal(plan(initialState(), task, { ...parent, url: "chrome-extension://test/gate.html#https://elsewhere.example/" }).addRules.length, 3);
});

test("new tab inherits its task window without an opener", () => {
  const { state } = plan(initialState(), task, parent);
  const result = plan(state, { type: "gate", url: target }, { id: 11, windowId: 100 });
  assert.equal(result.env, "staging");
});

test("new window inherits a registered opener", () => {
  const { state } = plan(initialState(), task, parent);
  const result = plan(state, { type: "gate", url: target }, { id: 11, windowId: 101, openerTabId: 10 });
  assert.deepEqual(result.state.windows[101], { kind: "task", taskId: "task_A" });
});

test("unknown ownership or conflicting opener/window fails closed", () => {
  assert.throws(() => plan(initialState(), { type: "gate", url: target }, parent), /Unknown window/);
  const a = plan(initialState(), task, parent);
  const b = plan(a.state, { ...task, taskId: "task_B", env: "prod" }, { id: 20, windowId: 200 });
  assert.throws(() => plan(b.state, { type: "gate", url: target },
    { id: 21, windowId: 200, openerTabId: 10 }), /Conflicting/);
});

test("manual window is admitted without rewriting its headers", () => {
  const manual = plan(initialState(), { type: "bindManual" }, parent);
  assert.equal(manual.addRules.length, 1);
  const child = plan(manual.state, { type: "gate", url: target }, { id: 11, windowId: 100 });
  assert.equal(child.addRules.length, 1);
  assert.equal(child.env, null);
});

test("stopping a task removes only its rules and blocks future children", () => {
  const a = plan(initialState(), task, parent);
  const b = plan(a.state, { ...task, taskId: "task_B", env: "prod" }, { id: 20, windowId: 200 });
  const stopped = plan(b.state, { type: "stopTask", taskId: "task_A" });
  assert.deepEqual(stopped.removeRuleIds, a.addRules.filter(rule => rule.action.type !== "block").map(rule => rule.id));
  assert.equal(stopped.state.tasks.task_B.status, "active");
  assert.throws(() => plan(stopped.state, { type: "gate", url: target }, { id: 11, windowId: 100 }), /blocked/);
  assert.throws(() => plan(stopped.state, task, parent), /immutable/);
});

test("GET-only gate does not silently replay POST as GET", () => {
  assert.deepEqual(gateRules("chrome-extension://test")[0].condition.requestMethods, ["get"]);
});

test("task IDs reject prototype names and non-string coercions", () => {
  for (const taskId of ["__proto__", "constructor", ["task_A"], null]) {
    assert.throws(() => plan(initialState(), { ...task, taskId }, parent), /Invalid task/);
    assert.throws(() => plan(initialState(), { type: "stopTask", taskId }), /Invalid task/);
  }
  assert.equal({}.status, undefined);
});

test("closing a task window revokes its related popup rules", () => {
  const a = plan(initialState(), task, parent);
  const child = plan(a.state, { type: "gate", url: target }, { id: 11, windowId: 101, openerTabId: 10 });
  const closed = plan(child.state, { type: "removeWindow", windowId: 100 });
  assert.equal(closed.state.tasks.task_A.status, "blocked");
  assert.equal(closed.state.windows[100], undefined);
  assert.equal(closed.removeRuleIds.length, 5);
  assert.throws(() => plan(closed.state, { type: "gate", url: target },
    { id: 12, windowId: 101 }), /blocked/);
});

test("scope covers only the exact configured origin and path", () => {
  const url = "https://app.example.com/app/dashboard/segment/detail?entity_id=1";
  assert.equal(checkedUrl(url), url);
  assert.ok(new RegExp(SCOPE).test(url));
  for (const bad of [
    "https://app.example.com/",
    "https://app.example.com/dashboard/",
    "https://app.example.com/app.evil.test/app/",
    "https://app.example.com:8443/app/",
    "http://app.example.com/app/",
  ]) {
    assert.throws(() => checkedUrl(bad));
    assert.equal(new RegExp(SCOPE).test(bad), false);
  }
});

test("unbound tabs have no global deny; stopped task tabs retain their deny", async () => {
  const url = "https://app.example.com/app/dashboard/segment/detail";
  const staticRules = JSON.parse(await readFile(new URL("../extension/deny.json", import.meta.url)));
  assert.ok(staticRules.every(rule => !new RegExp(rule.condition.regexFilter).test(url)));
  const active = plan(initialState(), task, parent);
  assert.ok(active.addRules.every(rule => rule.condition.tabIds.length === 1));
  const stopped = plan(active.state, { type: "stopTask", taskId: "task_A" });
  const remaining = active.addRules.filter(rule => !stopped.removeRuleIds.includes(rule.id));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].action.type, "block");
  assert.ok(new RegExp(remaining[0].condition.regexFilter).test(url));
  const manual = plan(initialState(), { type: "bindManual" }, parent);
  assert.deepEqual(manual.addRules.map(rule => rule.action.type), ["allow"]);
});

test("closing a popup does not stop its parent task", () => {
  const a = plan(initialState(), task, parent);
  const child = plan(a.state, { type: "gate", url: target }, { id: 11, windowId: 101, openerTabId: 10 });
  const closed = plan(child.state, { type: "removeWindow", windowId: 101 });
  assert.equal(closed.state.tasks.task_A.status, "active");
  assert.deepEqual(closed.removeRuleIds.slice().sort(), child.addRules.map(rule => rule.id).sort());
  assert.ok(closed.state.tabs[10]);
});
