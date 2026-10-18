// Connection registry: which gateway node holds each charger's live socket.
// Single-node build keeps it in memory; with several nodes this moves to Redis so commands route
// to the right node (Requirements 3, "Several gateway servers").
import { cluster } from './cluster.js';

const connections = new Map();

export const registry = {
  set(ocppId, conn) {
    connections.set(ocppId, conn);
  },
  get(ocppId) {
    return connections.get(ocppId);
  },
  delete(ocppId, conn) {
    if (!conn || connections.get(ocppId) === conn) connections.delete(ocppId);
  },
  size() {
    return connections.size;
  },
  ids() {
    return [...connections.keys()];
  },
  /** Connected to this node, or (cluster mode) to another node. */
  isConnected(ocppId) {
    const c = connections.get(ocppId);
    if (c && !c.closed) return true;
    return !!cluster().remoteOwner(ocppId);
  },
};

// Gateway stats for the health panel.
export const stats = { messagesIn: 0, messagesOut: 0, errors: 0, startedAt: Date.now(), window: [] };
export function countMessage(dir) {
  if (dir === 'in') stats.messagesIn += 1;
  else stats.messagesOut += 1;
  const sec = Math.floor(Date.now() / 1000);
  const last = stats.window[stats.window.length - 1];
  if (last && last.sec === sec) last.n += 1;
  else stats.window.push({ sec, n: 1 });
  while (stats.window.length && stats.window[0].sec < sec - 60) stats.window.shift();
}
export function messagesPerSecond() {
  const n = stats.window.reduce((s, w) => s + w.n, 0);
  return Math.round((n / 60) * 100) / 100;
}
