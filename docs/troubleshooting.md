# Troubleshooting

- **Health request fails:** Run `docker compose ps` and `docker compose logs rars-mcp`.
- **RARS artifact mismatch:** Remove `.cache/rars1_6.jar` and run the desktop launcher again. Do not bypass checksum verification.
- **No live session:** Confirm the desktop launcher is still running and `.runtime/token` plus `.runtime/port` exist. Restart Compose if it started before `.runtime` was created.
- **Authentication failure:** Stop old launchers, remove `.runtime`, and start the desktop launcher again. The gateway reads the current token when connecting.
- **Unsaved changes:** Save the GUI buffer, or pass `conflictPolicy: "discard"` only when losing those edits is intended.
- **Program never stops:** Headless runs use wall-clock and instruction limits. In a debug session, `continue` stops after `maxSteps` instructions (1,000,000 by default) and returns `stopReason: "step_limit"`; reset the session or continue again.
- **`RARS bridge did not start within … ms`:** The Java bridge did not report its port and answer within `RARS_EXECUTION_TIMEOUT_MS`, so it was killed. Raise the limit on a slow or loaded machine. `RARS bridge exited during startup` means it stopped first. Both errors include what the bridge printed.
- **`SESSION_FAILED`:** The session's bridge connection failed (`RARS bridge connection failed: …`, or `Live RARS connection failed: …` when the desktop session went away), so the session was removed. Start a new session, or reconnect to the desktop session.
- **Stale session ID:** Call `rars_session_list`, reconnect if needed, and use the current ID. A debug session closes after 30 minutes without requests (`RARS_SESSION_IDLE_MS`) and then reports `SESSION_EXPIRED`.
