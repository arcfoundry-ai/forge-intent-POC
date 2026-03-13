/**
 * DynamoDB Types for Forge Intent Interview Sessions
 *
 * Single-table design with GSIs for efficient access patterns:
 * - Primary: Get session by interviewId + intervieweeId
 * - GSI1: Get session by OpenClaw sessionId (callback lookup)
 * - GSI2: Get all interviews for an interviewee
 */

// ─────────────────────────────────────────────────────────────
// Interview Session State (stored in DynamoDB)
// ─────────────────────────────────────────────────────────────

export type InterviewSessionStatus =
  | 'pending'        // Created, not yet started with OpenClaw
  | 'active'         // Questions sent, waiting for response
  | 'processing'     // Response received, generating next level
  | 'completed'      // Root cause identified, interview done
  | 'timed_out'      // No response within timeout
  | 'cancelled'      // Manually cancelled
  | 'error';         // Error state

export interface InterviewSession {
  // Primary key
  interviewId: string;
  intervieweeId: string;

  // OpenClaw integration
  openclawSessionId: string | null;
  openclawAgentId: string | null;

  // Interviewee info
  interviewee: {
    name: string;
    email?: string;
    phone?: string;
    slackUserId?: string;
    preferredChannel: 'email' | 'sms' | 'whatsapp' | 'slack';
    timezone: string;
  };

  // Interview state
  status: InterviewSessionStatus;
  currentLevel: number;
  problemStatement: string;

  // Progress tracking
  levelsCompleted: number[];
  totalResponsesReceived: number;
  convergenceScore: number;

  // Timing
  createdAt: string;
  startedAt: string | null;
  lastActivityAt: string;
  completedAt: string | null;

  // Session config
  config: {
    timeoutHours: number;
    reminderSchedule: number[];
    maxLevels: number;
    convergenceThreshold: number;
  };

  // Metadata
  employeeId: string;
  projectId: string;
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
// Interview Manifest (parent record)
// ─────────────────────────────────────────────────────────────

export type InterviewStatus =
  | 'draft'
  | 'active'
  | 'converged'
  | 'cancelled';

export interface Interview {
  interviewId: string;
  projectId: string;
  problemStatement: string;
  status: InterviewStatus;

  // Counts
  totalInterviewees: number;
  activeInterviewees: number;
  completedInterviewees: number;

  // Convergence
  convergenceScore: number;
  rootCauseIdentified: boolean;

  // Timing
  createdAt: string;
  createdBy: string;
  startedAt: string | null;
  completedAt: string | null;

  // Config
  config: {
    timeoutHours: number;
    reminderSchedule: number[];
    maxLevels: number;
    convergenceThreshold: number;
  };
}

// ─────────────────────────────────────────────────────────────
// DynamoDB Record Types (with key structure)
// ─────────────────────────────────────────────────────────────

export interface InterviewRecord extends Interview {
  PK: string;  // INTERVIEW#{interviewId}
  SK: string;  // MANIFEST
}

export interface InterviewSessionRecord extends InterviewSession {
  PK: string;           // INTERVIEW#{interviewId}
  SK: string;           // SESSION#{intervieweeId}
  GSI1PK?: string;      // OCSESS#{openclawSessionId} (sparse)
  GSI1SK?: string;      // SESSION
  GSI2PK: string;       // INTERVIEWEE#{intervieweeId}
  GSI2SK: string;       // INTERVIEW#{interviewId}
}

// ─────────────────────────────────────────────────────────────
// Input Types for Operations
// ─────────────────────────────────────────────────────────────

export interface CreateInterviewInput {
  projectId: string;
  problemStatement: string;
  employeeId: string;
  config?: Partial<Interview['config']>;
}

export interface AddIntervieweeInput {
  interviewId: string;
  interviewee: InterviewSession['interviewee'];
  employeeId: string;
}

export interface StartSessionInput {
  interviewId: string;
  intervieweeId: string;
  openclawSessionId: string;
  openclawAgentId: string;
}

export interface UpdateSessionStateInput {
  interviewId: string;
  intervieweeId: string;
  status?: InterviewSessionStatus;
  currentLevel?: number;
  convergenceScore?: number;
  lastActivityAt?: string;
}

// ─────────────────────────────────────────────────────────────
// Callback Types (from OpenClaw)
// ─────────────────────────────────────────────────────────────

export type OpenClawCallbackType =
  | 'response'
  | 'partial_response'
  | 'timeout'
  | 'escalation'
  | 'error';

export interface OpenClawCallback {
  type: OpenClawCallbackType;
  interviewId: string;
  intervieweeId: string;
  sessionId: string;
  level: number;
  responses?: Array<{
    questionId: string;
    rawText: string;
    receivedAt: string;
    channel: string;
    metadata?: Record<string, unknown>;
  }>;
  pendingQuestions?: string[];
  sessionState?: {
    remindersSent: number;
    lastReminderAt?: string;
    totalResponseTime?: string;
    channelUsed?: string;
    status?: string;
    totalWaitTime?: string;
  };
  timeoutAt?: string;
  escalationReason?: string;
  error?: {
    code: string;
    message: string;
    channel?: string;
    retryable: boolean;
    occurredAt: string;
  };
}

// ─────────────────────────────────────────────────────────────
// Query Results
// ─────────────────────────────────────────────────────────────

export interface SessionLookupResult {
  session: InterviewSession;
  interview: Interview;
}
