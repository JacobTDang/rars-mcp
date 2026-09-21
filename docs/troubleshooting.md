# Troubleshooting

- **Health request fails:** Run `docker compose ps` and `docker compose logs rars-mcp`.
- **RARS artifact mismatch:** Remove `.cache/rars1_6.jar` and run the desktop launcher again. Do not bypass checksum verification.
- **No live session:** Confirm the desktop launcher is still running and `.runtime/token` plus `.runtime/port` exist. Restart Compose if it started before `.runtime` was created.
- **Authentication failure:** Stop old launchers, remove `.runtime`, and start the desktop launcher again. The gateway reads the current token when connecting.
- **Unsaved changes:** Save the GUI buffer, or pass `conflictPolicy: "discard"` only when losing those edits is intended.
- **Program never stops:** Headless runs use wall-clock and instruction limits. In a debug session, `continue` stops after `maxSteps` instructions (1,000,000 by default) and returns `stopReason: "step_limit"`; reset the session or continue again.
- **Stale session ID:** Call `rars_session_list`, reconnect if needed, and use the current ID.
