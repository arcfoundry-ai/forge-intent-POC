/**
 * OpenClaw Callback Handler
 *
 * Handles callbacks from OpenClaw Gateway:
 * - response: Interviewee responded to questions
 * - partial_response: Partial responses received
 * - timeout: Session timed out
 * - escalation: Reminders exhausted
 * - error: Delivery or processing error
 *
 * Endpoint: POST /api/openclaw/callback
 */

import crypto from 'crypto';
import type { Request, Response } from 'express';
import {
  getSessionByOpenClawId,
  updateSessionState,
  incrementResponseCount,
  markLevelCompleted,
  completeSession,
} from '../storage/dynamodb-client.js';
import { s3Client } from '../storage/s3-client.js';
import type {
  OpenClawCallback,
  OpenClawCallbackType,
  InterviewSession,
  Interview,
} from '../storage/dynamodb-types.js';

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.FORGE_INTENT_WEBHOOK_SECRET || 'dev-secret';
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Simple in-memory replay protection (use Redis in production)
const seenRequestIds = new Map<string, number>();

// ─────────────────────────────────────────────────────────────
// Signature Verification
// ─────────────────────────────────────────────────────────────

function verifySignature(
  payload: string,
  signature: string | undefined
): boolean {
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  return `sha256=${expected}` === signature;
}

function checkReplayProtection(requestId: string | undefined): boolean {
  if (!requestId) return false;

  const now = Date.now();

  // Clean old entries
  for (const [id, timestamp] of seenRequestIds.entries()) {
    if (now - timestamp > REPLAY_WINDOW_MS) {
      seenRequestIds.delete(id);
    }
  }

  // Check if already seen
  if (seenRequestIds.has(requestId)) {
    return false;
  }

  seenRequestIds.set(requestId, now);
  return true;
}

// ─────────────────────────────────────────────────────────────
// Callback Type Handlers
// ─────────────────────────────────────────────────────────────

interface CallbackContext {
  callback: OpenClawCallback;
  session: InterviewSession;
  interview: Interview;
}

async function handleResponse(ctx: CallbackContext): Promise<{
  received: boolean;
  nextAction: string;
}> {
  const { callback, session } = ctx;

  if (!callback.responses || callback.responses.length === 0) {
    return { received: true, nextAction: 'no_responses' };
  }

  // Store raw responses in S3
  const s3Key = `interviews/${callback.interviewId}/levels/L${callback.level}/${callback.intervieweeId}/response-raw.json`;

  await s3Client.putObject(s3Key, {
    interviewId: callback.interviewId,
    intervieweeId: callback.intervieweeId,
    level: callback.level,
    receivedAt: new Date().toISOString(),
    openclawSessionId: callback.sessionId,
    channel: callback.sessionState?.channelUsed || 'unknown',
    responses: callback.responses,
    sessionMetrics: {
      responseTime: callback.sessionState?.totalResponseTime,
      remindersSent: callback.sessionState?.remindersSent || 0,
    },
  });

  // Update session state
  await incrementResponseCount(
    callback.interviewId,
    callback.intervieweeId,
    callback.responses.length
  );

  await markLevelCompleted(
    callback.interviewId,
    callback.intervieweeId,
    callback.level
  );

  await updateSessionState({
    interviewId: callback.interviewId,
    intervieweeId: callback.intervieweeId,
    status: 'processing',
    currentLevel: callback.level,
  });

  // TODO: Trigger async processing pipeline:
  // 1. Grammar correction (Claude API)
  // 2. Analysis (Claude API + Context MCP)
  // 3. Check convergence
  // 4. Generate next level questions OR complete interview

  return { received: true, nextAction: 'processing' };
}

