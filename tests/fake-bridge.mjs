// Stands in for the Java bridge in tests. It prints its port the way BridgeServer does and answers
// hello, load and inspect; its argument decides what it does with the first debug command:
//   answer  answers it
//   reset   resets the connection
import { createServer } from 'node:net';

const mode = process.argv[2];

function reply(socket, request, result) {
  socket.write(`${JSON.stringify({ protocolVersion: 1, id: request.id, ok: true, result })}\n`);
}

function handle(socket, request) {
  if (request.command === 'hello') return reply(socket, request, { protocolVersion: 1, mode: 'headless' });
  if (request.command !== 'command') return reply(socket, request, { status: 'paused' });
  if (mode === 'answer') return reply(socket, request, { status: 'paused', stopReason: 'step' });
  if (mode === 'reset') return socket.resetAndDestroy();
  throw new Error(`Unknown fake bridge mode: ${mode}`);
}

const server = createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const request = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      handle(socket, request);
    }
  });
});
server.listen(0, '127.0.0.1', () => console.error(`RARS_MCP_PORT=${server.address().port}`));
