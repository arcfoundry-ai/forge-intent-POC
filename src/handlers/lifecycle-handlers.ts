/**
 * Lifecycle & Handoff Handlers (2 tools)
 * - interview_handoff
 * - interview_terminate
 */

import { s3Client } from '../storage/s3-client.js';
import { getSession } from './session-handlers.js';
import type {
  Session,
  HandoffPayload,
  HandoffTarget,
  HandoffInput,
  TerminateInput,
} from '../types.js';

/**
 * Prepare session for agent handoff
 */
export async function handoff(
  input: HandoffInput
): Promise<HandoffPayload | { error: string }> {
  const session = await getSession(input.sessionId);
  if (!session) {
    return { error: 'Session not found' };
  }

  // Validate target agent
  const validTargets: readonly string[] = ['forge-builder', 'forge-platform', 'forge-phoenix', 'human-review'];
  if (!validTargets.includes(input.targetAgent)) {
    return {
      error: `Invalid handoff target: ${input.targetAgent}. Allowed: ${validTargets.join(', ')}`,
    };
  }

  // Get pending questions (unanswered from current round)
  const currentRound = session.rounds[session.currentRound - 1];
  const pendingQuestions = currentRound
    ? currentRound.questions.filter((q) => !q.response)
    : [];

  // Generate evidence summary
  const evidenceSummary = generateEvidenceSummary(session);

  const payload: HandoffPayload = {
    type: 'interview_session',
    sessionId: session.id,
    projectId: session.projectId,
    currentState: {
      round: session.currentRound,
      posteriors: session.posteriors,
      dominantHypothesis: session.dominantHypothesis,
      confidence: session.dominantPosterior,
    },
    pendingQuestions,
    evidenceSummary,
    targetAgent: input.targetAgent as HandoffTarget,
    handoffReason: input.reason || 'convergence',
    timestamp: new Date().toISOString(),
  };

  // Update session state
  session.state = 'WAITING_FOR_INPUT';
  session.lastActivity = new Date().toISOString();
  session.metadata = {
    ...session.metadata,
    lastHandoff: {
      targetAgent: input.targetAgent,
      reason: input.reason || 'convergence',
      timestamp: payload.timestamp,
    },
  };

  await s3Client.saveSession(session);

  return payload;
}

/**
 * Terminate and archive a session
 */
export async function terminate(
  input: TerminateInput
): Promise<{ archived: boolean; s3Path: string } | { error: string }> {
  const session = await getSession(input.sessionId);
  if (!session) {
    return { error: 'Session not found' };
  }

  // Update session state before archiving
  session.state = 'TERMINATED';
  session.lastActivity = new Date().toISOString();
  session.metadata = {
    ...session.metadata,
    terminationReason: input.reason,
    terminatedAt: session.lastActivity,
  };

  // Archive to cold storage
  const s3Path = await s3Client.archiveSession(session);

  return {
    archived: true,
    s3Path,
  };
}

// ─────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────

function generateEvidenceSummary(session: Session): string {
  const lines: string[] = [];

  lines.push(`Session: ${session.id}`);
  lines.push(`Project: ${session.projectId}`);
  lines.push(`Respondent: ${session.respondentDescription}`);
  lines.push(`Domain: ${session.domainActivity}`);
  lines.push(`Rounds completed: ${session.currentRound}`);
  lines.push('');

  if (session.dominantHypothesis) {
    lines.push(`Dominant hypothesis: ${session.dominantHypothesis}`);
    lines.push(`Confidence: ${Math.round(session.dominantPosterior * 100)}%`);
    lines.push('');
  }

  lines.push('Key evidence:');
  for (const round of session.rounds) {
    for (const q of round.questions) {
      if (q.response && q.wolframScore && q.wolframScore.composite >= 0.6) {
        lines.push(`- [R${round.roundNumber}] "${q.response.slice(0, 100)}..."`);
      }
    }
  }

  return lines.join('\n');
}
