// Connection gateway: wss://<host>/ocpp/<chargerId>, OCPP-J subprotocols ocpp2.0.1 / ocpp1.6.
// Security Profile 2: HTTP Basic auth (charger id + password) over TLS (TLS terminates at Render / the LB).
import { WebSocketServer } from 'ws';
import bcrypt from 'bcryptjs';
import { Charger } from '../models/index.js';
import { logger } from '../lib/logger.js';
import { raiseAlert } from '../services/alerts.js';
import { securityEvent } from '../services/audit.js';
import { ChargerConnection } from './connection.js';
import { registry } from './registry.js';
import { cluster } from './cluster.js';
import { handleCall, markOffline, markOnline } from './brain.js';
import { onChargerOffline, onChargerOnline } from '../services/sessionEngine.js';
import { peerIdentity } from '../services/pki.js';

const SUPPORTED = ['ocpp2.1', 'ocpp2.0.1', 'ocpp1.6'];

function reject(socket, code, text) {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function parseBasic(header) {
  if (!header?.startsWith('Basic ')) return null;
  const raw = Buffer.from(header.slice(6), 'base64').toString();
  const i = raw.indexOf(':');
  return i < 0 ? null : { user: raw.slice(0, i), pass: raw.slice(i + 1) };
}

export function attachOcppGateway(server) {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols, req) => {
      const want = req.chargerProtocol;
      if (protocols.has(want)) return want;
      return SUPPORTED.find((p) => protocols.has(p)) || false;
    },
  });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/ocpp\/([^/]+)\/?$/);
    if (!m) return; // not ours (e.g. other upgrade handlers)
    const ocppId = decodeURIComponent(m[1]);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    try {
      const charger = await Charger.findOne({ ocppId, deletedAt: null });
      if (!charger) {
        await securityEvent('ocpp_unknown_charger', { ocppId }, ip);
        return reject(socket, 404, 'Not Found');
      }
      // Security Profile 3: TLS client certificate issued by our CA with CN = charger id.
      const peer = req.socket.encrypted ? peerIdentity(req.socket) : null;
      const certOk = !!(peer?.authorized && peer.cn === ocppId && (!charger.certificate?.fingerprint || charger.certificate.fingerprint === peer.fingerprint));
      if (peer && peer.cn && !certOk) await securityEvent('ocpp_bad_client_cert', { ocppId, cn: peer.cn, authorized: peer.authorized, tenant: String(charger.tenant) }, ip);
      if (charger.securityProfile === 3 && !certOk) {
        await securityEvent('ocpp_profile3_required', { ocppId, tenant: String(charger.tenant) }, ip);
        return reject(socket, 401, 'Unauthorized');
      }
      const cred = certOk ? null : parseBasic(req.headers.authorization);
      const ok = certOk || (cred && cred.user === ocppId && charger.passwordHash && (await bcrypt.compare(cred.pass, charger.passwordHash)));
      if (!ok) {
        // Wrong password: rejected; repeated failures alert ops (SEC-02 / SEC-03)
        const fails = (charger.authFailures || 0) + 1;
        await Charger.updateOne({ _id: charger._id }, { $set: { authFailures: fails, lastAuthFailureAt: new Date() } });
        await securityEvent('ocpp_auth_failed', { ocppId, tenant: String(charger.tenant), attempt: fails }, ip);
        if (fails >= 3) await raiseAlert({ tenant: charger.tenant, type: 'security', severity: 'critical', charger: charger._id, message: `Repeated failed logins for charger ${ocppId} (${fails})`, dedupeKey: `authfail:${ocppId}` });
        return reject(socket, 401, 'Unauthorized');
      }
      const offered = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
      if (!offered.some((p) => SUPPORTED.includes(p))) return reject(socket, 400, 'Unsupported Subprotocol');
      req.chargerProtocol = charger.protocol;
      req.authMethod = certOk ? 'certificate' : 'password';
      wss.handleUpgrade(req, socket, head, (ws) => {
        const protocol = ws.protocol || charger.protocol;
        const existing = registry.get(ocppId);
        // Attach the connection synchronously so the charger's first message (BootNotification) is never missed.
        const conn = new ChargerConnection(ws, {
          charger: { _id: charger._id, tenant: charger.tenant, ocppId },
          protocol,
          onCall: handleCall,
          onClose: async (c) => {
            clearInterval(c.pingTimer);
            if (registry.get(ocppId) !== c) return; // replaced by a newer connection
            registry.delete(ocppId, c);
            logger.info(`charger ${ocppId} disconnected`);
            await cluster().announce(ocppId, false).catch(() => {});
            if (c.replaced) return; // moved to another node; that node keeps it online
            await markOffline(charger);
            await onChargerOffline(charger);
          },
        });
        registry.set(ocppId, conn);
        if (existing && !existing.closed) {
          // Same id connected twice with valid credentials: newest wins (reboots), ops alerted.
          existing.replaced = true;
          existing.close(4000, 'replaced');
        }
        // Ping keeps NAT/LB paths open; gateway detects dead sockets.
        conn.pingTimer = setInterval(() => {
          if (ws.readyState === 1) ws.ping();
          else clearInterval(conn.pingTimer);
        }, 30000);
        logger.info(`charger ${ocppId} connected (${protocol}, ${req.authMethod})`);
        (async () => {
          if (existing && !existing.closed) await raiseAlert({ tenant: charger.tenant, type: 'security', severity: 'warning', charger: charger._id, message: `Duplicate connection for ${ocppId}; previous connection closed`, dedupeKey: `dup:${ocppId}` });
          const set = { authFailures: 0 };
          if (protocol !== charger.protocol) set.protocol = protocol;
          await Charger.updateOne({ _id: charger._id }, { $set: set });
          await cluster().announce(ocppId, true).catch((e) => logger.warn(`cluster announce: ${e.message}`));
          await markOnline(charger);
          await onChargerOnline(charger);
        })().catch((e) => logger.error('ocpp connect bookkeeping', e));
      });
    } catch (e) {
      logger.error('ocpp upgrade failed', e);
      reject(socket, 500, 'Internal Server Error');
    }
    return undefined;
  });

  return wss;
}
