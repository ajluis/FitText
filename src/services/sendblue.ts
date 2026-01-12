import { config, SENDBLUE_RATE_LIMIT_MS } from '../config';
import { fetchWithTimeout, TimeoutError } from '../lib/fetch-with-timeout';
import { withRetry, isRetryableStatus } from '../lib/retry';

const SENDBLUE_API_URL = 'https://api.sendblue.co/api/send-message';
const SENDBLUE_TIMEOUT_MS = 15000; // 15 second timeout for SMS API

// Track last message time per user for rate limiting
const lastMessageTime = new Map<string, number>();

// Sendblue expressive message effects (iMessage only)
export type SendStyle =
  | 'default'
  | 'invisible'
  | 'celebration'
  | 'shooting_star'
  | 'fireworks'
  | 'lasers'
  | 'love'
  | 'confetti'
  | 'balloons'
  | 'spotlight'
  | 'echo'
  | 'gentle'
  | 'loud'
  | 'slam';

interface SendMessageOptions {
  number: string;
  content: string;
  sendStyle?: SendStyle;
  mediaUrl?: string;
}

interface SendMessageResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send an SMS message via Sendblue
 */
export async function sendMessage(options: SendMessageOptions): Promise<SendMessageResponse> {
  const { number, content, sendStyle = 'default', mediaUrl } = options;

  // Rate limiting - ensure we don't send more than 1 msg/sec per user
  const lastTime = lastMessageTime.get(number) || 0;
  const now = Date.now();
  const timeSinceLastMessage = now - lastTime;

  if (timeSinceLastMessage < SENDBLUE_RATE_LIMIT_MS) {
    const waitTime = SENDBLUE_RATE_LIMIT_MS - timeSinceLastMessage;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  const body: Record<string, string> = {
    number,
    content,
    send_style: sendStyle,
    from_number: config.sendblue.phoneNumber,
  };

  if (mediaUrl) {
    body.media_url = mediaUrl;
  }

  // Use retry with exponential backoff
  const result = await withRetry(
    async () => {
      const response = await fetchWithTimeout(SENDBLUE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'sb-api-key-id': config.sendblue.apiKey,
          'sb-api-secret-key': config.sendblue.apiSecret,
        },
        body: JSON.stringify(body),
        timeoutMs: SENDBLUE_TIMEOUT_MS,
      });

      lastMessageTime.set(number, Date.now());

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`Sendblue API error: ${response.status} - ${errorText}`);
        // Add status to error for retry logic
        (error as Error & { status?: number }).status = response.status;

        // Only throw (to trigger retry) for retryable status codes
        if (isRetryableStatus(response.status)) {
          throw error;
        }

        // Non-retryable error (4xx client errors)
        console.error('Sendblue API error (non-retryable):', response.status, errorText);
        return { success: false, error: `API error: ${response.status}` };
      }

      const data = await response.json() as { message_id?: string };
      return { success: true, messageId: data.message_id };
    },
    {
      maxAttempts: 3,
      initialDelayMs: 1000,
      retryOn: (error) => {
        // Retry on timeout errors
        if (error instanceof TimeoutError) return true;
        // Retry on server errors (5xx) or rate limits (429)
        const status = (error as Error & { status?: number }).status;
        return status ? isRetryableStatus(status) : true;
      },
    }
  );

  if (!result.success) {
    const errorMsg = result.error?.message || 'Unknown error';
    console.error(`Sendblue send failed after ${result.attempts} attempts:`, errorMsg);
    return {
      success: false,
      error: errorMsg,
    };
  }

  return result.data ?? { success: false, error: 'No response data' };
}

/**
 * Send a message and handle errors gracefully
 */
export async function sendSMS(phone: string, message: string): Promise<boolean> {
  const result = await sendMessage({ number: phone, content: message });

  if (!result.success) {
    console.error(`Failed to send SMS to ${phone}:`, result.error);
  }

  return result.success;
}

/**
 * Send a message with an expressive effect (iMessage only, degrades gracefully on SMS)
 * Use for celebrations and milestones!
 */
export async function sendSMSWithEffect(
  phone: string,
  message: string,
  effect: SendStyle
): Promise<boolean> {
  const result = await sendMessage({
    number: phone,
    content: message,
    sendStyle: effect,
  });

  if (!result.success) {
    console.error(`Failed to send SMS with effect to ${phone}:`, result.error);
  }

  return result.success;
}

/**
 * Send multiple messages in sequence (for longer content that needs to be split)
 */
export async function sendMultipleMessages(phone: string, messages: string[]): Promise<boolean> {
  for (const message of messages) {
    const success = await sendSMS(phone, message);
    if (!success) return false;
  }
  return true;
}

/**
 * Split a long message into SMS-friendly chunks
 * SMS limit is technically 160 chars, but modern phones combine them
 * We'll aim for ~300 chars per message for readability
 */
export function splitMessage(content: string, maxLength = 300): string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const messages: string[] = [];
  const lines = content.split('\n');
  let currentMessage = '';

  for (const line of lines) {
    if (currentMessage.length + line.length + 1 > maxLength) {
      if (currentMessage) {
        messages.push(currentMessage.trim());
      }
      currentMessage = line;
    } else {
      currentMessage += (currentMessage ? '\n' : '') + line;
    }
  }

  if (currentMessage) {
    messages.push(currentMessage.trim());
  }

  return messages;
}

// Webhook payload types
export interface SendblueInboundWebhook {
  accountEmail: string;
  content: string;
  media_url?: string;
  is_outbound: boolean;
  status: string;
  error_code?: string;
  error_message?: string;
  message_handle: string;
  date_sent: string;
  date_updated: string;
  from_number: string;
  number: string;
  to_number: string;
  was_downgraded: boolean;
  plan: string;
}

/**
 * Parse and validate inbound webhook from Sendblue
 */
export function parseInboundWebhook(body: unknown): SendblueInboundWebhook | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const webhook = body as Record<string, unknown>;

  // Required fields
  if (typeof webhook.from_number !== 'string' || typeof webhook.content !== 'string') {
    return null;
  }

  return {
    accountEmail: String(webhook.accountEmail || ''),
    content: String(webhook.content || ''),
    media_url: webhook.media_url ? String(webhook.media_url) : undefined,
    is_outbound: Boolean(webhook.is_outbound),
    status: String(webhook.status || ''),
    error_code: webhook.error_code ? String(webhook.error_code) : undefined,
    error_message: webhook.error_message ? String(webhook.error_message) : undefined,
    message_handle: String(webhook.message_handle || ''),
    date_sent: String(webhook.date_sent || ''),
    date_updated: String(webhook.date_updated || ''),
    from_number: String(webhook.from_number),
    number: String(webhook.number || webhook.from_number),
    to_number: String(webhook.to_number || ''),
    was_downgraded: Boolean(webhook.was_downgraded),
    plan: String(webhook.plan || ''),
  };
}
