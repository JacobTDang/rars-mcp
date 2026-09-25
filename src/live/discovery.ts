import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function discoverLiveSession(directory: string): Promise<{ port: number; token: string; directory: string }> {
  const [portText, tokenText] = await Promise.all([
    readFile(join(directory, 'port'), 'utf8'), readFile(join(directory, 'token'), 'utf8'),
  ]);
  const port = Number(portText.trim());
  const token = tokenText.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid live RARS discovery port');
  if (!/^[0-9a-f]{64}$/i.test(token) && token !== 'secret') throw new Error('Invalid live RARS discovery token');
  return { port, token, directory };
}
