// Multi-instance support over Redis (Requirements 9: "Redis registry records which server holds each
// charger's connection, so commands are routed correctly").
//
//   presence  — each node announces the chargers it holds; others keep a TTL'd mirror (isConnected stays sync)
//   commands  — a command for a charger held by another node is relayed over pub/sub and answered back
//   sessions  — live session changes are fanned out so SSE clients on any node see them
//   leader    — one node holds a lock and runs the background jobs
//
// Disabled (single node, in-process) unless REDIS_URL is set. REDIS_URL=mock uses ioredis-mock (tests).
import os from 'node:os';
import { randomId } from '../lib/util.js';
import { logger } from '../lib/logger.js';

const PRESENCE_TTL_MS = 90_000;
const BEAT_MS = 30_000;
const LOCK_MS = 30_000;

export async function redisFactory(url) {
  if (url === 'mock') {
    const { default: RedisMock } = await import('ioredis-mock');
    return () => new RedisMock();
  }
  const { default: Redis } = await import('ioredis');
  return () => new Redis(url, { maxRetriesPerRequest: 3, enableAutoPipelining: true });
}

/**
 * @param {object} o
 * @param {() => import('ioredis').Redis} o.makeClient
 * @param {string} [o.nodeId]
 * @param {(ocppId: string) => any} o.localConn   returns this node's live connection or undefined
 * @param {(ocppId: string) => void} [o.onReplaced] close a local connection another node took over
 * @param {(id: string) => void} [o.onRemoteSession] a session changed on another node
 */
export function createCluster({ makeClient, nodeId = process.env.RENDER_INSTANCE_ID || `${os.hostname()}-${process.pid}-${randomId(3)}`, localConn, onReplaced, onRemoteSession }) {
  const cmd = makeClient();
  const pub = makeClient();
  const sub = makeClient();
  const remote = new Map(); // ocppId -> { nodeId, at }
  const waiting = new Map(); // requestId -> { resolve, reject, timer }
  const timers = [];
  let leader = false;

  const ch = { presence: 'cx:presence', session: 'cx:session', cmd: (n) => `cx:cmd:${n}`, reply: (n) => `cx:reply:${n}` };
  const send = (channel, msg) => pub.publish(channel, JSON.stringify(msg));

  async function handle(channel, raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (channel === ch.presence) {
      if (m.nodeId === nodeId) return;
      for (const id of m.online || []) {
        remote.set(id, { nodeId: m.nodeId, at: Date.now() });
        // The charger reconnected to another node: drop our stale socket.
        if (m.fresh && localConn(id)) onReplaced?.(id);
      }
      for (const id of m.offline || []) if (remote.get(id)?.nodeId === m.nodeId) remote.delete(id);
    } else if (channel === ch.session) {
      if (m.nodeId !== nodeId) onRemoteSession?.(m.id);
    } else if (channel === ch.cmd(nodeId)) {
      const conn = localConn(m.ocppId);
      let reply;
      if (!conn || conn.closed) reply = { error: { code: 'Offline', message: 'Charger not connected on this node' } };
      else {
        try {
          reply = { result: await conn.call(m.action, m.payload, m.timeoutMs) };
        } catch (e) {
          reply = { error: { code: e.code || 'Error', message: e.message } };
        }
      }
      send(ch.reply(m.from), { requestId: m.requestId, ...reply });
    } else if (channel === ch.reply(nodeId)) {
      const w = waiting.get(m.requestId);
      if (!w) return;
      clearTimeout(w.timer);
      waiting.delete(m.requestId);
      if (m.error) w.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      else w.resolve(m.result);
    }
  }

  const api = {
    enabled: true,
    nodeId,
    async start({ heldIds = () => [] } = {}) {
      sub.on('message', (c, raw) => handle(c, raw).catch((e) => logger.error('cluster message', e)));
      await sub.subscribe(ch.presence, ch.session, ch.cmd(nodeId), ch.reply(nodeId));
      const beat = async () => {
        const now = Date.now();
        for (const [id, r] of remote) if (now - r.at > PRESENCE_TTL_MS) remote.delete(id);
        const held = heldIds();
        if (held.length) await send(ch.presence, { nodeId, online: held });
        for (const id of held) await cmd.set(`cx:conn:${id}`, nodeId, 'PX', PRESENCE_TTL_MS);
        // Leader lock: acquire or renew
        const ok = await cmd.set('cx:leader', nodeId, 'PX', LOCK_MS, 'NX');
        if (ok) leader = true;
        else leader = (await cmd.get('cx:leader')) === nodeId;
        if (leader) await cmd.pexpire('cx:leader', LOCK_MS);
      };
      await beat();
      timers.push(setInterval(() => beat().catch((e) => logger.warn(`cluster beat: ${e.message}`)), BEAT_MS));
      logger.info(`cluster mode on as ${nodeId}${leader ? ' (leader)' : ''}`);
    },
    async stop() {
      while (timers.length) clearInterval(timers.pop());
      if (leader) await cmd.del('cx:leader').catch(() => {});
      for (const w of waiting.values()) clearTimeout(w.timer);
      await Promise.allSettled([cmd.quit(), pub.quit(), sub.quit()]);
    },
    isLeader: () => leader,
    /** Is the charger connected to some other node right now? */
    remoteOwner(ocppId) {
      const r = remote.get(ocppId);
      return r && Date.now() - r.at < PRESENCE_TTL_MS ? r.nodeId : null;
    },
    async announce(ocppId, online) {
      if (online) {
        remote.delete(ocppId);
        await cmd.set(`cx:conn:${ocppId}`, nodeId, 'PX', PRESENCE_TTL_MS);
        await send(ch.presence, { nodeId, online: [ocppId], fresh: true });
      } else {
        // Only clear the key if we still own it (the charger may already be on another node)
        if ((await cmd.get(`cx:conn:${ocppId}`)) === nodeId) await cmd.del(`cx:conn:${ocppId}`);
        await send(ch.presence, { nodeId, offline: [ocppId] });
      }
    },
    /** Relay a command to the node holding the charger's socket. */
    async call(ocppId, action, payload, timeoutMs = 30000) {
      let owner = api.remoteOwner(ocppId);
      if (!owner) owner = await cmd.get(`cx:conn:${ocppId}`);
      if (!owner || owner === nodeId) throw Object.assign(new Error('Charger is not connected'), { code: 'Offline' });
      const requestId = randomId(8);
      const p = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(requestId);
          reject(Object.assign(new Error(`${action} timed out via ${owner}`), { code: 'Timeout' }));
        }, timeoutMs + 2000);
        waiting.set(requestId, { resolve, reject, timer });
      });
      await send(ch.cmd(owner), { requestId, from: nodeId, ocppId, action, payload, timeoutMs });
      return p;
    },
    publishSession(id) {
      send(ch.session, { nodeId, id: String(id) }).catch(() => {});
    },
  };
  return api;
}

// Single-node default: everything is local.
export const noCluster = {
  enabled: false,
  nodeId: 'local',
  isLeader: () => true,
  remoteOwner: () => null,
  announce: async () => {},
  call: async () => {
    throw Object.assign(new Error('Charger is not connected'), { code: 'Offline' });
  },
  publishSession: () => {},
  start: async () => {},
  stop: async () => {},
};

let current = noCluster;
export const cluster = () => current;
export function setCluster(c) {
  current = c || noCluster;
}
