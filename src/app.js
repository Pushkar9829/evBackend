import 'express-async-errors';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import mongoose from 'mongoose';
import { config } from './config.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { requireStaff } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import sessionRoutes from './routes/sessions.js';
import paymentRoutes from './routes/payments.js';
import meRoutes from './routes/me.js';
import cmsChargers from './routes/cms/chargers.js';
import cmsSessions from './routes/cms/sessions.js';
import cmsOrg from './routes/cms/org.js';
import adminRoutes from './routes/admin.js';
import ocpiRoutes from './roaming/ocpi/routes.js';
import ueiRoutes from './roaming/uei/routes.js';
import { registry } from './ocpp/registry.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render / load balancer in front
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin(origin, cb) {
        // Allow configured origins (Vercel URL), plus previews matching a wildcard like https://*.vercel.app
        if (!origin) return cb(null, true);
        const ok = config.corsOrigins.some((o) => o === '*' || o === origin || (o.includes('*') && new RegExp(`^${o.replace(/[.]/g, '\\.').replace('*', '[^.]+')}$`).test(origin)));
        return cb(ok ? null : new Error('CORS'), ok);
      },
      credentials: false,
      exposedHeaders: ['X-Total-Count', 'Content-Disposition'],
    }),
  );

  // Raw-body routes first (signatures are computed over the exact bytes)
  app.use('/api/payments', paymentRoutes);
  app.use('/uei', ueiRoutes);
  app.use('/ocpi', ocpiRoutes);

  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => res.json({ name: 'ChargeX API', docs: '/api/health', ocpp: '/ocpp/<chargerId>', ocpi: '/ocpi/versions', uei: '/uei' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1, chargersConnected: registry.size(), time: new Date().toISOString(), env: config.env }));

  app.use('/api/auth', authRoutes);
  app.use('/api/public', publicRoutes);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/me', meRoutes);
  app.use('/api/cms', requireStaff, cmsChargers, cmsSessions, cmsOrg);
  app.use('/api/admin', adminRoutes);

  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Not found.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.message === 'CORS') return res.status(403).json({ error: { code: 'CORS', message: 'Origin not allowed' } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Invalid JSON body' } });
    if (err.name === 'CastError') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    if (err.code === 11000) return res.status(409).json({ error: { code: 'DUPLICATE', message: 'This already exists.' } });
    const status = err.status || 500;
    if (status >= 500 && !(err instanceof AppError)) logger.error(`${req.method} ${req.originalUrl}`, err);
    const known = err instanceof AppError;
    return res.status(status).json({ error: { code: known ? err.code : 'SERVER_ERROR', message: known ? err.message : 'Something on our side failed. Please try again.', details: known ? err.details : undefined } });
  });

  return app;
}
