import net from 'node:net';

// Minimal Source RCON (SERVERDATA_AUTH / SERVERDATA_EXECCOMMAND) server for tests.
export function startFakeRcon({ password = 'secret', port = 0, saveAllDelayMs = 0 } = {}) {
  return new Promise((resolve) => {
    const connections = new Set();
    const server = net.createServer((socket) => {
      connections.add(socket);
      let authenticated = false;
      let buffer = Buffer.alloc(0);
      socket.on('close', () => connections.delete(socket));
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readInt32LE(0);
          if (buffer.length < 4 + length) break;
          const packet = buffer.subarray(4, 4 + length);
          buffer = buffer.subarray(4 + length);
          const id = packet.readInt32LE(0);
          const type = packet.readInt32LE(4);
          const body = packet.subarray(8, packet.length - 2).toString('utf8');

          if (type === 3) {
            authenticated = body === password;
            send(socket, authenticated ? id : -1, 2, '');
            if (!authenticated) setTimeout(() => socket.destroy(), 20);
          } else if (type === 2) {
            if (!authenticated) {
              socket.destroy();
              continue;
            }
            const reply = respond(body, saveAllDelayMs);
            if (reply === null) continue;
            send(socket, id, 0, reply);
            if (body === 'stop') setTimeout(() => socket.destroy(), 20);
          }
        }
      });
    });

    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            for (const socket of connections) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

function respond(command, saveAllDelayMs) {
  if (command === 'list') return 'There are 0 of a max of 20 players online:';
  if (command === 'save-off') return 'Warning, saving is already disabled!';
  if (command === 'save-on') return 'Warning, saving is already enabled!';
  if (command.startsWith('save-all')) {
    // A positive delay models a server that never answers, so callers must time out.
    if (saveAllDelayMs > 0) return null;
    return 'Saved the game';
  }
  if (command === 'stop') return 'Stopping server';
  return `ok: ${command}`;
}

function send(socket, id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const length = 4 + 4 + payload.length + 2;
  const packet = Buffer.alloc(4 + length);
  packet.writeInt32LE(length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  packet.writeInt16LE(0, 12 + payload.length);
  socket.write(packet);
}
