import express from 'express';
import { config } from './config';
import prisma from './lib/db';
import webhookRoutes from './routes/webhooks';
import { startScheduler, stopScheduler } from './services/scheduler';

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Routes
app.use('/webhook', webhookRoutes);

// Root health check
app.get('/', (_req, res) => {
  res.json({
    name: 'FitText',
    status: 'running',
    version: '1.0.0',
  });
});

// Error handling
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  await stopScheduler();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function main() {
  try {
    // Test database connection
    await prisma.$connect();
    console.log('Database connected');

    // Start the scheduler
    await startScheduler();

    // Start the HTTP server
    app.listen(config.server.port, () => {
      console.log(`FitText server running on port ${config.server.port}`);
      console.log(`Webhook URL: ${config.server.webhookBaseUrl}/webhook/sendblue/inbound`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
