import { ENV_NAME, TASK_ID } from "./extension/policy.js";

// send(command) must call the extension's control page and return its reply.
// AbortSignal is cooperative: callers must cancel or close their own in-flight
// browser work. A rejected race does not prove that the action was rolled back.

async function bounded(action, ms, message) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function revoke(dispatch, taskId) {
  try { return await dispatch({ type: "stopTask", taskId }); }
  catch (error) { return { ok: false, error: String(error) }; }
}

// The task ID namespaces the binding and is the unit stopTask revokes. It is an
// internal handle, so callers never choose one; a stopped ID is a tombstone and
// must not be reused, which a fresh ID per run guarantees.
function newTaskId() {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36) + Math.random().toString(36);
  return `task_${random.replace(/[^A-Za-z0-9]/g, "").slice(0, 32)}`;
}

// Reading the counters back is part of the run, not an optional follow-up: a
// mismatch means a request left in the wrong environment and must be reported.
async function observations(dispatch, taskId) {
  try {
    const reply = await dispatch({ type: "status" });
    return reply?.ok ? reply.observations?.[taskId] ?? null : null;
  } catch { return null; }
}

// Binds one tab, runs the steps under the guarded runner, and revokes the task
// whatever happens. Binding before navigation and stopping afterwards are
// safety orderings, not advice, so the caller never issues either command.
export async function runLaneTask({
  send, tabId, env, steps, taskId,
  commandTimeoutMs = 5000, stepTimeoutMs = 60000, heartbeatMs = 500,
}) {
  if (typeof send !== "function" || !Array.isArray(steps) || !steps.every(step => typeof step === "function") ||
      (taskId !== undefined && (typeof taskId !== "string" || !TASK_ID.test(taskId))) ||
      !Number.isSafeInteger(tabId) || tabId < 0 ||
      typeof env !== "string" || !ENV_NAME.test(env) ||
      ![commandTimeoutMs, stepTimeoutMs, heartbeatMs].every(ms => Number.isSafeInteger(ms) && ms > 0)) {
    throw new Error("Invalid lane task options");
  }
  const id = taskId ?? newTaskId();
  const dispatch = command => bounded(() => send(command), commandTimeoutMs, "Extension command timed out");
  const fail = (message, extra = {}) => Object.assign(new Error(message), { taskId: id, ...extra });
  // init is idempotent and re-installs the static gate rules after a restart.
  const ready = await dispatch({ type: "init" });
  if (!ready?.ok || !ready.ready) {
    throw fail(`Guard did not initialize: ${ready?.error || "no acknowledgement"}`);
  }
  // An unanswered bind may still have committed, so revoke before reporting.
  let bind;
  try {
    bind = await dispatch({ type: "bindTask", taskId: id, env, tabId });
  } catch (error) {
    throw fail(`Binding uncertain: ${error.message}`, { stopResult: await revoke(dispatch, id) });
  }
  if (!bind?.ok || !bind.committed) {
    throw fail(`Binding failed: ${bind?.error || "no acknowledgement"}`,
      { stopResult: await revoke(dispatch, id) });
  }
  const results = await runGuardedSteps({
    send, taskId: id, tabIds: [tabId], steps, commandTimeoutMs, stepTimeoutMs, heartbeatMs,
  });
  const stop = await revoke(dispatch, id);
  const observed = await observations(dispatch, id);
  if (!stop.ok || !stop.committed) {
    throw fail(
      `Steps completed but the task admission could not be revoked: ${stop.error || "no acknowledgement"}`,
      { stopResult: stop, observations: observed });
  }
  return { taskId: id, results, observations: observed };
}

export async function runGuardedSteps({
  send, taskId, tabIds, steps, commandTimeoutMs = 5000, stepTimeoutMs = 60000, heartbeatMs = 500,
}) {
  // tabIds is required: a step not tied to a declared, bound tab cannot be
  // checked, so the runner could only fail after the wrong request went out.
  if (typeof send !== "function" || !Array.isArray(steps) || !steps.every(step => typeof step === "function") ||
      typeof taskId !== "string" || !TASK_ID.test(taskId) ||
      !Array.isArray(tabIds) || !tabIds.length ||
      !tabIds.every(id => Number.isSafeInteger(id) && id >= 0) ||
      ![commandTimeoutMs, stepTimeoutMs, heartbeatMs].every(ms => Number.isSafeInteger(ms) && ms > 0)) {
    throw new Error("Invalid guarded runner options");
  }
  const results = [];
  const dispatch = command => bounded(() => send(command), commandTimeoutMs, "Extension command timed out");
  async function check() {
    const reply = await dispatch({ type: "assertTask", taskId, tabIds });
    if (!reply?.ok || !reply.active) throw new Error(reply?.error || "No active-task acknowledgement");
  }
  try {
    await check();
    for (const step of steps) {
      await check();
      const controller = new AbortController();
      let interval, checking = false;
      try {
        const unhealthy = new Promise((_, reject) => {
          interval = setInterval(async () => {
            if (checking) return;
            checking = true;
            try { await check(); } catch (error) { reject(error); }
            finally { checking = false; }
          }, heartbeatMs);
        });
        const result = await bounded(() => Promise.race([
          Promise.resolve().then(() => step({ signal: controller.signal })), unhealthy,
        ]), stepTimeoutMs, "Step timed out; in-flight action may have late effects");
        await check();
        results.push(result);
      } finally {
        clearInterval(interval);
        controller.abort();
      }
    }
    await check();
    return results;
  } catch (error) {
    const failure = new Error("Guarded run failed; remaining steps were not executed", { cause: error });
    failure.stopResult = await revoke(dispatch, taskId);
    throw failure;
  }
}
