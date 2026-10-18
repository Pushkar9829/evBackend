import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { config } from './config.js';
import { connectDb } from './db.js';
import { createApp } from './app.js';
import { attachOcppGateway } from './ocpp/gateway.js';
import { startJobs, stopJobs } from './services/jobs.js';
import { attachRoamingListeners } from './roaming/ocpi/client.js';
import { attachUeiListeners } from './roaming/uei/routes.js';
import { setSimulatorPort, setSimulatorTls, stopAllSims } from './services/simulators.js';
import { Charger } from './models/index.js';
import { logger } from './lib/logger.js';
import { createCluster, redisFactory, setCluster, cluster } from './ocpp/cluster.js';
import { registry } from './ocpp/registry.js';
import { events } from './services/events.js';
import { rootCaPem, serverCredentials } from './services/pki.js';

/** Start API + OCPP gateway on one HTTP server (Render supports WebSockets on web services). */
export async function startServer({ port = config.port, jobs = true, tlsPort = process.env.OCPP_TLS_PORT } = {}) {
  await connectDb();
  // Nothing is connected right after a (re)start; chargers reconnect within seconds.
  await Charger.updateMany({ online: true }, { $set: { online: false } });
  const app = createApp();
  const server = http.createServer(app);
  attachOcppGateway(server);
  if (process.env.REDIS_URL) {
    const c = createCluster({
      makeClient: await redisFactory(process.env.REDIS_URL),
      localConn: (id) => registry.get(id),
      onReplaced: (id) => {
        const conn = registry.get(id);
        if (conn) {
          conn.replaced = true;
          conn.close(4000, 'reconnected to another node');
        }
      },
      onRemoteSession: (id) => events.emit('session', { _id: id, remote: true }),
    });
    setCluster(c);
    await c.start({ heldIds: () => registry.ids() });
  }
  attachRoamingListeners();
  attachUeiListeners();
  await new Promise((r) => server.listen(port, r));
  const actual = server.address().port;
  setSimulatorPort(actual);
  if (jobs) startJobs();
  logger.info(`ChargeX API on :${actual} (OCPP ws://localhost:${actual}/ocpp/<id>)`);

  // Optional mutual-TLS listener for OCPP Security Profile 3 (self-hosted / TCP pass-through load balancer).
  // Not usable behind Render's TLS-terminating proxy, which cannot forward client certificates.
  let tlsServer;
  let tlsActual;
  if (tlsPort !== undefined && tlsPort !== null && tlsPort !== '') {
    const read = (v) => (v && fs.existsSync(v) ? fs.readFileSync(v, 'utf8') : v);
    const creds = process.env.OCPP_TLS_CERT && process.env.OCPP_TLS_KEY ? { cert: read(process.env.OCPP_TLS_CERT), key: read(process.env.OCPP_TLS_KEY) } : await serverCredentials(['localhost', '127.0.0.1', ...(process.env.OCPP_TLS_HOSTS || '').split(',').filter(Boolean)]);
    tlsServer = https.createServer({ cert: creds.cert, key: creds.key, ca: [await rootCaPem()], requestCert: true, rejectUnauthorized: false }, app);
    attachOcppGateway(tlsServer);
    await new Promise((r) => tlsServer.listen(Number(tlsPort), r));
    tlsActual = tlsServer.address().port;
    setSimulatorTls(tlsActual, await rootCaPem());
    logger.info(`OCPP TLS (Security Profile 2/3) on wss://localhost:${tlsActual}/ocpp/<id>`);
  }
  return { server, port: actual, tlsServer, tlsPort: tlsActual };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  startServer().catch((e) => {
    logger.error('startup failed', e);
    process.exit(1);
  });
  const shutdown = async () => {
    stopJobs();
    await stopAllSims().catch(() => {});
    await cluster().stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
