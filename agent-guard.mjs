// send(command) must call the extension's control page and return its reply.
// AbortSignal is cooperative: callers must cancel or close their own in-flight
// browser work. A rejected race does not prove that the action was rolled back.
export async function runGuardedSteps({
  send, taskId, tabIds, steps, commandTimeoutMs = 5000, stepTimeoutMs = 60000, heartbeatMs = 500,
}) {
  if (typeof send !== "function" || !Array.isArray(steps) || !steps.every(step => typeof step === "function") ||
      typeof taskId !== "string" || !/^task_[A-Za-z0-9_-]{1,40}$/.test(taskId) ||
      (tabIds !== undefined && (!Array.isArray(tabIds) || !tabIds.length ||
        !tabIds.every(id => Number.isSafeInteger(id) && id >= 0))) ||
      ![commandTimeoutMs, stepTimeoutMs, heartbeatMs].every(ms => Number.isSafeInteger(ms) && ms > 0)) {
    throw new Error("Invalid guarded runner options");
  }
  const results = [];
  async function bounded(action, ms, message) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(action),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  const dispatch = command => bounded(() => send(command), commandTimeoutMs, "Extension command timed out");
  async function check() {
    const reply = await dispatch({ type: "assertTask", taskId, ...(tabIds ? { tabIds } : {}) });
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
    let cleanup;
    try {
      cleanup = await dispatch({ type: "stopTask", taskId });
    } catch (failure) {
      cleanup = { ok: false, error: String(failure) };
    }
    const failure = new Error("Guarded run failed; remaining steps were not executed", { cause: error });
    failure.stopResult = cleanup;
    throw failure;
  }
}
