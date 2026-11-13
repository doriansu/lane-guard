import { checkedUrl } from "./policy.js";

try {
  const url = checkedUrl(location.hash.slice(1));
  const tab = await chrome.tabs.getCurrent();
  const result = await chrome.runtime.sendMessage({ type: "gate", tabId: tab.id, url });
  if (!result?.ok || !result.committed) throw new Error(result?.error || "No admission acknowledgement");
  location.replace(url);
} catch (error) {
  document.querySelector("h1").textContent = "Navigation blocked";
  document.querySelector("#result").textContent = error.message;
}
