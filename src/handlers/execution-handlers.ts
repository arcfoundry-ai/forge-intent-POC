/**
 * Interview Execution Handlers (4 tools)
 * - interview_get_questions
 * - interview_submit_response
 * - interview_run_turn
 * - interview_advance_round
 */

import { s3Client } from '../storage/s3-client.js';
import { getSession } from './session-handlers.js';
import type {
  Session,
  Question,
  Round,
  WolframScore,
  BayesianResult,
  SubmitResponseInput,
  RunTurnInput,
} from '../types.js';

// CDM Question Templates (fallback if S3 fetch fails)
const DEFAULT_QUESTIONS: Record<number, string[]> = {
  1: [
    'Walk me through the last time you {domainActivity}.',
    'What were you trying to accomplish?',
    'What happened that made you stop or change direction?',
  ],
  2: [
    'When you hit that friction, what did you do next?',
    'What information were you looking for?',
    'How did you eventually resolve it, or did you?',
  ],
  3: [
    'If you could change one thing about this experience, what would it be?',
    'What would have helped you succeed faster?',
    'How often does this kind of friction happen?',
  ],
};

/**
 * Get current round questions for a session
 */
export async function getQuestions(
  sessionId: string
): Promise<{ questions: Question[]; roundNumber: number } | null> {
  const session = await getSession(sessionId);
  if (!session) return null;

  const currentRound = session.rounds[session.currentRound - 1];
  if (!currentRound) {
    // Generate first round questions
    const questions = await generateRoundQuestions(session, 1);
    return { questions, roundNumber: 1 };
  }

  return {
    questions: currentRound.questions,
    roundNumber: currentRound.roundNumber,
  };
}

/**
 * Submit a single response
 */
export async function submitResponse(
  input: SubmitResponseInput
): Promise<{ wolframScore: WolframScore; posteriors: Record<string, number> } | null> {
  const session = await getSession(input.sessionId);
  if (!session) return null;

  const currentRound = session.rounds[session.currentRound - 1];
  if (!currentRound) return null;

  const question = currentRound.questions.find(
    (q) => q.questionId === input.questionId
  );
  if (!question) return null;

  // Record response
  question.response = input.response;
  question.timestamp = new Date().toISOString();

  // Score response (Wolfram-style quality assessment)
  const wolframScore = scoreResponse(input.response);
  question.wolframScore = wolframScore;

  // Update session state
  session.state = 'EXECUTING';
  session.lastActivity = new Date().toISOString();

  await s3Client.saveSession(session);

  return {
    wolframScore,
    posteriors: session.posteriors,
  };
}

/**
 * Run a full turn (multiple responses + Bayesian update)
 */
export async function runTurn(
  input: RunTurnInput
): Promise<{ bayesian: BayesianResult; nextQuestions: Question[] | null } | null> {
  const session = await getSession(input.sessionId);
  if (!session) return null;

  // Process all responses
  for (const resp of input.responses) {
    await submitResponse({
      sessionId: input.sessionId,
      questionId: resp.questionId,
      response: resp.response,
    });
  }

  // Reload session after responses
  const updatedSession = await getSession(input.sessionId);
  if (!updatedSession) return null;

  // Run Bayesian update
  const bayesian = updateBayesian(updatedSession);

  // Update session with Bayesian results
  updatedSession.posteriors = bayesian.posteriors;
  updatedSession.dominantHypothesis = bayesian.dominantHypothesis;
  updatedSession.dominantPosterior = bayesian.dominantPosterior;

  if (bayesian.convergenceReached) {
    updatedSession.state = 'CONVERGENCE_REACHED';
    await s3Client.saveSession(updatedSession);
    return { bayesian, nextQuestions: null };
  }

  // Generate next round questions
  const nextRound = updatedSession.currentRound + 1;
  if (nextRound > 3) {
    // Max rounds reached without convergence
    updatedSession.state = 'WAITING_FOR_INPUT';
    await s3Client.saveSession(updatedSession);
    return { bayesian, nextQuestions: null };
  }

  const nextQuestions = await generateRoundQuestions(updatedSession, nextRound);
  const newRound: Round = {
    roundNumber: nextRound,
    questions: nextQuestions,
    completed: false,
    wolframAssessment: null,
  };

  updatedSession.rounds.push(newRound);
  updatedSession.currentRound = nextRound;
  updatedSession.state = 'WAITING_FOR_INPUT';

  await s3Client.saveSession(updatedSession);

  return { bayesian, nextQuestions };
}

/**
 * Force advance to next round
 */
