import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';

const runtime = process.argv[2];
await mkdir(runtime, { recursive: true });
const token = 'a'.repeat(64);
const server = createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n');
      const request = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      const result = request.command === 'hello'
        ? { protocolVersion: 1, mode: 'live' }
        : request.command === 'inspect'
          ? { status: 'paused', registers: { a0: 9 } }
          : { status: 'paused' };
      const valid = request.command !== 'hello' || request.payload.token === token;
      socket.write(`${JSON.stringify(valid
        ? { protocolVersion: 1, id: request.id, ok: true, result }
        : { protocolVersion: 1, id: request.id, ok: false, error: { code: 'AUTHENTICATION_FAILED', message: 'Invalid token' } })}\n`);
    }
  });
});
await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
await writeFile(`${runtime}/token`, `${token}\n`, { mode: 0o600 });
await writeFile(`${runtime}/port`, `${server.address().port}\n`, { mode: 0o600 });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
