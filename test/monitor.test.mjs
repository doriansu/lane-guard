import test from "node:test";
import assert from "node:assert/strict";
import { projectRequest, headersMatch } from "../extension/monitor.js";
import { authorize, CONTROL_COMMANDS } from "../extension/messages.js";
import { CONFIG } from "../extension/config.js";

const details = {
  tabId: 10, url: "http://127.0.0.1:51843/__env_probe/echo?secret=do-not-save",
  requestHeaders: [
    { name: "X-LANE", value: "staging" }, { name: "x-lane-enabled", value: "1" },
    { name: "Authorization", value: "do-not-save" }, { name: "Cookie", value: "do-not-save" },
  ],
};

test("monitor projects only the configured routing headers and tab ID", () => {
  const observation = projectRequest(details);
  assert.equal(JSON.stringify(observation).includes("do-not-save"), false);
  assert.deepEqual(Object.keys(observation).sort(), ["envValues", "flagValues", "tabId", "type"]);
  assert.ok(headersMatch(observation, "staging"));
});

test("target requests are observed without retaining paths, cookies or query strings", () => {
  const observation = projectRequest({
    ...details, url: "https://app.example.com/app/dashboard/detail?secret=do-not-save",
  });
  assert.ok(headersMatch(observation, "staging"));
  assert.equal(JSON.stringify(observation).includes("do-not-save"), false);
});

test("missing, duplicate, binary and conflicting routing headers fail", () => {
  for (const headers of [
    [], details.requestHeaders.slice(0, 1),
    [...details.requestHeaders, { name: "x-lane", value: "staging" }],
    [{ name: "x-lane", binaryValue: [65] }, { name: "x-lane-enabled", value: "1" }],
    [{ name: "x-lane", value: "prod" }, { name: "x-lane-enabled", value: "1" }],
  ]) assert.equal(headersMatch(projectRequest({ ...details, requestHeaders: headers }), "staging"), false);
});

test("monitor ignores unrelated URLs, ports and unattributed traffic", () => {
  for (const url of ["https://example.com/", "http://127.0.0.1:51844/__env_probe/",
    "http://127.0.0.1:51843/events"]) assert.equal(projectRequest({ ...details, url }), null);
  assert.equal(projectRequest({ ...details, tabId: -1 }), null);
});

test("the flag header is optional", () => {
  assert.equal(CONFIG.flagHeader, "x-lane-enabled");
  const withoutFlag = projectRequest({ ...details, requestHeaders: details.requestHeaders.slice(0, 1) });
  assert.equal(headersMatch(withoutFlag, "staging"), CONFIG.flagHeader === null);
});

const origin = "chrome-extension://test";
const control = { id: "test", url: `${origin}/control.html`, tab: { id: 10 } };
test("public messages cannot manufacture monitor or lifecycle events", () => {
  for (const type of ["observeHeaders", "tabMoved", "removeTab", "removeWindow", "forceStopAll", "gate"]) {
    assert.throws(() => authorize({ type }, control, origin, "test"));
  }
  for (const type of CONTROL_COMMANDS) authorize({ type }, control, origin, "test");
});
test("foreign, malformed and gate impersonation messages are rejected", () => {
  for (const command of [null, undefined, "status", [], {}]) {
    assert.throws(() => authorize(command, control, origin, "test"));
  }
  assert.throws(() => authorize({ type: "status" }, { ...control, id: "foreign" }, origin, "test"));
  const gate = { ...control, url: `${origin}/gate.html#target` };
  authorize({ type: "gate", tabId: 10 }, gate, origin, "test");
  assert.throws(() => authorize({ type: "gate", tabId: 20 }, gate, origin, "test"));
  assert.throws(() => authorize({ type: "bindTask" }, gate, origin, "test"));
});
