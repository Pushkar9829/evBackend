import http from 'node:http';
import { config } from './config.js';
import { connectDb } from './db.js';
import { createApp } from './app.js';
import { attachOcppGateway } from './ocpp/gateway.js';
import { startJobs, stopJobs } from './services/jobs.js';
import { attachRoamingListeners } from './roaming/ocpi/client.js';
import { attachUeiListeners } from './roaming/uei/routes.js';
import { setSimulatorPort, stopAllSims } from './services/simulators.js';
import { Charger } from './models/index.js';
import { logger } from './lib/logger.js';

/** Start API + OCPP gateway on one HTTP server (Render supports WebSockets on web services). */
export async function startServer({ port = config.port, jobs = true } = {}) {
  await connectDb();
  // Nothing is connected right after a (re)start; chargers reconnect within seconds.
  await Charger.updateMany({ online: true }, { $set: { online: false } });
  const app = createApp();
  const server = http.createServer(app);
  attachOcppGateway(server);
  attachRoamingListeners();
  attachUeiListeners();
  await new Promise((r) => server.listen(port, r));
  const actual = server.address().port;
  setSimulatorPort(actual);
  if (jobs) startJobs();
  logger.info(`ChargeX API on :${actual} (OCPP ws://localhost:${actual}/ocpp/<id>)`);
  return { server, port: actual };
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
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
