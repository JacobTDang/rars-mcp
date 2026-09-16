# Security

The gateway accepts files only from the configured workspace after resolving symlinks and canonical paths. Runs have wall-clock and output limits. The Compose service binds to `127.0.0.1`, runs as the unprivileged `node` user, and mounts only `./workspace`.

Treat every configured MCP client as trusted: it can run any RISC-V source inside the mounted workspace. Do not expose port 3000 beyond localhost. Desktop bridge tokens introduced by the live-session milestone must remain outside source control and readable only by the current user.
