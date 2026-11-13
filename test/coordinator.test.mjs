import test from "node:test";
import assert from "node:assert/strict";
import { createCoordinator, RECORD, PENDING, QUARANTINE_ID } from "../extension/coordinator.js";

const bind = { type: "bindTask", taskId: "task_A", env: "staging", tabId: 10 };

function harness() {
  const h = { data: {}, rules: [], writes: 0, failAt: Infinity, trace: [], liveTabIds: [10, 20] };
  function wrote() {
    h.writes++;
    h.trace.push(structuredClone({ data: h.data, rules: h.rules }));
    if (h.writes === h.failAt) throw new Error("Simulated termination after write");
  }
  h.storage = {
    async get() { return structuredClone(h.data); },
    async set(values) { Object.assign(h.data, structuredClone(values)); wrote(); },
    async remove(key) { delete h.data[key]; wrote(); },
  };
  h.dnr = {
    async getSessionRules() { return structuredClone(h.rules); },
    async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
      h.rules = h.rules.filter(rule => !removeRuleIds.includes(rule.id)).concat(structuredClone(addRules));
      wrote();
    },
  };
  h.restart = () => createCoordinator({
    storage: h.storage, dnr: h.dnr, getTab: async id => ({ id, windowId: id * 10 }),
    getTabs: async () => h.liveTabIds.map(id => ({ id })),
  });
  return h;
}

function blocked(rules, tabId) {
  return rules.some(rule => rule.id === QUARANTINE_ID &&
    (!rule.condition.tabIds || rule.condition.tabIds.includes(tabId)));
}


function assertDeniedOnly(rules, tabs) {
  const url = "https://app.example.com/app/dashboard/segment/save";
  assert.ok(rules.length > 0);
  assert.ok(rules.every(rule => rule.action.type === "block"));
  for (const tabId of tabs) assert.ok(rules.some(rule =>
    rule.condition.tabIds?.includes(tabId) && new RegExp(rule.condition.regexFilter).test(url)));
  assert.ok(rules.every(rule => rule.condition.tabIds?.every(tabId => tabs.includes(tabId))));
}

test("healthy worker restart preserves committed tasks", async () => {
  const h = harness();
  await h.restart()(bind);
  assert.deepEqual(await h.restart()({ type: "assertTask", taskId: "task_A" }),
    { active: true, env: "staging" });
  assert.equal(h.rules.length, 3);
  assert.ok(!h.data[PENDING]);
});

test("admission is quarantined until state and rules are committed", async () => {
  const h = harness();
  await h.restart()(bind);
  for (const snapshot of h.trace) {
    const allow = snapshot.rules.find(rule => rule.action.type === "allow");
    if (!allow || blocked(snapshot.rules, 10)) continue;
    assert.equal(snapshot.data[RECORD].state.tasks.task_A.status, "active");
    assert.equal(snapshot.data[PENDING], undefined);
    assert.equal(snapshot.rules.find(rule => rule.action.type === "modifyHeaders")
      .action.requestHeaders[0].value, "staging");
  }
});

for (const kind of ["bind", "stop"]) {
  // The six writes after an initialized record are the transaction boundaries.
  for (let cut = 1; cut <= 6; cut++) {
    test(`${kind}: recover termination after transaction write ${cut}`, async () => {
      const h = harness();
      const run = h.restart();
      await run({ type: "status" });
      if (kind === "stop") await run(bind);
      h.failAt = h.writes + cut;
      await assert.rejects(run(kind === "bind" ? bind : {
        type: "stopTask", taskId: "task_A",
      }), /Simulated termination/);
      if (cut < 6) assert.ok(blocked(h.rules, 10));
      h.failAt = Infinity;
      const status = await h.restart()({ type: "status" });
      assert.equal(h.data[PENDING], undefined);
      if (kind === "stop" || cut < 6) {
        assert.notEqual(status.state.tasks.task_A?.status, "active");
        assertDeniedOnly(h.rules, [10]);
      } else {
        assert.equal(status.state.tasks.task_A.status, "active");
      }
    });
  }
}

test("rule loss revokes admissions instead of repairing and continuing", async () => {
  const h = harness(), run = h.restart();
  await run(bind);
  h.rules = h.rules.filter(rule => rule.action.type !== "modifyHeaders");
  await assert.rejects(run({ type: "assertTask", taskId: "task_A" }), /mismatch/);
  assertDeniedOnly(h.rules, [10]);
  assert.equal(h.data[RECORD].state.tasks.task_A.status, "blocked");
});

test("failed recovery leaves a task-tab quarantine, retry can recover", async () => {
  const h = harness(), run = h.restart();
  await run(bind);
  h.data[PENDING] = true;
  h.failAt = h.writes + 3;
  await assert.rejects(h.restart()({ type: "status" }), /Simulated termination/);
  assert.ok(blocked(h.rules, 10));
  h.failAt = Infinity;
  const status = await h.restart()({ type: "status" });
  assert.equal(status.state.tasks.task_A.status, "blocked");
  assertDeniedOnly(h.rules, [10]);
});

test("concurrent commands serialize and quarantine only affected tabs", async () => {
  const h = harness(), run = h.restart();
  await Promise.all([run(bind), run({ ...bind, taskId: "task_B", env: "prod", tabId: 20 })]);
  assert.equal(h.rules.length, 6);
  assert.ok(h.trace.flatMap(s => s.rules).filter(r => r.id === QUARANTINE_ID)
    .every(r => r.condition.tabIds.length === 1));
  await run({ type: "reportMismatch", taskId: "task_A" });
  await assert.rejects(run({ type: "assertTask", taskId: "task_A" }), /mismatch/);
  assert.equal((await run({ type: "assertTask", taskId: "task_B" })).env, "prod");
});

