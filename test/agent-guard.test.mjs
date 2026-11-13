import test from "node:test";
import assert from "node:assert/strict";
import { runGuardedSteps } from "../agent-guard.mjs";

test("guarded runner returns results only while task stays active", async () => {
  const results = await runGuardedSteps({
    taskId: "task_A", send: async () => ({ ok: true, active: true }),
    steps: [async () => 1, async () => 2],
  });
  assert.deepEqual(results, [1, 2]);
});

test("a failure after one step discards success and skips remaining steps", async () => {
  let active = true, second = false, stopped = false;
  await assert.rejects(runGuardedSteps({
    taskId: "task_A",
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
    taskId: "task_A", send: async () => { throw Error("Disconnected"); },
    steps: [async () => { ran = true; }],
  }), error => error.stopResult.ok === false && error.cause.message === "Disconnected");
  assert.equal(ran, false);
});

test("step exception fails run and requests task stop", async () => {
  let stopped = false;
  await assert.rejects(runGuardedSteps({
    taskId: "task_A",
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
    taskId: "task_A", heartbeatMs: 5, commandTimeoutMs: 50, stepTimeoutMs: 200,
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
    taskId: "task_A", commandTimeoutMs: 5, send: () => new Promise(() => {}), steps: [],
  }), error => error.cause.message.includes("timed out") && error.stopResult.ok === false);
  await assert.rejects(runGuardedSteps({
    taskId: "task_A", stepTimeoutMs: 5, heartbeatMs: 100,
    send: async () => ({ ok: true, active: true }), steps: [() => new Promise(() => {})],
  }), error => error.cause.message.includes("late effects"));
});
