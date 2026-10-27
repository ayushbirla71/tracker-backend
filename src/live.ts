import type { WebSocket } from 'ws';

/** Admin browsers connected to /ws/admin. */
const clients = new Set<WebSocket>();

export function addLiveClient(socket: WebSocket) {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
}

export function broadcast(message: unknown) {
  const data = JSON.stringify(message);
  for (const socket of clients) {
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}
