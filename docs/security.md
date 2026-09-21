# Security

The gateway accepts files only from the configured workspace folders after resolving symlinks and canonical paths. Runs have wall-clock and output limits. The Compose service binds to `127.0.0.1`, runs as the unprivileged `node` user, and mounts only `./workspace`.

Treat every configured MCP client as trusted: it can run any RISC-V source inside the mounted workspace and can mutate a connected GUI session. Do not expose port 3000 beyond localhost. The desktop bridge binds to loopback, and its 256-bit token is stored in the ignored `.runtime/` directory with user-only permissions. Never commit or print that token.
