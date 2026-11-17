import test from "node:test";
import assert from "node:assert/strict";
import { runGuardedSteps, runLaneTask } from "../agent-guard.mjs";

const tabIds = [10];

test("guarded runner returns results only while task stays active", async () => {
  const results = await runGuardedSteps({
    taskId: "task_A", tabIds, send: async () => ({ ok: true, active: true }),
    steps: [async () => 1, async () => 2],
  });
  assert.deepEqual(results, [1, 2]);
});

test("steps cannot run without a declared, bound tab", async () => {
  let sent = false;
  await assert.rejects(runGuardedSteps({
    taskId: "task_A", send: async () => { sent = true; return { ok: true, active: true }; },
    steps: [async () => 1],
  }), /Invalid guarded runner options/);
  assert.equal(sent, false);
});

test("assertTask carries the declared tab IDs", async () => {
  const seen = [];
  await runGuardedSteps({
    taskId: "task_A", tabIds, send: async command => { seen.push(command); return { ok: true, active: true }; },
    steps: [async () => 1],
  });
  assert.ok(seen.length > 0);
  assert.ok(seen.every(command => command.type === "assertTask" &&
    JSON.stringify(command.tabIds) === JSON.stringify(tabIds)));
});

test("a failure after one step discards success and skips remaining steps", async () => {
  let active = true, second = false, stopped = false;
  await assert.rejects(runGuardedSteps({
    taskId: "task_A", tabIds,
    send: async command => {
      if (command.type === "stopTask") { stopped = true; return { ok: true }; }
      return { ok: true, active };
    },
    steps: [async () => { active = false; return "not a valid success"; },
      async () => { second = true; }],
  }), /remaining steps/);
  assert.equal(second, false);
  assert.equal(stopped, true);
});

test("unavailable extension prevents execution and exposes stop uncertainty", async () => {
  let ran = false;
  await assert.rejects(runGuardedSteps({
    taskId: "task_A", tabIds, send: async () => { throw Error("Disconnected"); },
    steps: [async () => { ran = true; }],
  }), error => error.stopResult.ok === false && error.cause.message === "Disconnected");
  assert.equal(ran, false);
});

test("step exception fails run and requests task stop", async () => {
  let stopped = false;
  await assert.rejects(runGuardedSteps({
    taskId: "task_A", tabIds,
    send: async command => {
      if (command.type === "stopTask") stopped = true;
      return { ok: true, active: true };
    },
    steps: [async () => { throw Error("Step failed"); }],
  }), error => error.cause.message === "Step failed");
  assert.equal(stopped, true);
});

test("heartbeat interrupts the runner while a cooperative step is waiting", async () => {
  let active = true, aborted = false, next = false;
  await assert.rejects(runGuardedSteps({
    taskId: "task_A", tabIds, heartbeatMs: 5, commandTimeoutMs: 50, stepTimeoutMs: 200,
    send: async () => ({ ok: true, active }),
    steps: [
      ({ signal }) => new Promise(resolve => {
        active = false;
        signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
      }),
      async () => { next = true; },
    ],
  }), /remaining steps/);
  assert.ok(aborted);
  assert.equal(next, false);
});

test("hung extension and hung step have bounded failure", async () => {
  await assert.rejects(runGuardedSteps({
    taskId: "task_A", tabIds, commandTimeoutMs: 5, send: () => new Promise(() => {}), steps: [],
  }), error => error.cause.message.includes("timed out") && error.stopResult.ok === false);
  await assert.rejects(runGuardedSteps({
    taskId: "task_A", tabIds, stepTimeoutMs: 5, heartbeatMs: 100,
    send: async () => ({ ok: true, active: true }), steps: [() => new Promise(() => {})],
  }), error => error.cause.message.includes("late effects"));
});

function laneHarness(reply) {
  const sent = [];
  return {
    sent,
    send: async command => {
      sent.push(command);
      return reply(command);
    },
  };
}

const laneTask = { tabId: 10, env: "staging" };

test("lane task binds before the steps and revokes afterwards", async () => {
  const h = laneHarness(command => command.type === "init" ? { ok: true, ready: true }
    : command.type === "bindTask" ? { ok: true, committed: true }
      : command.type === "status" ? { ok: true, observations: {} }
        : { ok: true, active: true, committed: true });
  const run = await runLaneTask({ ...laneTask, ...h, steps: [async () => 1] });
  assert.deepEqual(run.results, [1]);
  const types = h.sent.map(command => command.type);
  assert.equal(types[0], "init");
  assert.equal(types[1], "bindTask");
  assert.ok(types.includes("stopTask"));
  assert.ok(types.slice(2, types.indexOf("stopTask")).every(type => type === "assertTask"));
  assert.equal(h.sent[1].env, "staging");
  assert.equal(h.sent[1].tabId, 10);
});

test("the task ID is generated per run and shared by every command", async () => {
  const h = laneHarness(command => command.type === "init" ? { ok: true, ready: true }
    : command.type === "bindTask" ? { ok: true, committed: true }
      : command.type === "status" ? { ok: true, observations: {} }
        : { ok: true, active: true, committed: true });
  const first = await runLaneTask({ ...laneTask, ...h, steps: [] });
  const second = await runLaneTask({ ...laneTask, ...h, steps: [] });
  assert.match(first.taskId, /^task_[A-Za-z0-9_-]{1,40}$/);
  assert.notEqual(first.taskId, second.taskId);
  for (const command of h.sent) {
    if (command.taskId) assert.ok([first.taskId, second.taskId].includes(command.taskId));
  }
  const ids = h.sent.filter(command => command.type === "bindTask").map(command => command.taskId);
  assert.deepEqual(ids, [first.taskId, second.taskId]);
});

