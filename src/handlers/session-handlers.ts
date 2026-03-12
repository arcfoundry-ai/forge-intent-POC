/**
 * Session Management Handlers (4 tools)
 * - interview_create_session
 * - interview_get_session
 * - interview_list_sessions
 * - interview_delete_session
 */

import { v4 as uuidv4 } from 'uuid';
import { s3Client } from '../storage/s3-client.js';
import type {
  Session,
  SessionSummary,
  CreateSessionInput,
} from '../types.js';

/**
 * Create a new interview session
 */
export async function createSession(
  input: CreateSessionInput
): Promise<{ sessionId: string; status: string }> {
  const sessionId = `sess-${uuidv4().slice(0, 8)}`;
  const now = new Date().toISOString();

  const session: Session = {
    id: sessionId,
    projectId: input.projectId,
    respondentDescription: input.respondentDescription,
    domainActivity: input.domainActivity,
    state: 'INITIALIZED',
    currentRound: 0,
    rounds: [],
    posteriors: {},
    dominantHypothesis: null,
    dominantPosterior: 0,
    created: now,
    lastActivity: now,
  };

  await s3Client.saveSession(session);

  return {
    sessionId,
    status: 'INITIALIZED',
  };
}

/**
 * Get a session by ID
 */
export async function getSession(
  sessionId: string
): Promise<Session | null> {
  // First check active index to find projectId
  const index = await s3Client.getActiveSessionsIndex();
  const summary = index.activeSessions.find((s) => s.sessionId === sessionId);

  if (summary) {
    return s3Client.getSession(summary.projectId, sessionId);
  }

  // Session not in active index - might be archived or not exist
  return null;
}

/**
 * List sessions for a project
 */
export async function listSessions(
  projectId: string,
  status?: string
): Promise<SessionSummary[]> {
  const sessions = await s3Client.listProjectSessions(projectId);

  if (status) {
    return sessions.filter((s) => s.state === status);
  }

  return sessions;
}

/**
 * Delete a session
 */
export async function deleteSession(
  sessionId: string
): Promise<{ deleted: boolean }> {
  // Find session to get projectId
  const session = await getSession(sessionId);

  if (!session) {
    return { deleted: false };
  }

  await s3Client.deleteSession(session.projectId, sessionId);
  return { deleted: true };
}
