---
name: Platform Dev workflow fix
description: How dev-server.mjs and the Platform Dev workflow must be configured for Replit's runner to accept them.
---

## Rules

1. **`waitForPort` must be omitted** from the `Platform Dev` workflow config.  
   Replit's port checker goes through the external routing layer (localhost:80 → artifact routing → localPort 5173), and when both the check and the port binding race each other at startup, the check always loses. Removing `waitForPort` skips the check entirely; the runner marks the workflow as started immediately.

2. **dev-server.mjs must handle SIGTERM cleanly** (kill Vite, then exit). Ignoring SIGTERM causes the old process to hold the port when `restart_workflow` tries to start a fresh one — the new process can't bind, and everything fails.

3. **Vite must run in the same process group** (`detached: false`). With `detached: true`, Vite survives when dev-server.mjs is killed. Multiple accumulated Vite instances hold port VITE_PORT, causing `strictPort: true` to make the next Vite immediately exit.

4. **Proxy must bind to `0.0.0.0`** (not `::`). The proxy is what Replit tracks as the workflow's port — it must be the direct process of dev-server.mjs (not a child). IPv4-only binding avoids any dual-stack ambiguity in the container.

5. **`artifacts/platform: web`** is managed by the artifact system and cannot be reliably restarted via `restart_workflow`. It will stay "failed" — this is OK. The `Platform Dev` workflow (without waitForPort) is the authoritative webview.

6. **vite.config.ts `server.host`** should be `"0.0.0.0"` (not `"::"`), since IPv6-only binding causes the Replit proxy to fail to reach Vite when forwarding through 127.0.0.1.

**Why:** Discovered through systematic debugging — direct `curl http://127.0.0.1:PORT/` returned HTTP 200 but `restart_workflow` always reported "DIDNT_OPEN_A_PORT". Root cause traced to: (a) waitForPort checking through external routing layer that has a race, and (b) SIGTERM-ignoring causing port lock between restart cycles.

**How to apply:** Any time Platform Dev needs to be reconfigured, use `configureWorkflow({ name: "Platform Dev", command: "PORT=5173 node artifacts/platform/dev-server.mjs", outputType: "webview" })` — no `waitForPort` argument.
