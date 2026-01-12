/**
 * Structured logging with pino
 * Provides consistent, JSON-formatted logs for production debugging
 */

import pino from 'pino';
import { randomUUID } from 'crypto';

// Log level based on environment
const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// Base logger configuration
const logger = pino({
  level,
  base: {
    service: 'fittext',
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty print in development
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

/**
 * Generate a unique request ID for tracing
 */
export function generateRequestId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Create a child logger with request context
 */
export function createRequestLogger(requestId: string, phone?: string) {
  return logger.child({
    requestId,
    phone: phone ? maskPhone(phone) : undefined,
  });
}

/**
 * Mask phone number for logs (show last 4 digits)
 */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return '***' + phone.slice(-4);
}

/**
 * Log levels and their intended usage:
 * - fatal: Application crash, unrecoverable errors
 * - error: Runtime errors, failed external calls
 * - warn: Unexpected but recoverable situations
 * - info: High-level flow (user actions, API calls)
 * - debug: Detailed debugging information
 * - trace: Very detailed tracing
 */

// Re-export logger instance for direct use
export default logger;

// Export typed child logger type
export type Logger = typeof logger;

/**
 * Log an incoming message
 */
export function logIncomingMessage(
  log: Logger,
  data: { phone: string; hasMedia: boolean; contentLength: number }
) {
  log.info(
    {
      event: 'message_received',
      hasMedia: data.hasMedia,
      contentLength: data.contentLength,
    },
    'Received incoming message'
  );
}

/**
 * Log an outgoing SMS
 */
export function logOutgoingSms(
  log: Logger,
  data: { phone: string; contentLength: number; success: boolean; error?: string }
) {
  if (data.success) {
    log.info(
      {
        event: 'sms_sent',
        contentLength: data.contentLength,
      },
      'SMS sent successfully'
    );
  } else {
    log.error(
      {
        event: 'sms_failed',
        error: data.error,
      },
      'Failed to send SMS'
    );
  }
}

/**
 * Log intent classification result
 */
export function logIntentClassification(
  log: Logger,
  data: { intent: string; confidence: number }
) {
  log.info(
    {
      event: 'intent_classified',
      intent: data.intent,
      confidence: data.confidence,
    },
    `Classified intent: ${data.intent}`
  );
}

/**
 * Log food parsing result
 */
export function logFoodParsing(
  log: Logger,
  data: { itemCount: number; totalCalories: number; totalProtein: number; confidence: string }
) {
  log.info(
    {
      event: 'food_parsed',
      itemCount: data.itemCount,
      totalCalories: data.totalCalories,
      totalProtein: data.totalProtein,
      confidence: data.confidence,
    },
    `Parsed ${data.itemCount} food items`
  );
}

/**
 * Log workout parsing result
 */
export function logWorkoutParsing(
  log: Logger,
  data: { workoutType: string; exerciseCount: number; durationMinutes?: number }
) {
  log.info(
    {
      event: 'workout_parsed',
      workoutType: data.workoutType,
      exerciseCount: data.exerciseCount,
      durationMinutes: data.durationMinutes,
    },
    `Parsed ${data.workoutType} workout with ${data.exerciseCount} exercises`
  );
}

/**
 * Log Claude API call
 */
export function logClaudeCall(
  log: Logger,
  data: {
    purpose: string;
    inputTokens?: number;
    outputTokens?: number;
    durationMs: number;
    success: boolean;
    error?: string;
  }
) {
  if (data.success) {
    log.info(
      {
        event: 'claude_call',
        purpose: data.purpose,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        durationMs: data.durationMs,
      },
      `Claude API call: ${data.purpose}`
    );
  } else {
    log.error(
      {
        event: 'claude_call_failed',
        purpose: data.purpose,
        error: data.error,
        durationMs: data.durationMs,
      },
      `Claude API call failed: ${data.purpose}`
    );
  }
}

/**
 * Log database operation
 */
export function logDbOperation(
  log: Logger,
  data: { operation: string; table: string; durationMs: number; success: boolean; error?: string }
) {
  if (data.success) {
    log.debug(
      {
        event: 'db_operation',
        operation: data.operation,
        table: data.table,
        durationMs: data.durationMs,
      },
      `DB ${data.operation} on ${data.table}`
    );
  } else {
    log.error(
      {
        event: 'db_operation_failed',
        operation: data.operation,
        table: data.table,
        error: data.error,
        durationMs: data.durationMs,
      },
      `DB ${data.operation} failed on ${data.table}`
    );
  }
}

/**
 * Log user onboarding step
 */
export function logOnboardingStep(
  log: Logger,
  data: { step: string; completed: boolean }
) {
  log.info(
    {
      event: 'onboarding_step',
      step: data.step,
      completed: data.completed,
    },
    data.completed ? `Completed onboarding step: ${data.step}` : `At onboarding step: ${data.step}`
  );
}

/**
 * Log application startup
 */
export function logStartup(data: { port: number; nodeEnv: string }) {
  logger.info(
    {
      event: 'startup',
      port: data.port,
      nodeEnv: data.nodeEnv,
    },
    `FitText server starting on port ${data.port}`
  );
}

/**
 * Log application shutdown
 */
export function logShutdown(reason: string) {
  logger.info(
    {
      event: 'shutdown',
      reason,
    },
    `FitText server shutting down: ${reason}`
  );
}

/**
 * Log health check result
 */
export function logHealthCheck(data: {
  status: 'healthy' | 'degraded' | 'unhealthy';
  database: boolean;
  redis: boolean;
}) {
  const level = data.status === 'healthy' ? 'info' : data.status === 'degraded' ? 'warn' : 'error';
  logger[level](
    {
      event: 'health_check',
      status: data.status,
      database: data.database,
      redis: data.redis,
    },
    `Health check: ${data.status}`
  );
}