test("an explicit task ID is still accepted", async () => {
  const h = laneHarness(command => command.type === "init" ? { ok: true, ready: true }
    : command.type === "bindTask" ? { ok: true, committed: true }
      : command.type === "status" ? { ok: true, observations: {} }
        : { ok: true, active: true, committed: true });
  const run = await runLaneTask({ ...laneTask, ...h, taskId: "task_A", steps: [] });
  assert.equal(run.taskId, "task_A");
  assert.equal(h.sent.find(command => command.type === "bindTask").taskId, "task_A");
});

test("a run reports the counters it observed", async () => {
  const counters = { checked: 3, mismatched: 1 };
  let bound;
  const run = await runLaneTask({
    ...laneTask,
    send: async command => {
      if (command.type === "init") return { ok: true, ready: true };
      if (command.type === "bindTask") { bound = command.taskId; return { ok: true, committed: true }; }
      if (command.type === "status") return { ok: true, observations: { [bound]: counters } };
      return { ok: true, active: true, committed: true };
    },
    steps: [async () => 1],
  });
  assert.deepEqual(run.observations, counters);
  assert.equal(bound, run.taskId);
});

test("an unreadable counter readback is null rather than a silent zero", async () => {
  const h = laneHarness(command => command.type === "init" ? { ok: true, ready: true }
    : command.type === "bindTask" ? { ok: true, committed: true }
      : command.type === "status" ? { ok: false, error: "Unavailable" }
        : { ok: true, active: true, committed: true });
  const run = await runLaneTask({ ...laneTask, ...h, steps: [] });
  assert.equal(run.observations, null);
});

test("a guard that cannot initialize never binds", async () => {
  const h = laneHarness(() => ({ ok: false, error: "Invalid sender" }));
  await assert.rejects(runLaneTask({ ...laneTask, ...h, steps: [] }), /did not initialize/);
  assert.deepEqual(h.sent.map(command => command.type), ["init"]);
});

test("an uncommitted binding never runs a step and is revoked", async () => {
  const h = laneHarness(command => command.type === "init" ? { ok: true, ready: true }
    : command.type === "bindTask" ? { ok: false, error: "Conflicting tab/window ownership" }
      : { ok: true, committed: true });
  let ran = false;
  await assert.rejects(runLaneTask({
    ...laneTask, ...h, steps: [async () => { ran = true; }],
  }), error => /Binding failed/.test(error.message) && error.stopResult.ok === true);
  assert.equal(ran, false);
  assert.deepEqual(h.sent.map(command => command.type), ["init", "bindTask", "stopTask"]);
});

test("an unanswered binding is treated as possibly committed", async () => {
  const sent = [];
  await assert.rejects(runLaneTask({
    ...laneTask,
    send: async command => {
      sent.push(command);
      if (command.type === "init") return { ok: true, ready: true };
      if (command.type === "bindTask") throw Error("Extension command timed out");
      return { ok: true, committed: true };
    },
    steps: [],
  }), error => /Binding uncertain/.test(error.message) && error.stopResult.ok === true);
  assert.deepEqual(sent.map(command => command.type), ["init", "bindTask", "stopTask"]);
});

test("a failed run still reports whether the task was revoked", async () => {
  const h = laneHarness(command => command.type === "init" ? { ok: true, ready: true }
    : command.type === "bindTask" ? { ok: true, committed: true }
      : command.type === "stopTask" ? { ok: true, committed: true }
        : { ok: false, error: "Task is not active" });
  await assert.rejects(runLaneTask({
    ...laneTask, ...h, steps: [async () => 1],
  }), error => /remaining steps/.test(error.message) && error.stopResult.committed === true);
});

test("a completed run fails loudly when the admission cannot be revoked", async () => {
  const h = laneHarness(command => command.type === "init" ? { ok: true, ready: true }
    : command.type === "bindTask" ? { ok: true, committed: true }
      : command.type === "stopTask" ? { ok: false, error: "Unknown task" }
        : { ok: true, active: true });
  await assert.rejects(runLaneTask({
    ...laneTask, ...h, steps: [async () => 1],
  }), error => /could not be revoked/.test(error.message) && error.stopResult.ok === false);
});

test("failures carry the task ID they used", async () => {
  const h = laneHarness(() => ({ ok: false, error: "Invalid sender" }));
  await assert.rejects(runLaneTask({ ...laneTask, ...h, steps: [] }),
    error => /^task_/.test(error.taskId));
});

test("lane task options are validated before any command is sent", async () => {
  const h = laneHarness(() => { throw Error("must not send"); });
  for (const options of [
    { ...laneTask, env: "" }, { ...laneTask, env: "has space" },
    { ...laneTask, taskId: "A" }, { ...laneTask, tabId: -1 },
  ]) {
    await assert.rejects(runLaneTask({ ...options, ...h, steps: [] }), /Invalid lane task options/);
  }
  assert.equal(h.sent.length, 0);
});
