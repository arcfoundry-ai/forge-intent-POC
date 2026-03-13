/**
 * OpenClaw Client Service
 *
 * Sends commands to OpenClaw Gateway:
 * - interview-start: Start new interview session
 * - interview-continue: Send next level questions
 * - interview-complete: Mark interview complete
 * - interview-cancel: Cancel interview
 */

import type { InterviewSession, Interview } from '../storage/dynamodb-types.js';

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const OPENCLAW_BASE_URL =
  process.env.OPENCLAW_BASE_URL || 'http://localhost:3100/openclaw';
const WEBHOOK_SECRET = process.env.FORGE_INTENT_WEBHOOK_SECRET || 'dev-secret';
const CALLBACK_URL =
  process.env.FORGE_INTENT_URL || 'http://localhost:3001';

const RETRY_CONFIG = {
  maxRetries: 3,
  backoffMs: [1000, 2000, 4000],
  timeoutMs: 30000,
};

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface Question {
  id: string;
  text: string;
  type: 'open' | 'scale' | 'choice';
  context?: string;
}

interface InterviewStartRequest {
  interviewId: string;
  intervieweeId: string;
  interviewee: {
    name: string;
    email?: string;
    phone?: string;
    slackUserId?: string;
    preferredChannel: 'email' | 'sms' | 'whatsapp' | 'slack';
  };
  problemStatement: string;
  level: number;
  questions: Question[];
  session: {
    timeoutHours: number;
    reminderSchedule: number[];
    escalateAfterReminders?: number;
    timezone: string;
  };
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}

interface InterviewContinueRequest {
  interviewId: string;
  intervieweeId: string;
  sessionId: string;
  level: number;
  questions: Question[];
  session: {
    timeoutHours: number;
    reminderSchedule: number[];
  };
}

interface InterviewCompleteRequest {
  interviewId: string;
  intervieweeId: string;
  sessionId: string;
  reason: 'root_cause_identified' | 'max_levels_reached' | 'manual';
  finalMessage?: {
    send: boolean;
    text: string;
  };
}

interface InterviewCancelRequest {
  interviewId: string;
  intervieweeId: string;
  sessionId: string;
  reason: string;
  notifyInterviewee: boolean;
}

interface OpenClawResponse {
  success: boolean;
  sessionId?: string;
  agentId?: string;
  cronJobs?: Array<{
    id: string;
    type: string;
    scheduledAt: string;
  }>;
  messageSentAt?: string;
  channel?: string;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ─────────────────────────────────────────────────────────────
// HTTP Client with Retry
// ─────────────────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryCount = 0
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    RETRY_CONFIG.timeoutMs
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Retry on 5xx errors
    if (
      response.status >= 500 &&
      retryCount < RETRY_CONFIG.maxRetries
    ) {
      await sleep(RETRY_CONFIG.backoffMs[retryCount] || 4000);
      return fetchWithRetry(url, options, retryCount + 1);
    }

    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    if (retryCount < RETRY_CONFIG.maxRetries) {
      await sleep(RETRY_CONFIG.backoffMs[retryCount] || 4000);
      return fetchWithRetry(url, options, retryCount + 1);
    }

    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─────────────────────────────────────────────────────────────
// OpenClaw Client
// ─────────────────────────────────────────────────────────────

export class OpenClawClient {
  private baseUrl: string;
  private secret: string;
  private callbackUrl: string;

  constructor(
    baseUrl: string = OPENCLAW_BASE_URL,
    secret: string = WEBHOOK_SECRET,
    callbackUrl: string = CALLBACK_URL
  ) {
    this.baseUrl = baseUrl;
    this.secret = secret;
    this.callbackUrl = callbackUrl;
  }

  /**
   * Start a new interview session
   */
  async startInterview(
    session: InterviewSession,
    questions: Question[]
  ): Promise<OpenClawResponse> {
    const request: InterviewStartRequest = {
      interviewId: session.interviewId,
      intervieweeId: session.intervieweeId,
      interviewee: {
        name: session.interviewee.name,
        email: session.interviewee.email,
        phone: session.interviewee.phone,
        slackUserId: session.interviewee.slackUserId,
        preferredChannel: session.interviewee.preferredChannel,
      },
      problemStatement: session.problemStatement,
      level: 1,
      questions,
      session: {
        timeoutHours: session.config.timeoutHours,
        reminderSchedule: session.config.reminderSchedule,
        escalateAfterReminders: 2,
        timezone: session.interviewee.timezone,
      },
      callbackUrl: `${this.callbackUrl}/api/openclaw/callback`,
      metadata: {
        employeeId: session.employeeId,
        projectId: session.projectId,
      },
    };

    return this.sendCommand('/hooks/interview-start', request);
  }

  /**
   * Send next level questions
   */
  async continueInterview(
    session: InterviewSession,
    level: number,
    questions: Question[]
  ): Promise<OpenClawResponse> {
    if (!session.openclawSessionId) {
      throw new Error('Session has no OpenClaw sessionId');
    }

    const request: InterviewContinueRequest = {
      interviewId: session.interviewId,
      intervieweeId: session.intervieweeId,
      sessionId: session.openclawSessionId,
      level,
      questions,
      session: {
        timeoutHours: session.config.timeoutHours,
        reminderSchedule: session.config.reminderSchedule,
      },
    };

    return this.sendCommand('/hooks/interview-continue', request);
  }

  /**
   * Complete an interview
   */
  async completeInterview(
    session: InterviewSession,
    reason: InterviewCompleteRequest['reason'] = 'root_cause_identified',
    thankYouMessage?: string
  ): Promise<OpenClawResponse> {
    if (!session.openclawSessionId) {
      throw new Error('Session has no OpenClaw sessionId');
    }

    const request: InterviewCompleteRequest = {
      interviewId: session.interviewId,
      intervieweeId: session.intervieweeId,
      sessionId: session.openclawSessionId,
      reason,
      finalMessage: thankYouMessage
        ? { send: true, text: thankYouMessage }
        : undefined,
    };

    return this.sendCommand('/hooks/interview-complete', request);
  }

  /**
   * Cancel an interview
   */
  async cancelInterview(
    session: InterviewSession,
    reason: string,
    notifyInterviewee: boolean = false
  ): Promise<OpenClawResponse> {
    if (!session.openclawSessionId) {
      throw new Error('Session has no OpenClaw sessionId');
    }

    const request: InterviewCancelRequest = {
      interviewId: session.interviewId,
      intervieweeId: session.intervieweeId,
      sessionId: session.openclawSessionId,
      reason,
      notifyInterviewee,
    };

    return this.sendCommand('/hooks/interview-cancel', request);
  }

  /**
   * Send command to OpenClaw
   */
  private async sendCommand(
    endpoint: string,
    body: unknown
  ): Promise<OpenClawResponse> {
    const url = `${this.baseUrl}${endpoint}`;
    const requestId = generateRequestId();

    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.secret}`,
        'X-Request-Id': requestId,
      },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as OpenClawResponse & {
      error?: { code: string; message: string; details?: Record<string, unknown> };
    };

    if (!response.ok) {
      console.error(`OpenClaw error [${endpoint}]:`, data);
      return {
        success: false,
        error: data.error || {
          code: 'UNKNOWN_ERROR',
          message: `HTTP ${response.status}`,
        },
      };
    }

    return data;
  }
}

// ─────────────────────────────────────────────────────────────
// Singleton Export
// ─────────────────────────────────────────────────────────────

export const openclawClient = new OpenClawClient();
