import { gateRules, GATE_RULE_IDS } from "./policy.js";
import { CONFIG } from "./config.js";
import { createCoordinator } from "./coordinator.js";
import { projectRequest } from "./monitor.js";
import { authorize } from "./messages.js";

const run = createCoordinator({
  storage: chrome.storage.session,
  dnr: chrome.declarativeNetRequest,
  getTab: id => chrome.tabs.get(id),
  getTabs: async () => (await chrome.tabs.query({})).map(tab => ({ id: tab.id })),
});

async function initializeGate() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: GATE_RULE_IDS,
    addRules: gateRules(chrome.runtime.getURL("").replace(/\/$/, "")),
  });
}

chrome.runtime.onMessage.addListener((command, sender, reply) => {
  try {
    authorize(command, sender, chrome.runtime.getURL("").replace(/\/$/, ""), chrome.runtime.id);
  } catch (error) {
    reply({ ok: false, error: error.message });
    return false;
  }
  (async () => {
    if (command.type === "init") {
      await initializeGate();
      await run({ type: "status" });
      return { ready: true, version: chrome.runtime.getManifest().version };
    }
    return run(command);
  })().then(result => reply({ ok: true, ...result }), error => reply({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  initializeGate().catch(console.error);
});

chrome.tabs.onRemoved.addListener(tabId => {
  run({ type: "removeTab", tabId }).catch(console.error);
});

async function eventFailure() {
  // The event cannot recall a request already sent; deny subsequent traffic.
  try {
    await run({ type: "forceStopAll" });
  } catch {
    console.error("Lane Guard emergency block failed; browser protection is uncertain");
  }
}

chrome.tabs.onDetached.addListener(tabId => {
  run({ type: "tabMoved", tabId }).catch(eventFailure);
});
chrome.windows.onRemoved.addListener(windowId => {
  run({ type: "removeWindow", windowId }).catch(eventFailure);
});
chrome.webRequest.onSendHeaders.addListener(details => {
  const command = projectRequest(details);
  if (command) run(command).catch(eventFailure);
}, { urls: CONFIG.targets.map(target => `${target.origin}/*`) },
["requestHeaders", "extraHeaders"]);

run({ type: "status" }).catch(console.error);
