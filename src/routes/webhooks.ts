import { Router, Request, Response } from 'express';
import { parseInboundWebhook } from '../services/sendblue';
import { handleInboundMessage } from '../handlers';
import logger from '../lib/logger';

const router = Router();

/**
 * Sendblue inbound webhook
 * POST /webhook/sendblue/inbound
 */
router.post('/sendblue/inbound', async (req: Request, res: Response) => {
  logger.info({ event: 'webhook_received', path: '/sendblue/inbound' }, 'Webhook hit');

  try {
    // Parse webhook payload
    const webhook = parseInboundWebhook(req.body);

    if (!webhook) {
      logger.warn({ event: 'invalid_webhook', body: req.body }, 'Invalid webhook payload');
      res.status(400).json({ error: 'Invalid webhook payload' });
      return;
    }

    // Skip outbound messages (we only care about inbound)
    if (webhook.is_outbound) {
      logger.debug({ event: 'webhook_skipped', reason: 'outbound' }, 'Skipping outbound message');
      res.status(200).json({ status: 'skipped', reason: 'outbound message' });
      return;
    }

    // Skip empty messages
    if (!webhook.content && !webhook.media_url) {
      logger.debug({ event: 'webhook_skipped', reason: 'empty' }, 'Skipping empty message');
      res.status(200).json({ status: 'skipped', reason: 'empty message' });
      return;
    }

    const phone = webhook.from_number;
    const preview = webhook.content?.substring(0, 50) || '[media]';
    const hasMedia = !!webhook.media_url;

    logger.info(
      {
        event: 'inbound_message',
        phone: phone.slice(-4), // Last 4 digits only
        hasMedia,
        mediaUrl: hasMedia ? webhook.media_url?.substring(0, 100) : undefined,
        contentLength: webhook.content?.length || 0,
        preview,
      },
      `Inbound: ***${phone.slice(-4)} "${preview}"${hasMedia ? ' [has media]' : ''}`
    );

    // Process the message asynchronously
    // We respond immediately to avoid webhook timeout
    res.status(200).json({ status: 'received' });

    // Handle the message
    await handleInboundMessage(
      webhook.from_number,
      webhook.content || '',
      webhook.media_url
    );

    logger.info({ event: 'message_processed', phone: phone.slice(-4) }, 'Message processed');
  } catch (error) {
    logger.error({ event: 'webhook_error', error }, 'Webhook processing error');
    // Still return 200 to avoid Sendblue retries
    res.status(200).json({ status: 'error', message: 'Internal processing error' });
  }
});

/**
 * Health check for the webhook
 * GET /webhook/health
 */
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Sendblue status webhook (for delivery receipts)
 * POST /webhook/sendblue/status
 */
router.post('/sendblue/status', async (req: Request, res: Response) => {
  try {
    const { message_handle, status, error_message } = req.body;

    if (status === 'FAILED' && error_message) {
      logger.error(
        { event: 'delivery_failed', messageHandle: message_handle, error: error_message },
        `Message delivery failed: ${error_message}`
      );
    } else {
      logger.debug(
        { event: 'delivery_status', messageHandle: message_handle, status },
        `Delivery status: ${status}`
      );
    }

    res.status(200).json({ status: 'received' });
  } catch (error) {
    logger.error({ event: 'status_webhook_error', error }, 'Status webhook error');
    res.status(200).json({ status: 'error' });
  }
});

export default router;
