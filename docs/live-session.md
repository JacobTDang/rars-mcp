# Live RARS desktop sessions

Run the gateway first:

```sh
mkdir -p workspace .runtime
docker compose up -d --build
```

Then double-click `scripts/launch-rars-mcp.command` in Finder or run it from Terminal. The launcher verifies RARS 1.6, builds the companion bridge, creates a 256-bit token in `.runtime/token`, writes the selected loopback port to `.runtime/port`, and opens the normal RARS GUI.

Call `rars_live_connect` once. Use the returned session ID with `rars_live_command`. Supported actions are `load`, `step`, `backstep`, `continue`, `pause`, `reset`, `terminate`, `breakpoint_add`, `breakpoint_remove`, `inspect`, and `modify`.

`load` defaults to `conflictPolicy: "reject"`. If an open buffer has unsaved changes, save it or explicitly use `conflictPolicy: "discard"`. A session from `rars_debug_start` keeps the program it started with and refuses `load`. Disconnecting an MCP session does not close the RARS GUI, but stops a `continue` it left running.

`pause` stops a `continue` that is still running. If the desktop session closes or drops the connection, the MCP session is removed and later requests on its ID fail with `SESSION_FAILED`; call `rars_live_connect` again.
