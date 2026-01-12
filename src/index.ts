import express from 'express';
import http from 'http';
import path from 'path';
import { config } from './config';
import prisma from './lib/db';
import { getRedisConnection } from './lib/redis';
import webhookRoutes from './routes/webhooks';
import { startScheduler, stopScheduler } from './services/scheduler';
import logger, {
  generateRequestId,
  createRequestLogger,
  logStartup,
  logShutdown,
  logHealthCheck,
} from './lib/logger';

const app = express();
let server: http.Server | null = null;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging with request ID
app.use((req, res, next) => {
  const requestId = generateRequestId();
  const log = createRequestLogger(requestId);

  // Attach logger to request for use in handlers
  (req as express.Request & { log: typeof log }).log = log;

  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    log.info(
      {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: duration,
      },
      `${req.method} ${req.path} ${res.statusCode}`
    );
  });
  next();
});

// Static files (for VCF contact card, etc.)
app.use('/static', express.static(path.join(__dirname, '../public')));

// Routes
app.use('/webhook', webhookRoutes);

// Health check endpoint
app.get('/health', async (_req, res) => {
  const health = {
    status: 'healthy' as 'healthy' | 'degraded' | 'unhealthy',
    timestamp: new Date().toISOString(),
    checks: {
      database: false,
      redis: false,
    },
  };

  // Check database
  try {
    await prisma.$queryRaw`SELECT 1`;
    health.checks.database = true;
  } catch (error) {
    logger.error({ error }, 'Database health check failed');
  }

  // Check Redis
  try {
    const redis = getRedisConnection();
    if (redis) {
      await redis.ping();
      health.checks.redis = true;
    }
  } catch (error) {
    logger.error({ error }, 'Redis health check failed');
  }

  // Determine overall status
  const allHealthy = health.checks.database && health.checks.redis;
  const anyHealthy = health.checks.database || health.checks.redis;

  if (allHealthy) {
    health.status = 'healthy';
  } else if (anyHealthy) {
    health.status = 'degraded';
  } else {
    health.status = 'unhealthy';
  }

  logHealthCheck({
    status: health.status,
    database: health.checks.database,
    redis: health.checks.redis,
  });

  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  res.status(statusCode).json(health);
});

// Root endpoint (basic info)
app.get('/', (_req, res) => {
  res.json({
    name: 'FitText',
    status: 'running',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      webhook: '/webhook/sendblue/inbound',
    },
  });
});

// Error handling
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const log = (req as express.Request & { log?: typeof logger }).log || logger;
  log.error(
    {
      error: err.message,
      stack: err.stack,
    },
    'Unhandled error'
  );
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
async function shutdown(signal: string) {
  logShutdown(signal);

  // Stop accepting new connections and wait for in-flight requests
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => {
        logger.info('HTTP server closed');
        resolve();
      });
    });
  }

  // Stop scheduler
  await stopScheduler();

  // Disconnect from database
  await prisma.$disconnect();
  logger.info('Database disconnected');

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
async function main() {
  try {
    // Test database connection
    await prisma.$connect();
    logger.info('Database connected');

    // Start the scheduler
    await startScheduler();
    logger.info('Scheduler started');

    // Start the HTTP server
    server = app.listen(config.server.port, () => {
      logStartup({
        port: config.server.port,
        nodeEnv: process.env.NODE_ENV || 'development',
      });
      logger.info(`Webhook URL: ${config.server.webhookBaseUrl}/webhook/sendblue/inbound`);
    });
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

main();
