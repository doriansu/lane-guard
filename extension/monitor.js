import { checkedUrl } from "./policy.js";
import { CONFIG } from "./config.js";

// Discard URLs, cookies and all unrelated headers before crossing async queues.
export function projectRequest(details) {
  try { checkedUrl(details.url); } catch { return null; }
  if (!Number.isInteger(details.tabId) || details.tabId < 0) return null;
  const values = name => (details.requestHeaders || [])
    .filter(header => header.name.toLowerCase() === name.toLowerCase())
    .map(header => typeof header.value === "string" ? header.value.slice(0, 128) : null);
  return {
    type: "observeHeaders", tabId: details.tabId,
    envValues: values(CONFIG.envHeader),
    flagValues: CONFIG.flagHeader ? values(CONFIG.flagHeader) : [],
  };
}

export function headersMatch(observation, env) {
  const flagOk = !CONFIG.flagHeader ||
    (observation.flagValues.length === 1 && observation.flagValues[0] === CONFIG.flagValue);
  return observation.envValues.length === 1 && observation.envValues[0] === env && flagOk;
}
