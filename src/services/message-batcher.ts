/**
 * Message batching service
 *
 * Implements 2-second debounce mechanism for incoming messages.
 * When a message arrives, we wait 2 seconds before processing.
 * If another message arrives during that window, we batch them together
 * and reset the timer.
 */
import { Queue, Worker, Job } from 'bullmq';
import redis from '../lib/redis';
import { handleInboundMessage } from '../handlers';
import { config } from '../config';
import logger from '../lib/logger';

const BATCH_DELAY_MS = 2000; // 2 seconds
const BATCH_TTL_SECONDS = 600; // 10 minutes safety TTL

// Create BullMQ connection using ioredis options from URL
// We need to pass proper ioredis options, not just a connection object
const redisUrl = new URL(config.redis.url);
const isTLS = redisUrl.protocol === 'rediss:';

// Build connection options that ioredis understands
const redisConnection: Record<string, unknown> = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port || '6379', 10),
  maxRetriesPerRequest: null, // Required for BullMQ
};

// Add auth if present
if (redisUrl.password) {
  redisConnection.password = redisUrl.password;
}
if (redisUrl.username && redisUrl.username !== 'default') {
  redisConnection.username = redisUrl.username;
}

// Enable TLS for rediss:// URLs (Railway uses TLS)
if (isTLS) {
  redisConnection.tls = {
    rejectUnauthorized: false, // Railway's Redis uses self-signed certs
  };
}

logger.info({
  event: 'redis_connection_config',
  host: redisUrl.hostname,
  port: redisUrl.port,
  hasTLS: isTLS,
  hasPassword: !!redisUrl.password,
}, 'BullMQ Redis connection configured');

interface BatchJobData {
  phone: string;
  batchKey: string;
}

interface BatchedMessage {
  content: string;
  mediaUrl: string | null;
  receivedAt: string;
}

// Create queue for message batching
const batchQueue = new Queue<BatchJobData>('message-batching', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

/**
 * Add a message to the batch for a given phone number.
 * If there's already a pending batch, append to it and reset the timer.
 */
export async function addMessageToBatch(
  phone: string,
  content: string,
  mediaUrl: string | null
): Promise<void> {
  const batchKey = `batch:pending:${phone}`;
  const jobId = `batch-${phone}`;

  const message: BatchedMessage = {
    content,
    mediaUrl,
    receivedAt: new Date().toISOString(),
  };

  // 1. Append message to Redis list
  await redis.rpush(`${batchKey}:messages`, JSON.stringify(message));
  await redis.expire(`${batchKey}:messages`, BATCH_TTL_SECONDS);

  logger.info(
    { event: 'batch_message_added', phone: phone.slice(-4), hasMedia: !!mediaUrl, batchKey },
    `Added message to batch for ***${phone.slice(-4)}`
  );

  // 2. Remove any existing job with this ID (delayed, waiting, OR completed)
  // BullMQ won't add a new job if one with the same ID exists, even if completed
  const existingJob = await batchQueue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    logger.info({ event: 'batch_existing_job', jobId, state }, `Existing job state: ${state}`);
    // Remove the job regardless of state to allow adding a new one
    await existingJob.remove();
    logger.info(
      { event: 'batch_job_removed', phone: phone.slice(-4), previousState: state },
      `Removed existing batch job (was ${state}) for ***${phone.slice(-4)}`
    );
  }

  // 3. Schedule new job with fresh 2-second delay
  const newJob = await batchQueue.add('process-batch', { phone, batchKey }, {
    delay: BATCH_DELAY_MS,
    jobId,
  });

  logger.info(
    { event: 'batch_job_scheduled', phone: phone.slice(-4), delayMs: BATCH_DELAY_MS, jobId: newJob.id },
    `Scheduled batch processing in ${BATCH_DELAY_MS}ms for ***${phone.slice(-4)}`
  );
}

/**
 * Process a batch of messages after the delay expires
 */
