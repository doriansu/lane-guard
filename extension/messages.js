export const CONTROL_COMMANDS = new Set([
  "init", "status", "bindTask", "bindManual", "stopTask", "assertTask", "reportMismatch", "resetClosedTasks",
]);

export function authorize(command, sender, origin, extensionId) {
  if (!command || typeof command !== "object" || Array.isArray(command) ||
      typeof command.type !== "string") throw new Error("Invalid command");
  if (sender.id !== extensionId) throw new Error("Foreign sender");
  if (sender.url === `${origin}/control.html`) {
    if (!CONTROL_COMMANDS.has(command.type)) throw new Error("Command is not exposed to control pages");
    return;
  }
  if (!sender.url?.startsWith(`${origin}/gate.html#`) || command.type !== "gate" ||
      sender.tab?.id !== command.tabId) throw new Error("Gate may only admit its own tab");
}
