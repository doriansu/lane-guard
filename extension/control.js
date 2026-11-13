window.probe = {
  async currentTab() {
    const tab = await chrome.tabs.getCurrent();
    if (!tab) throw new Error("Open control.html in a browser tab, not the toolbar popup");
    return { id: tab.id, windowId: tab.windowId };
  },
  async call(command) {
    const result = await chrome.runtime.sendMessage(command);
    document.querySelector("#result").textContent = JSON.stringify(result, null, 2);
    return result;
  },
};
document.querySelector("#init").onclick = () => window.probe.call({ type: "init" });
document.querySelector("#status").onclick = () => window.probe.call({ type: "status" });
