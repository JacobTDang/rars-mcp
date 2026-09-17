# Security

The gateway accepts files only from the configured workspace after resolving symlinks and canonical paths. Runs have wall-clock and output limits. The Compose service binds to `127.0.0.1`, runs as the unprivileged `node` user, and mounts only `./workspace`.

Treat every configured MCP client as trusted: it can run any RISC-V source inside the mounted workspace and can mutate a connected GUI session. Do not expose port 3000 beyond localhost. The desktop bridge binds to loopback, and its 256-bit token is stored in the ignored `.runtime/` directory with user-only permissions. Never commit or print that token.

The optional hardware worker treats HDL, testbenches, and repository commands as executable input. It receives the workspace read-only and is reachable only through an internal Compose network. The supervisor retains a narrow set of identity and file-management capabilities, but every workload is demoted to a private per-slot UID/GID and can traverse only its read-only snapshot and private build/artifact directories. It does not receive the RARS live-session mount or token. Per-job memory, PID, time, output, and live artifact limits plus container CPU/memory/PID ceilings reduce denial-of-service risk.

The internal Compose network prevents ordinary external routing for the worker, but Docker isolation is not a security boundary for hostile multi-tenant code. Repository commands are disabled by default and should be enabled only for projects you trust. Never mount the Docker socket, SSH directories, cloud credentials, or broad host directories into the worker.
