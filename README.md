# Lane Guard

Per-tab environment isolation for AI browser automation.

An agent and a human often share one browser. When environments are selected by
an HTTP header, a browser-wide proxy or extension setting routes *everything* to
one environment. Lane Guard instead rewrites routing headers **only on the tabs
you explicitly bind**, so an agent can drive staging while every other tab keeps
its normal routing.

## How it works

Lane Guard is a Chrome Manifest V3 extension. Binding a tab installs three
`declarativeNetRequest` session rules scoped to that tab ID:

| Priority | Action | Purpose |
| --- | --- | --- |
| 4 | `modifyHeaders` | Writes the environment header (and optional flag header) |
| 3 | `allow` | Admits the configured URL scopes |
| 1 | `block` | Retained after stop, so a stopped tab cannot fall back to default routing |

Design decisions worth knowing before you rely on it:

- **Fail closed.** A static deny rule is installed before any tab is admitted.
  Unbound tabs that reach a gated target are redirected to an admission page,
  which only releases the request after the binding is durably committed.
- **Non-atomic commits are treated as failures.** `chrome.storage` and DNR rules
  cannot be written atomically. Every transition parks affected tabs behind a
  temporary quarantine rule until both sides are durable; an interrupted commit
  revokes all admissions and does not resume automatically.
- **Stopping is not a reset.** A stopped task keeps its deny rule. Its tabs must
  be closed before a new task can be bound.
- **The monitor is observational.** `webRequest.onSendHeaders` reports the
  headers that actually left the browser. It can stop a task after a mismatch,
  but it cannot recall the request that already went out.

## Setup

1. Edit `extension/config.js`:
   - `envHeader` / `flagHeader` — the headers your environment router reads.
   - `targets` — the origin and path prefix pairs Lane Guard may touch.
     `gate: true` enables the admission page for that target and requires a
     matching static rule in `extension/deny.json`.
2. Update `host_permissions` in `extension/manifest.json` to cover the same
   origins. Chrome does not grant host access from a config file, so this step
   cannot be automated.
3. Load the extension: open `chrome://extensions`, enable Developer mode, choose
   **Load unpacked**, and select the `extension/` directory.
4. Open `chrome-extension://<extension-id>/control.html` in a control tab.

## Usage

Wrap agent actions so that a dead binding stops the run instead of silently
continuing:

```js
import { runLaneTask } from "./agent-guard.mjs";

const { taskId, results, observations } = await runLaneTask({
  tabId: tab.id,
  env: "staging",
  send: command => controlPage.evaluate(
    command => window.probe.call(command), command
  ),
  steps: [async ({ signal }) => {
    // Operate only the declared, bound page. Honor the signal.
  }],
});
```

`runLaneTask` generates the task ID, initializes the guard, binds the tab,
checks the binding before and after every step and on a heartbeat, then revokes
the task on every path — success, step failure, or an unanswered bind. The
remaining steps never run after a failure. Binding before navigation and
revoking afterwards are orderings the runner owns, not steps the caller is
trusted to perform.

The task ID is an internal handle, not a label: it namespaces the binding, pins
the environment, and is the unit `stopTask` revokes. Callers never choose one.
A stopped ID is a tombstone and cannot be reused, so a fresh ID per run is what
keeps repeated runs from colliding.

`observations` is the extension's `{ checked, mismatched }` count for the run,
or `null` if it could not be read back. A non-zero `mismatched` means a request
left in the wrong environment before the monitor could stop it; report it
rather than treating the run as a pass.

### Driving the commands directly

`runLaneTask` is the supported path. If you need the raw protocol, you must
supply the task ID yourself; bind from a control tab:

```js
await window.probe.call({ type: "init" });
const tab = await window.probe.currentTab();
await window.probe.call({
  type: "bindTask",
  taskId: "task_example",
  env: "staging",
  tabId: tab.id,
});
```

Navigate the bound tab only after a reply with `ok: true` and
`committed: true`. An environment is immutable for the lifetime of a task; to
switch environments, stop the task and use a new task ID. A tab that already
reached a guarded target — including one parked on the admission gate — cannot
be bound; bind a fresh tab before its first navigation, or its earlier requests
are already in the wrong lane.

`runGuardedSteps` is the lower-level half of the runner. It takes an explicit
`taskId` and requires `tabIds`; a step not tied to a declared, bound tab cannot
be checked, so it would only fail after the wrong request had already gone out.

## Local end-to-end check

`fixture.py` is a local echo server that records the routing headers it
receives. It uses the default `127.0.0.1:51843` target in `config.js`.

```sh
python3 fixture.py --output /tmp/lane-guard-events.jsonl   # terminal 1
npm test                                                    # terminal 2
```

Then bind a tab, navigate it to `http://127.0.0.1:51843/__env_probe/page`, and
compare the headers the fixture recorded against the environment you bound.
`GET http://127.0.0.1:51843/events` returns everything the server saw.

## Commands

| Command | Effect |
| --- | --- |
| `init` | Install gate rules and load state |
| `bindTask` | Bind a tab to an environment |
| `bindManual` | Register a tab as unmanaged traffic (no header rewrite) |
| `stopTask` | Revoke a task's admission, retain its deny |
| `assertTask` | Verify a task and its operation tabs are still active |
| `reportMismatch` | Stop a task on an externally detected mismatch |
| `resetClosedTasks` | Clear recovered state after guarded tabs are closed |
| `status` | Dump state, session rules and observation counters |

## Limits

- Only explicitly bound tabs are covered. Popups and new tabs do not inherit
  bindings automatically; bind each one before its first navigation.
- Requests from service workers without a tab ID are not attributed.
- **The first mismatched request cannot be recalled.** If you require zero
  wrong-environment requests, this extension is insufficient — routing must
  fail closed at a proxy or backend boundary instead.
- Header precedence between extensions must be measured in the actual browser.
  Installation order is not a safety guarantee.
- Removing or disabling the extension removes all protection.

## Tests

```sh
npm test
```

The suite covers rule scope, commit recovery at every transaction boundary,
concurrent command serialization, storage failure, lifecycle invalidation and
the guarded runner.

## License

MIT. See `LICENSE`.
