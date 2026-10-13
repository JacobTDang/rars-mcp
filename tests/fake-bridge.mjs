// Stands in for the Java bridge in tests. It prints its port the way BridgeServer does and answers
// hello, load and inspect; its argument decides what it does with the first debug command:
//   answer    answers it
//   reset     resets the connection
//   exit      exits with code 3
//   stuck     answers nothing from then on, not even a pause
//   pausable  holds a continue, and every request after it, until a pause arrives; like the
//             real bridge, it then answers the continue, which has printed a line, the held
//             requests and the pause in order
import { createServer } from 'node:net';

const mode = process.argv[2];
let stuck = false;
let held;
const queued = [];

function reply(socket, request, result) {
  socket.write(`${JSON.stringify({ protocolVersion: 1, id: request.id, ok: true, result })}\n`);
}

function answer(socket, request, stdout = '') {
  if (request.command === 'hello') return reply(socket, request, { protocolVersion: 1, mode: 'headless' });
  const state = { status: 'paused', stdout, stderr: '' };
  if (request.command !== 'command') return reply(socket, request, state);
  return reply(socket, request, { ...state, stopReason: request.payload.action === 'step' ? 'step' : 'paused' });
}

function handle(socket, request) {
  if (stuck) return;
  if (request.command !== 'command') return held ? queued.push(request) : answer(socket, request);
  if (mode === 'answer') return answer(socket, request);
  if (mode === 'reset') return socket.resetAndDestroy();
  if (mode === 'exit') return process.exit(3);
  if (mode === 'stuck') {
    stuck = true;
    return;
  }
  if (mode === 'pausable') {
    if (request.payload.action === 'pause') {
      if (held) answer(socket, held, 'output of the run\n');
      held = undefined;
      for (const waiting of queued.splice(0)) answer(socket, waiting);
      return answer(socket, request);
    }
    if (held) return queued.push(request);
    if (request.payload.action === 'continue') {
      held = request;
      return;
    }
    return answer(socket, request);
  }
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