test("invalid commands do not poison the command queue", async () => {
  const h = harness(), run = h.restart();
  await assert.rejects(run({ type: "nonsense" }), /Unknown command/);
  await run(bind);
  assert.equal((await run({ type: "assertTask", taskId: "task_A" })).active, true);
});

test("storage read failure blocks traffic rather than trusting cached state", async () => {
  const h = harness(), run = h.restart();
  await run(bind);
  const original = h.storage.get;
  h.storage.get = async () => { throw new Error("Storage unavailable"); };
  await assert.rejects(run({ type: "assertTask", taskId: "task_A" }), /unavailable/);
  assert.ok(blocked(h.rules, 10));
  h.storage.get = original;
  assert.equal((await run({ type: "status" })).state.tasks.task_A.status, "blocked");
});

test("observed mismatch automatically revokes only the affected task", async () => {
  const h = harness(), run = h.restart();
  await run(bind);
  await run({ ...bind, taskId: "task_B", env: "prod", tabId: 20 });
  await run({ type: "observeHeaders", tabId: 10, envValues: ["staging"], flagValues: ["1"] });
  await run({ type: "observeHeaders", tabId: 10, envValues: ["wrong"], flagValues: ["1"] });
  await assert.rejects(run({ type: "assertTask", taskId: "task_A" }), /outgoing environment mismatch/);
  assert.equal((await run({ type: "assertTask", taskId: "task_B" })).active, true);
  assert.deepEqual((await run({ type: "status" })).observations.task_A, { checked: 2, mismatched: 1 });
  assert.equal(JSON.stringify(h.data).includes("wrong"), false);
});

test("manual traffic is not treated as a task header mismatch", async () => {
  const h = harness(), run = h.restart();
  await run({ type: "bindManual", tabId: 10 });
  const writes = h.writes;
  assert.deepEqual(await run({ type: "observeHeaders", tabId: 10, envValues: [], flagValues: [] }),
    { ignored: true });
  assert.equal(h.writes, writes);
});

test("moving a task tab revokes its task and closing window removes ownership", async () => {
  const h = harness(), run = h.restart();
  await run(bind);
  await run({ type: "tabMoved", tabId: 10 });
  await assert.rejects(run({ type: "assertTask", taskId: "task_A" }), /moved/);
  await run({ type: "removeWindow", windowId: 100 });
  const status = await run({ type: "status" });
  assert.equal(status.state.windows[100], undefined);
  assert.equal(status.state.tabs[10], undefined);
  assert.equal(h.rules.length, 0);
});

test("emergency revocation serializes with other commands and persists failure", async () => {
  const h = harness(), run = h.restart();
  await run(bind);
  await Promise.all([
    run({ ...bind, taskId: "task_B", env: "prod", tabId: 20 }),
    run({ type: "forceStopAll" }),
  ]);
  const status = await h.restart()({ type: "status" });
  assert.ok(Object.values(status.state.tasks).every(task => task.status === "blocked"));
  assertDeniedOnly(h.rules, [10, 20]);
});


test("operation tabs must belong to the declared active task", async () => {
  const h = harness(), run = h.restart();
  await run(bind);
  await run({ ...bind, taskId: "task_B", env: "prod", tabId: 20 });
  assert.equal((await run({ type: "assertTask", taskId: "task_A", tabIds: [10] })).active, true);
  for (const tabIds of [[20], [30], [], [10, 20]]) {
    await assert.rejects(run({ type: "assertTask", taskId: "task_A", tabIds }), /must be bound/);
  }
});

test("a new bind or lifecycle event cannot clear a recovered denial", async () => {
  const h = harness(), run = h.restart();
  await run(bind);
  h.rules = [];
  await assert.rejects(run({ type: "assertTask", taskId: "task_A" }), /mismatch/);
  await assert.rejects(run({ ...bind, taskId: "task_B", tabId: 20 }), /Recovered session/);
  await run({ type: "removeTab", tabId: 10 });
  assertDeniedOnly(h.rules, [10]);
});

test("reset refuses live guarded tabs and permits a new task only after they close", async () => {
  const h = harness(), run = h.restart();
  await run(bind);
  await run({ type: "stopTask", taskId: "task_A" });
  await assert.rejects(run({ type: "resetClosedTasks" }), /Close all guarded/);
  assertDeniedOnly(h.rules, [10]);
  h.liveTabIds = [20];
  assert.deepEqual(await run({ type: "resetClosedTasks" }), { committed: true, reset: true });
  await run({ ...bind, taskId: "task_B", tabId: 20 });
  assert.equal((await run({ type: "assertTask", taskId: "task_B", tabIds: [20] })).active, true);
});

test("reset retains recovery denial until the recovered tabs actually close", async () => {
  const h = harness(), run = h.restart();
  await run(bind);
  h.rules = [];
  await run({ type: "status" });
  await assert.rejects(run({ type: "resetClosedTasks" }), /Close all guarded/);
  h.liveTabIds = [];
  await run({ type: "resetClosedTasks" });
  assert.equal(h.rules.length, 0);
  assert.equal((await run({ type: "status" })).recovery, undefined);
});