async function processBatch(job: Job<BatchJobData>): Promise<void> {
  logger.info({ event: 'batch_job_started', jobId: job.id, jobName: job.name }, `Processing job ${job.id}`);

  const { phone, batchKey } = job.data;
  const messagesKey = `${batchKey}:messages`;

  // Atomically fetch and clear the batch
  const rawMessages = await redis.lrange(messagesKey, 0, -1);
  await redis.del(messagesKey);

  if (rawMessages.length === 0) {
    logger.warn(
      { event: 'batch_empty', phone: phone.slice(-4), batchKey },
      `Batch was empty for ***${phone.slice(-4)} (may have been processed already)`
    );
    return;
  }

  const messages: BatchedMessage[] = rawMessages.map((m) => JSON.parse(m));

  logger.info(
    { event: 'batch_processing', phone: phone.slice(-4), messageCount: messages.length },
    `Processing batch of ${messages.length} message(s) for ***${phone.slice(-4)}`
  );

  // Combine text content (join with newlines)
  const combinedContent = messages
    .map((m) => m.content)
    .filter((c) => c && c.trim())
    .join('\n');

  // Collect all media URLs (use first one for now, could extend later)
  const allMediaUrls = messages
    .map((m) => m.mediaUrl)
    .filter((url): url is string => url !== null);

  // Use first media URL (most common case: user sends one photo)
  // Future enhancement: could process multiple photos
  const mediaUrl = allMediaUrls.length > 0 ? allMediaUrls[0] : undefined;

  // Log combined message info
  const preview = combinedContent.substring(0, 50) || '[media only]';
  logger.info(
    {
      event: 'batch_combined',
      phone: phone.slice(-4),
      originalCount: messages.length,
      combinedLength: combinedContent.length,
      mediaCount: allMediaUrls.length,
      preview,
    },
    `Combined ${messages.length} messages: "${preview}"`
  );

  // Process as single message
  await handleInboundMessage(phone, combinedContent, mediaUrl);
}

// Create worker to process batched messages
let batchWorker: Worker<BatchJobData> | null = null;

/**
 * Start the batch worker
 */
export async function startBatchWorker(): Promise<void> {
  if (batchWorker) {
    logger.warn({ event: 'batch_worker_exists' }, 'Batch worker already running');
    return;
  }

  // Test the queue connection first
  try {
    const testJob = await batchQueue.add('test-connection', {
      phone: '+10000000000',
      batchKey: 'test:startup',
    }, { delay: 100 });
    logger.info({ event: 'batch_queue_test', jobId: testJob.id }, 'Test job added to queue');

    // Remove the test job
    await testJob.remove();
    logger.info({ event: 'batch_queue_test_success' }, 'Queue connection verified');
  } catch (err) {
    logger.error({ event: 'batch_queue_test_failed', error: (err as Error).message }, 'Failed to test queue connection');
    throw err;
  }

  batchWorker = new Worker<BatchJobData>('message-batching', processBatch, {
    connection: redisConnection,
    concurrency: 5, // Process up to 5 batches concurrently
  });

  // Log when worker is ready
  batchWorker.on('ready', () => {
    logger.info({ event: 'batch_worker_ready' }, 'Batch worker connected and ready');
  });

  batchWorker.on('completed', (job) => {
    logger.info(
      { event: 'batch_job_completed', jobId: job.id, phone: job.data.phone.slice(-4) },
      `Batch job completed for ***${job.data.phone.slice(-4)}`
    );
  });

  batchWorker.on('failed', (job, err) => {
    logger.error(
      { event: 'batch_job_failed', jobId: job?.id, error: err.message },
      `Batch job failed: ${err.message}`
    );
  });

  batchWorker.on('error', (err) => {
    logger.error(
      { event: 'batch_worker_error', error: err.message },
      `Batch worker error: ${err.message}`
    );
  });

  logger.info({ event: 'batch_worker_started' }, 'Message batch worker started');
}

/**
 * Stop the batch worker (for graceful shutdown)
 */
export async function stopBatchWorker(): Promise<void> {
  if (batchWorker) {
    await batchWorker.close();
    batchWorker = null;
    logger.info({ event: 'batch_worker_stopped' }, 'Message batch worker stopped');
  }
}

export default {
  addMessageToBatch,
  startBatchWorker,
  stopBatchWorker,
};