async function handlePartialResponse(ctx: CallbackContext): Promise<{
  received: boolean;
  action: string;
}> {
  const { callback, session } = ctx;

  if (callback.responses && callback.responses.length > 0) {
    // Store partial responses
    const s3Key = `interviews/${callback.interviewId}/levels/L${callback.level}/${callback.intervieweeId}/response-partial.json`;

    await s3Client.putObject(s3Key, {
      interviewId: callback.interviewId,
      intervieweeId: callback.intervieweeId,
      level: callback.level,
      receivedAt: new Date().toISOString(),
      responses: callback.responses,
      pendingQuestions: callback.pendingQuestions,
      isPartial: true,
    });

    await incrementResponseCount(
      callback.interviewId,
      callback.intervieweeId,
      callback.responses.length
    );
  }

  await updateSessionState({
    interviewId: callback.interviewId,
    intervieweeId: callback.intervieweeId,
    lastActivityAt: new Date().toISOString(),
  });

  return { received: true, action: 'wait_for_remaining' };
}

async function handleTimeout(ctx: CallbackContext): Promise<{
  received: boolean;
  action: string;
}> {
  const { callback } = ctx;

  // Store timeout event
  const s3Key = `interviews/${callback.interviewId}/levels/L${callback.level}/${callback.intervieweeId}/timeout.json`;

  await s3Client.putObject(s3Key, {
    interviewId: callback.interviewId,
    intervieweeId: callback.intervieweeId,
    level: callback.level,
    timeoutAt: callback.timeoutAt,
    remindersSent: callback.sessionState?.remindersSent || 0,
    lastReminderAt: callback.sessionState?.lastReminderAt,
    totalWaitTime: callback.sessionState?.totalWaitTime,
  });

  // Update session state
  await updateSessionState({
    interviewId: callback.interviewId,
    intervieweeId: callback.intervieweeId,
    status: 'timed_out',
  });

  // Append to audit log
  await appendAuditEvent(callback.interviewId, {
    event: 'session.timed_out',
    intervieweeId: callback.intervieweeId,
    level: callback.level,
    remindersSent: callback.sessionState?.remindersSent,
  });

  return { received: true, action: 'archive' };
}

async function handleEscalation(ctx: CallbackContext): Promise<{
  received: boolean;
  action: string;
}> {
  const { callback, session } = ctx;

  // Store escalation event
  const s3Key = `interviews/${callback.interviewId}/levels/L${callback.level}/${callback.intervieweeId}/escalation.json`;

  await s3Client.putObject(s3Key, {
    interviewId: callback.interviewId,
    intervieweeId: callback.intervieweeId,
    level: callback.level,
    escalationReason: callback.escalationReason,
    remindersSent: callback.sessionState?.remindersSent || 0,
    pendingQuestions: callback.pendingQuestions,
    escalatedAt: new Date().toISOString(),
  });

  // Append to audit log
  await appendAuditEvent(callback.interviewId, {
    event: 'session.escalated',
    intervieweeId: callback.intervieweeId,
    reason: callback.escalationReason,
    employeeId: session.employeeId,
  });

  // TODO: Send notification to employee
  // - Email/Slack notification
  // - Include interview context and escalation reason

  return { received: true, action: 'notify_employee' };
}

async function handleError(ctx: CallbackContext): Promise<{
  received: boolean;
  action: string;
}> {
  const { callback, session } = ctx;

  if (!callback.error) {
    return { received: true, action: 'no_error_details' };
  }

  // Store error event
  const s3Key = `interviews/${callback.interviewId}/errors/${callback.intervieweeId}/${Date.now()}.json`;

  await s3Client.putObject(s3Key, {
    interviewId: callback.interviewId,
    intervieweeId: callback.intervieweeId,
    sessionId: callback.sessionId,
    error: callback.error,
    recordedAt: new Date().toISOString(),
  });

  // Append to audit log
  await appendAuditEvent(callback.interviewId, {
    event: 'openclaw.error',
    intervieweeId: callback.intervieweeId,
    errorCode: callback.error.code,
    retryable: callback.error.retryable,
  });

  // Determine action based on error type
  if (callback.error.code === 'CHANNEL_DELIVERY_FAILED' && !callback.error.retryable) {
    // Try fallback channel if available
    const fallbackChannel = getFallbackChannel(session);
    if (fallbackChannel) {
      // TODO: Trigger retry on fallback channel via OpenClaw
      return { received: true, action: 'fallback_channel' };
    }
  }

  if (callback.error.retryable) {
    return { received: true, action: 'retry_pending' };
  }

  // Non-retryable error - mark session as error state
  await updateSessionState({
    interviewId: callback.interviewId,
    intervieweeId: callback.intervieweeId,
    status: 'error',
  });

  return { received: true, action: 'error_recorded' };
}