export async function advanceRound(
  sessionId: string
): Promise<{ newRoundNumber: number; questions: Question[] } | null> {
  const session = await getSession(sessionId);
  if (!session) return null;

  const nextRound = session.currentRound + 1;
  const questions = await generateRoundQuestions(session, nextRound);

  const newRound: Round = {
    roundNumber: nextRound,
    questions,
    completed: false,
    wolframAssessment: null,
  };

  session.rounds.push(newRound);
  session.currentRound = nextRound;
  session.state = 'WAITING_FOR_INPUT';
  session.lastActivity = new Date().toISOString();

  await s3Client.saveSession(session);

  return { newRoundNumber: nextRound, questions };
}

// ─────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────

async function generateRoundQuestions(
  session: Session,
  roundNumber: number
): Promise<Question[]> {
  // Try to fetch templates from S3
  let templates = DEFAULT_QUESTIONS[roundNumber] || DEFAULT_QUESTIONS[1];

  try {
    const s3Templates = await s3Client.getQuestionTemplates();
    if (s3Templates && typeof s3Templates === 'object') {
      const s3Round = (s3Templates as Record<string, string[]>)[String(roundNumber)];
      if (s3Round) templates = s3Round;
    }
  } catch {
    // Use default templates
  }

  return templates.map((template, idx) => ({
    questionId: `R${roundNumber}Q${idx + 1}`,
    questionText: template.replace('{domainActivity}', session.domainActivity),
  }));
}

function scoreResponse(response: string): WolframScore {
  // Simple heuristic scoring (production would use LLM)
  const words = response.split(/\s+/).length;
  const hasSpecifics = /\b(because|when|then|after|before|while)\b/i.test(response);
  const hasEmotion = /\b(frustrated|confused|happy|annoyed|stuck|lost)\b/i.test(response);
  const hasAction = /\b(tried|clicked|went|searched|asked|called)\b/i.test(response);

  const quality = Math.min(1, (words / 50) * 0.5 + (hasSpecifics ? 0.2 : 0) + (hasEmotion ? 0.15 : 0) + (hasAction ? 0.15 : 0));
  const relevance = hasAction ? 0.8 : 0.5;
  const specificity = hasSpecifics ? 0.8 : 0.4;

  return {
    quality: Math.round(quality * 100) / 100,
    relevance: Math.round(relevance * 100) / 100,
    specificity: Math.round(specificity * 100) / 100,
    composite: Math.round(((quality + relevance + specificity) / 3) * 100) / 100,
  };
}

function updateBayesian(session: Session): BayesianResult {
  // Extract signals from responses
  const signals: Record<string, number> = {
    access_barrier: 0,
    comprehension_gap: 0,
    tool_friction: 0,
    time_constraint: 0,
    process_unclear: 0,
  };

  for (const round of session.rounds) {
    for (const q of round.questions) {
      if (q.response) {
        const resp = q.response.toLowerCase();

        // Pattern matching for hypothesis detection
        if (/\b(couldn't find|couldn't access|no access|blocked|permission)\b/.test(resp)) {
          signals.access_barrier += 0.3;
        }
        if (/\b(confus|didn't understand|unclear|complex|hard to)\b/.test(resp)) {
          signals.comprehension_gap += 0.3;
        }
        if (/\b(slow|buggy|crashed|error|broken|doesn't work)\b/.test(resp)) {
          signals.tool_friction += 0.3;
        }
        if (/\b(no time|rushed|deadline|busy|later)\b/.test(resp)) {
          signals.time_constraint += 0.3;
        }
        if (/\b(didn't know|which step|what next|where to)\b/.test(resp)) {
          signals.process_unclear += 0.3;
        }
      }
    }
  }

  // Normalize to posteriors
  const total = Object.values(signals).reduce((a, b) => a + b, 0) || 1;
  const posteriors: Record<string, number> = {};

  for (const [key, value] of Object.entries(signals)) {
    posteriors[key] = Math.round((value / total) * 100) / 100;
  }

  // Find dominant
  let dominantHypothesis = 'unclassified';
  let dominantPosterior = 0;

  for (const [key, value] of Object.entries(posteriors)) {
    if (value > dominantPosterior) {
      dominantPosterior = value;
      dominantHypothesis = key;
    }
  }

  const convergenceReached = dominantPosterior >= 0.85;

  return {
    posteriors,
    dominantHypothesis,
    dominantPosterior,
    convergenceReached,
    recommendation: convergenceReached
      ? `CONVERGENCE: ${dominantHypothesis} reached ${Math.round(dominantPosterior * 100)}%`
      : `Continue: highest is ${dominantHypothesis} at ${Math.round(dominantPosterior * 100)}%`,
  };
}