function getFallbackChannel(
  session: InterviewSession
): 'email' | 'sms' | 'whatsapp' | 'slack' | null {
  const preferred = session.interviewee.preferredChannel;
  const hasEmail = !!session.interviewee.email;
  const hasPhone = !!session.interviewee.phone;
  const hasSlack = !!session.interviewee.slackUserId;

  // Simple fallback logic
  if (preferred !== 'email' && hasEmail) return 'email';
  if (preferred !== 'sms' && hasPhone) return 'sms';
  if (preferred !== 'slack' && hasSlack) return 'slack';

  return null;
}

// ─────────────────────────────────────────────────────────────
// Audit Log Helper
// ─────────────────────────────────────────────────────────────

async function appendAuditEvent(
  interviewId: string,
  event: Record<string, unknown>
): Promise<void> {
  const auditEntry = {
    ts: new Date().toISOString(),
    ...event,
  };

  // For POC, append to a single audit file
  // In production, use append-only strategy or DynamoDB stream
  const s3Key = `interviews/${interviewId}/audit/events.jsonl`;

  try {
    const existing = await s3Client.getObject(s3Key);
    const content = existing
      ? existing + '\n' + JSON.stringify(auditEntry)
      : JSON.stringify(auditEntry);
    await s3Client.putObject(s3Key, content, 'text/plain');
  } catch {
    // File doesn't exist, create it
    await s3Client.putObject(s3Key, JSON.stringify(auditEntry), 'text/plain');
  }
}

// ─────────────────────────────────────────────────────────────
// Main Handler
// ─────────────────────────────────────────────────────────────

export async function handleOpenClawCallback(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = req.headers['x-request-id'] as string | undefined;
  const signature = req.headers['x-openclaw-signature'] as string | undefined;

  // Verify signature
  const rawBody = JSON.stringify(req.body);
  if (!verifySignature(rawBody, signature)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Replay protection
  if (!checkReplayProtection(requestId)) {
    res.status(409).json({ error: 'Duplicate request' });
    return;
  }

  const callback = req.body as OpenClawCallback;

  // Validate required fields
  if (!callback.type || !callback.sessionId) {
    res.status(400).json({ error: 'Missing required fields: type, sessionId' });
    return;
  }

  // Look up session by OpenClaw session ID
  const lookup = await getSessionByOpenClawId(callback.sessionId);

  if (!lookup) {
    res.status(404).json({ error: 'Session not found for OpenClaw sessionId' });
    return;
  }

  const ctx: CallbackContext = {
    callback,
    session: lookup.session,
    interview: lookup.interview,
  };

  try {
    let result: { received: boolean; [key: string]: unknown };

    switch (callback.type) {
      case 'response':
        result = await handleResponse(ctx);
        break;
      case 'partial_response':
        result = await handlePartialResponse(ctx);
        break;
      case 'timeout':
        result = await handleTimeout(ctx);
        break;
      case 'escalation':
        result = await handleEscalation(ctx);
        break;
      case 'error':
        result = await handleError(ctx);
        break;
      default:
        res.status(400).json({ error: `Unknown callback type: ${callback.type}` });
        return;
    }

    res.status(200).json(result);
  } catch (error) {
    console.error('Callback handler error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────
// Express Router Export
// ─────────────────────────────────────────────────────────────

export function registerOpenClawRoutes(app: {
  post: (path: string, handler: (req: Request, res: Response) => Promise<void>) => void;
}): void {
  app.post('/api/openclaw/callback', handleOpenClawCallback);
}
