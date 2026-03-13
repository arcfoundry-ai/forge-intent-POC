/**
 * Interview Gateway — Forge Intent CDM Interview System
 *
 * 14 MCP tools for conducting structured interviews with Bayesian convergence.
 * Uses same S3 bucket structure as context-gateway for session persistence.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Octokit } from '@octokit/rest';
import { v4 as uuidv4 } from 'uuid';

// ConfirmationReceipt type (matches arcfoundry-context-MCP schema)
export interface ConfirmationReceipt {
  status: 'success' | 'partial_failure' | 'failure';
  timestamp: string;
  operation: 'add' | 'update' | 'delete';
  target: { domain: string; tier: string; topic: string };
  s3: { status: 'ok' | 'error'; key?: string; etag?: string; error?: string };
  github: { status: 'ok' | 'error' | 'skipped'; sha?: string; url?: string; error?: string };
  pipeline: { status: 'triggered' | 'error' | 'skipped'; runId?: string; url?: string; error?: string };
}

// ─── Types ───────────────────────────────────────────────────────

export type SessionState =
  | 'INITIALIZED'
  | 'EXECUTING'
  | 'WAITING_FOR_INPUT'
  | 'CONVERGENCE_REACHED'
  | 'TERMINATED';

export const HANDOFF_TARGETS = [
  'forge-builder',
  'forge-platform',
  'forge-phoenix',
  'human-review',
] as const;

export type HandoffTarget = (typeof HANDOFF_TARGETS)[number];

export interface Session {
  id: string;
  projectId: string;
  respondentDescription: string;
  domainActivity: string;
  state: SessionState;
  currentRound: number;
  rounds: Round[];
  posteriors: Record<string, number>;
  dominantHypothesis: string | null;
  dominantPosterior: number;
  created: string;
  lastActivity: string;
  metadata?: Record<string, unknown>;
}

export interface Round {
  roundNumber: number;
  questions: Question[];
  completed: boolean;
}

export interface Question {
  questionId: string;
  questionText: string;
  response?: string;
  timestamp?: string;
  wolframScore?: WolframScore;
}

export interface WolframScore {
  quality: number;
  relevance: number;
  specificity: number;
  composite: number;
}

export interface SessionSummary {
  sessionId: string;
  projectId: string;
  state: SessionState;
  currentRound: number;
  dominantHypothesis: string | null;
  dominantPosterior: number;
  lastActivity: string;
}

export interface BayesianResult {
  posteriors: Record<string, number>;
  dominantHypothesis: string;
  dominantPosterior: number;
  convergenceReached: boolean;
  recommendation: string;
}

export interface ConvergenceReport {
  sessionId: string;
  projectId: string;
  rootCause: string;
  hypothesis: string;
  confidence: number;
  severity: string | null;
  isStructural: boolean | null;
  evidenceChain: EvidenceSummary[];
  recommendations: Recommendation[];
  totalResponses: number;
  generatedAt: string;
}

export interface EvidenceSummary {
  questionId: string;
  questionText: string;
  response: string;
  timestamp: string;
  contributionScore: number;
  hypothesis: string;
}

export interface Recommendation {
  title: string;
  description: string;
  category: 'product' | 'process' | 'validation' | 'research';
  priority: 'high' | 'medium' | 'low';
}

export interface GateCResult {
  gate: 'C';
  passed: boolean;
  checks: {
    minRespondents: { required: number; actual: number; passed: boolean };
    majorityConverged: { required: number; actual: number; passed: boolean };
    rootCauseAgreement: { required: number; actual: number; passed: boolean };
  };
  consensusHypothesis: string | null;
  recommendation: string;
}

export interface HandoffPayload {
  type: 'interview_session';
  sessionId: string;
  projectId: string;
  currentState: {
    round: number;
    posteriors: Record<string, number>;
    dominantHypothesis: string | null;
    confidence: number;
  };
  pendingQuestions: Question[];
  evidenceSummary: string;
  targetAgent: HandoffTarget;
  handoffReason: 'convergence' | 'escalation' | 'timeout';
  timestamp: string;
}

// ─── Configuration ───────────────────────────────────────────────

const BUCKET = process.env.CONTEXT_BUCKET || 'arcfoundry-context';
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'arcfoundry-ai';
const GITHUB_REPO = process.env.GITHUB_REPO || 'arcfoundry-context-MCP';
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const DOMAIN = 'forge-intent';
const MAX_ROUNDS = 7; // Maximum interview rounds before forced termination

// CDM Question Templates (Phases 1-7)
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
  4: [
    'Looking back at what you described, what was the single biggest obstacle?',
    'Were there any workarounds you discovered that helped?',
    'Who else on your team experiences this same issue?',
  ],
  5: [
    'If this issue were completely solved tomorrow, what would change for you?',
    'What have you already tried that didn\'t work?',
    'Is there a specific moment where things tend to break down?',
  ],
  6: [
    'How does this problem affect your broader goals or deadlines?',
    'Have you seen this handled better elsewhere (other tools, teams, companies)?',
    'What would you need to see to believe this was truly fixed?',
  ],
  7: [
    'In one sentence, what is the core problem you\'re facing?',
    'What would success look like for you?',
    'Is there anything else we haven\'t covered that feels important?',
  ],
};

// ─── Clients ─────────────────────────────────────────────────────

let s3: S3Client;
let octokit: Octokit | undefined;

export function initInterviewClients(s3Client: S3Client, githubClient?: Octokit): void {
  s3 = s3Client;
  octokit = githubClient;
}

// ─── S3 Helpers ─────────────────────────────────────────────────

function sessionKey(projectId: string, sessionId: string): string {
  return `${DOMAIN}/warm/sessions/${projectId}/${sessionId}.json`;
}

function manifestKey(projectId: string): string {
  return `${DOMAIN}/warm/sessions/${projectId}/manifest.json`;
}

function archiveKey(sessionId: string, projectId: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${DOMAIN}/cold/archives/${year}/${month}/${projectId}-${sessionId}.json`;
}

function githubPath(s3key: string): string {
  return `content/${s3key}`;
}

async function getSessionFromS3(projectId: string, sessionId: string): Promise<Session | null> {
  try {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: sessionKey(projectId, sessionId) })
    );
    const body = await result.Body?.transformToString();
    return body ? JSON.parse(body) : null;
  } catch {
    return null;
  }
}

async function saveSessionToS3(session: Session): Promise<ConfirmationReceipt> {
  const key = sessionKey(session.projectId, session.id);
  const content = JSON.stringify(session, null, 2);

  const receipt: ConfirmationReceipt = {
    status: 'success',
    timestamp: new Date().toISOString(),
    operation: 'update',
    target: { domain: DOMAIN, tier: 'warm', topic: `sessions/${session.projectId}/${session.id}` },
    s3: { status: 'error' },
    github: { status: 'skipped' },
    pipeline: { status: 'skipped' },
  };

  try {
    const result = await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: content,
        ContentType: 'application/json',
      })
    );
    receipt.s3 = { status: 'ok', key, etag: result.ETag || '' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    receipt.s3 = { status: 'error', error: message };
    receipt.status = 'failure';
    return receipt;
  }

  // GitHub commit for audit trail
  if (octokit) {
    try {
      const ghPath = githubPath(key);
      let existingSha: string | undefined;
      try {
        const existing = await octokit.repos.getContent({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          path: ghPath,
        });
        if ('sha' in existing.data) {
          existingSha = existing.data.sha;
        }
      } catch {
        // New file
      }

      const commitResult = await octokit.repos.createOrUpdateFileContents({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: ghPath,
        message: `interview: session ${session.id} state=${session.state}`,
        content: Buffer.from(content).toString('base64'),
        sha: existingSha,
      });

      receipt.github = {
        status: 'ok',
        sha: commitResult.data.commit.sha || '',
        url: commitResult.data.commit.html_url || '',
      };
      receipt.pipeline = { status: 'triggered', runId: 'auto' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      receipt.github = { status: 'error', error: message };
      receipt.status = 'partial_failure';
    }
  }

  return receipt;
}

// ─── Session Management (4 tools) ────────────────────────────────

export async function createSession(
  projectId: string,
  respondentDescription: string,
  domainActivity: string
): Promise<{ sessionId: string; status: SessionState; receipt: ConfirmationReceipt }> {
  const sessionId = `sess-${uuidv4().slice(0, 8)}`;
  const now = new Date().toISOString();

  const session: Session = {
    id: sessionId,
    projectId,
    respondentDescription,
    domainActivity,
    state: 'INITIALIZED',
    currentRound: 0,
    rounds: [],
    posteriors: {},
    dominantHypothesis: null,
    dominantPosterior: 0,
    created: now,
    lastActivity: now,
  };

  const receipt = await saveSessionToS3(session);
  receipt.operation = 'add';

  return { sessionId, status: 'INITIALIZED', receipt };
}

export async function getSession(sessionId: string): Promise<Session | null> {
  // Search for session across projects
  const result = await s3.send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: `${DOMAIN}/warm/sessions/`,
    })
  );

  for (const obj of result.Contents || []) {
    if (obj.Key?.includes(sessionId) && obj.Key.endsWith('.json') && !obj.Key.endsWith('manifest.json')) {
      const parts = obj.Key.split('/');
      const projectId = parts[parts.length - 2];
      return getSessionFromS3(projectId, sessionId);
    }
  }
  return null;
}

export async function listSessions(
  projectId: string,
  status?: SessionState
): Promise<SessionSummary[]> {
  const result = await s3.send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: `${DOMAIN}/warm/sessions/${projectId}/`,
    })
  );

  const summaries: SessionSummary[] = [];

  for (const obj of result.Contents || []) {
    if (obj.Key?.endsWith('.json') && !obj.Key.endsWith('manifest.json')) {
      const session = await getSessionFromS3(
        projectId,
        obj.Key.split('/').pop()!.replace('.json', '')
      );
      if (session) {
        if (!status || session.state === status) {
          summaries.push({
            sessionId: session.id,
            projectId: session.projectId,
            state: session.state,
            currentRound: session.currentRound,
            dominantHypothesis: session.dominantHypothesis,
            dominantPosterior: session.dominantPosterior,
            lastActivity: session.lastActivity,
          });
        }
      }
    }
  }

  return summaries;
}

export async function deleteSession(
  sessionId: string
): Promise<{ deleted: boolean; receipt?: ConfirmationReceipt }> {
  const session = await getSession(sessionId);
  if (!session) return { deleted: false };

  const key = sessionKey(session.projectId, sessionId);

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    return {
      deleted: true,
      receipt: {
        status: 'success',
        timestamp: new Date().toISOString(),
        operation: 'delete',
        target: { domain: DOMAIN, tier: 'warm', topic: `sessions/${session.projectId}/${sessionId}` },
        s3: { status: 'ok', key },
        github: { status: 'skipped' },
        pipeline: { status: 'skipped' },
      },
    };
  } catch {
    return { deleted: false };
  }
}

// ─── Interview Execution (4 tools) ───────────────────────────────

export async function getQuestions(
  sessionId: string
): Promise<{ questions: Question[]; roundNumber: number } | null> {
  const session = await getSession(sessionId);
  if (!session) return null;

  if (session.currentRound === 0 || !session.rounds[session.currentRound - 1]) {
    const questions = generateRoundQuestions(session, 1);
    return { questions, roundNumber: 1 };
  }

  return {
    questions: session.rounds[session.currentRound - 1].questions,
    roundNumber: session.currentRound,
  };
}

export async function submitResponse(
  sessionId: string,
  questionId: string,
  response: string
): Promise<{ wolframScore: WolframScore; posteriors: Record<string, number>; receipt: ConfirmationReceipt } | null> {
  const session = await getSession(sessionId);
  if (!session) return null;

  // Initialize first round if needed
  if (session.currentRound === 0) {
    const questions = generateRoundQuestions(session, 1);
    session.rounds.push({ roundNumber: 1, questions, completed: false });
    session.currentRound = 1;
  }

  const currentRound = session.rounds[session.currentRound - 1];
  const question = currentRound?.questions.find((q) => q.questionId === questionId);
  if (!question) return null;

  question.response = response;
  question.timestamp = new Date().toISOString();
  question.wolframScore = scoreResponse(response);

  session.state = 'EXECUTING';
  session.lastActivity = new Date().toISOString();

  const receipt = await saveSessionToS3(session);

  return {
    wolframScore: question.wolframScore,
    posteriors: session.posteriors,
    receipt,
  };
}

export async function runTurn(
  sessionId: string,
  responses: Array<{ questionId: string; response: string }>
): Promise<{ bayesian: BayesianResult; nextQuestions: Question[] | null; receipt: ConfirmationReceipt } | null> {
  const session = await getSession(sessionId);
  if (!session) return null;

  // Initialize first round if needed
  if (session.currentRound === 0) {
    const questions = generateRoundQuestions(session, 1);
    session.rounds.push({ roundNumber: 1, questions, completed: false });
    session.currentRound = 1;
  }

  // Process responses
  const currentRound = session.rounds[session.currentRound - 1];
  for (const resp of responses) {
    const question = currentRound.questions.find((q) => q.questionId === resp.questionId);
    if (question) {
      question.response = resp.response;
      question.timestamp = new Date().toISOString();
      question.wolframScore = scoreResponse(resp.response);
    }
  }
  currentRound.completed = true;

  // Run Bayesian update
  const bayesian = updateBayesian(session);
  session.posteriors = bayesian.posteriors;
  session.dominantHypothesis = bayesian.dominantHypothesis;
  session.dominantPosterior = bayesian.dominantPosterior;
  session.lastActivity = new Date().toISOString();

  if (bayesian.convergenceReached) {
    session.state = 'CONVERGENCE_REACHED';
    const receipt = await saveSessionToS3(session);
    return { bayesian, nextQuestions: null, receipt };
  }

  // Generate next round
  const nextRoundNum = session.currentRound + 1;

  // Max rounds reached - terminate with best hypothesis
  if (nextRoundNum > MAX_ROUNDS) {
    session.state = 'CONVERGENCE_REACHED'; // Forced convergence at max rounds
    session.metadata = {
      ...session.metadata,
      terminationReason: 'max_rounds_reached',
      roundsCompleted: session.currentRound,
    };
    const receipt = await saveSessionToS3(session);
    return { bayesian, nextQuestions: null, receipt };
  }

  const nextQuestions = generateRoundQuestions(session, nextRoundNum);
  session.rounds.push({ roundNumber: nextRoundNum, questions: nextQuestions, completed: false });
  session.currentRound = nextRoundNum;
  session.state = 'WAITING_FOR_INPUT';

  const receipt = await saveSessionToS3(session);
  return { bayesian, nextQuestions, receipt };
}

export async function advanceRound(
  sessionId: string
): Promise<{ newRoundNumber: number; questions: Question[]; receipt: ConfirmationReceipt; maxReached?: boolean } | null> {
  const session = await getSession(sessionId);
  if (!session) return null;

  const nextRound = session.currentRound + 1;

  // Max rounds check
  if (nextRound > MAX_ROUNDS) {
    session.state = 'CONVERGENCE_REACHED';
    session.metadata = {
      ...session.metadata,
      terminationReason: 'max_rounds_reached',
      roundsCompleted: session.currentRound,
    };
    session.lastActivity = new Date().toISOString();
    const receipt = await saveSessionToS3(session);
    return { newRoundNumber: session.currentRound, questions: [], receipt, maxReached: true };
  }

  const questions = generateRoundQuestions(session, nextRound);

  session.rounds.push({ roundNumber: nextRound, questions, completed: false });
  session.currentRound = nextRound;
  session.state = 'WAITING_FOR_INPUT';
  session.lastActivity = new Date().toISOString();

  const receipt = await saveSessionToS3(session);
  return { newRoundNumber: nextRound, questions, receipt, maxReached: false };
}

// ─── Convergence & Analysis (4 tools) ────────────────────────────

export async function checkConvergence(
  sessionId: string
): Promise<{ converged: boolean; hypothesis: string | null; confidence: number } | null> {
  const session = await getSession(sessionId);
  if (!session) return null;

  return {
    converged: session.state === 'CONVERGENCE_REACHED',
    hypothesis: session.dominantHypothesis,
    confidence: session.dominantPosterior,
  };
}

export async function generateReport(sessionId: string): Promise<ConvergenceReport | null> {
  const session = await getSession(sessionId);
  if (!session) return null;

  const evidenceChain = extractEvidenceChain(session);
  const recommendations = generateRecommendations(session.dominantHypothesis || 'unknown');

  return {
    sessionId: session.id,
    projectId: session.projectId,
    rootCause: session.dominantHypothesis || 'Unknown',
    hypothesis: session.dominantHypothesis || 'unclassified',
    confidence: session.dominantPosterior,
    severity: session.dominantPosterior >= 0.9 ? 'critical' : session.dominantPosterior >= 0.8 ? 'high' : 'medium',
    isStructural: ['access_barrier', 'tool_friction', 'process_unclear'].includes(session.dominantHypothesis || ''),
    evidenceChain,
    recommendations,
    totalResponses: countResponses(session),
    generatedAt: new Date().toISOString(),
  };
}

export async function runGateC(projectId: string, minRespondents = 5): Promise<GateCResult> {
  const sessions = await listSessions(projectId);
  const fullSessions: Session[] = [];

  for (const summary of sessions) {
    const session = await getSession(summary.sessionId);
    if (session) fullSessions.push(session);
  }

  const totalRespondents = fullSessions.length;
  const convergedSessions = fullSessions.filter((s) => s.state === 'CONVERGENCE_REACHED');
  const convergedRatio = totalRespondents > 0 ? convergedSessions.length / totalRespondents : 0;

  const hypothesisCounts: Record<string, number> = {};
  for (const s of convergedSessions) {
    if (s.dominantHypothesis) {
      hypothesisCounts[s.dominantHypothesis] = (hypothesisCounts[s.dominantHypothesis] || 0) + 1;
    }
  }

  let consensusHypothesis: string | null = null;
  let maxCount = 0;
  for (const [hyp, count] of Object.entries(hypothesisCounts)) {
    if (count > maxCount) {
      maxCount = count;
      consensusHypothesis = hyp;
    }
  }

  const agreementRatio = totalRespondents > 0 ? maxCount / totalRespondents : 0;

  const checks = {
    minRespondents: { required: minRespondents, actual: totalRespondents, passed: totalRespondents >= minRespondents },
    majorityConverged: { required: 0.6, actual: convergedRatio, passed: convergedRatio >= 0.6 },
    rootCauseAgreement: { required: 0.5, actual: agreementRatio, passed: agreementRatio >= 0.5 },
  };

  const passed = checks.minRespondents.passed && checks.majorityConverged.passed && checks.rootCauseAgreement.passed;

  let recommendation = '';
  if (!checks.minRespondents.passed) {
    recommendation = `Need ${minRespondents - totalRespondents} more respondents`;
  } else if (!checks.majorityConverged.passed) {
    recommendation = `Only ${Math.round(convergedRatio * 100)}% converged (need 60%)`;
  } else if (!checks.rootCauseAgreement.passed) {
    recommendation = `Only ${Math.round(agreementRatio * 100)}% agree on root cause (need 50%)`;
  } else {
    recommendation = `Gate C passed: ${consensusHypothesis} confirmed by ${Math.round(agreementRatio * 100)}%`;
  }

  return { gate: 'C', passed, checks, consensusHypothesis, recommendation };
}

export async function analyzeProject(projectId: string): Promise<{
  projectId: string;
  totalSessions: number;
  convergedSessions: number;
  gateC: GateCResult;
  generatedAt: string;
}> {
  const sessions = await listSessions(projectId);
  const gateC = await runGateC(projectId);

  return {
    projectId,
    totalSessions: sessions.length,
    convergedSessions: sessions.filter((s) => s.state === 'CONVERGENCE_REACHED').length,
    gateC,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Lifecycle (2 tools) ─────────────────────────────────────────

export async function handoff(
  sessionId: string,
  targetAgent: string,
  reason: 'convergence' | 'escalation' | 'timeout' = 'convergence'
): Promise<HandoffPayload | { error: string }> {
  if (!HANDOFF_TARGETS.includes(targetAgent as HandoffTarget)) {
    return { error: `Invalid handoff target: ${targetAgent}. Allowed: ${HANDOFF_TARGETS.join(', ')}` };
  }

  const session = await getSession(sessionId);
  if (!session) return { error: 'Session not found' };

  const currentRound = session.rounds[session.currentRound - 1];
  const pendingQuestions = currentRound ? currentRound.questions.filter((q) => !q.response) : [];

  return {
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
    evidenceSummary: generateEvidenceSummary(session),
    targetAgent: targetAgent as HandoffTarget,
    handoffReason: reason,
    timestamp: new Date().toISOString(),
  };
}

export async function terminate(
  sessionId: string,
  reason: string
): Promise<{ archived: boolean; s3Path: string; receipt: ConfirmationReceipt } | { error: string }> {
  const session = await getSession(sessionId);
  if (!session) return { error: 'Session not found' };

  session.state = 'TERMINATED';
  session.lastActivity = new Date().toISOString();
  session.metadata = { ...session.metadata, terminationReason: reason };

  // Archive to cold storage
  const coldKey = archiveKey(sessionId, session.projectId);
  const content = JSON.stringify(session, null, 2);

  const receipt: ConfirmationReceipt = {
    status: 'success',
    timestamp: new Date().toISOString(),
    operation: 'add',
    target: { domain: DOMAIN, tier: 'cold', topic: `archives/${session.projectId}-${sessionId}` },
    s3: { status: 'error' },
    github: { status: 'skipped' },
    pipeline: { status: 'skipped' },
  };

  try {
    const result = await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: coldKey,
        Body: content,
        ContentType: 'application/json',
        StorageClass: 'STANDARD_IA',
      })
    );
    receipt.s3 = { status: 'ok', key: coldKey, etag: result.ETag || '' };

    // Delete from warm tier
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: sessionKey(session.projectId, sessionId) }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    receipt.s3 = { status: 'error', error: message };
    receipt.status = 'failure';
    return { archived: false, s3Path: '', receipt };
  }

  return { archived: true, s3Path: `s3://${BUCKET}/${coldKey}`, receipt };
}

// ─── Internal Helpers ────────────────────────────────────────────

/**
 * Get all previously asked question texts from session history
 */
function getPreviouslyAskedQuestions(session: Session): Set<string> {
  const asked = new Set<string>();
  for (const round of session.rounds) {
    for (const q of round.questions) {
      asked.add(q.questionText.toLowerCase().trim());
    }
  }
  return asked;
}

/**
 * Generate questions for a round, with deduplication against previous rounds
 */
function generateRoundQuestions(session: Session, roundNumber: number): Question[] {
  // Get previously asked questions for deduplication
  const previouslyAsked = getPreviouslyAskedQuestions(session);

  // Get templates for this round, with fallback chain
  let templates = DEFAULT_QUESTIONS[roundNumber];

  // If no templates for this round, try to generate contextual follow-ups
  if (!templates) {
    templates = generateContextualQuestions(session, roundNumber);
  }

  // Filter out any questions that have already been asked (fuzzy match)
  const filteredTemplates = templates.filter(template => {
    const normalized = template.replace('{domainActivity}', session.domainActivity).toLowerCase().trim();
    return !previouslyAsked.has(normalized);
  });

  // If all questions were duplicates, generate contextual questions
  const finalTemplates = filteredTemplates.length > 0
    ? filteredTemplates
    : generateContextualQuestions(session, roundNumber);

  return finalTemplates.map((template, idx) => ({
    questionId: `R${roundNumber}Q${idx + 1}`,
    questionText: template.replace('{domainActivity}', session.domainActivity),
  }));
}

/**
 * Generate contextual follow-up questions based on previous responses
 * Used when DEFAULT_QUESTIONS are exhausted or all templates were duplicates
 */
function generateContextualQuestions(session: Session, roundNumber: number): string[] {
  // Extract key themes from previous responses
  const themes = extractResponseThemes(session);
  const dominantHyp = session.dominantHypothesis;

  const contextualQuestions: string[] = [];

  // Generate hypothesis-specific probing questions
  if (dominantHyp === 'access_barrier') {
    contextualQuestions.push(
      'What specific access or permissions were missing?',
      'Who would need to grant you access to resolve this?',
      'How long did you wait before giving up on access?'
    );
  } else if (dominantHyp === 'comprehension_gap') {
    contextualQuestions.push(
      'Which part was most confusing or unclear?',
      'What would have made this easier to understand?',
      'Did you find any documentation that helped, even partially?'
    );
  } else if (dominantHyp === 'tool_friction') {
    contextualQuestions.push(
      'What specific error or issue did you encounter?',
      'Is this a recurring problem or was it a one-time issue?',
      'What tool or alternative did you end up using instead?'
    );
  } else if (dominantHyp === 'time_constraint') {
    contextualQuestions.push(
      'How much time did you have available for this task?',
      'What took longer than expected?',
      'Would additional time have solved the problem, or is it deeper?'
    );
  } else if (dominantHyp === 'process_unclear') {
    contextualQuestions.push(
      'At which step did you get stuck or confused?',
      'Who did you ask for help, and what did they say?',
      'Is there a documented process you were trying to follow?'
    );
  } else {
    // Generic deep-dive questions
    contextualQuestions.push(
      'Can you tell me more about what made this difficult?',
      'What would have made this experience better?',
      'Is there anything else that contributed to this problem?'
    );
  }

  // Add theme-based questions if we found specific keywords
  if (themes.has('documentation')) {
    contextualQuestions.push('What was missing from the documentation?');
  }
  if (themes.has('support')) {
    contextualQuestions.push('What kind of support would have helped?');
  }
  if (themes.has('training')) {
    contextualQuestions.push('Would training have prevented this issue?');
  }

  // Return first 3 unique questions
  return contextualQuestions.slice(0, 3);
}

/**
 * Extract key themes/keywords from session responses
 */
function extractResponseThemes(session: Session): Set<string> {
  const themes = new Set<string>();
  const keywords = ['documentation', 'support', 'training', 'help', 'unclear', 'slow', 'broken', 'access'];

  for (const round of session.rounds) {
    for (const q of round.questions) {
      if (q.response) {
        const resp = q.response.toLowerCase();
        for (const kw of keywords) {
          if (resp.includes(kw)) {
            themes.add(kw);
          }
        }
      }
    }
  }

  return themes;
}

function scoreResponse(response: string): WolframScore {
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
        if (/\b(couldn't find|couldn't access|no access|blocked|permission)\b/.test(resp)) signals.access_barrier += 0.3;
        if (/\b(confus|didn't understand|unclear|complex|hard to)\b/.test(resp)) signals.comprehension_gap += 0.3;
        if (/\b(slow|buggy|crashed|error|broken|doesn't work)\b/.test(resp)) signals.tool_friction += 0.3;
        if (/\b(no time|rushed|deadline|busy|later)\b/.test(resp)) signals.time_constraint += 0.3;
        if (/\b(didn't know|which step|what next|where to)\b/.test(resp)) signals.process_unclear += 0.3;
      }
    }
  }

  const total = Object.values(signals).reduce((a, b) => a + b, 0) || 1;
  const posteriors: Record<string, number> = {};
  for (const [key, value] of Object.entries(signals)) {
    posteriors[key] = Math.round((value / total) * 100) / 100;
  }

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

function extractEvidenceChain(session: Session): EvidenceSummary[] {
  const evidence: EvidenceSummary[] = [];
  for (const round of session.rounds) {
    for (const q of round.questions) {
      if (q.response) {
        evidence.push({
          questionId: q.questionId,
          questionText: q.questionText,
          response: q.response,
          timestamp: q.timestamp || new Date().toISOString(),
          contributionScore: q.wolframScore?.composite || 0.5,
          hypothesis: inferHypothesis(q.response),
        });
      }
    }
  }
  return evidence.sort((a, b) => b.contributionScore - a.contributionScore);
}

function inferHypothesis(response: string): string {
  const resp = response.toLowerCase();
  if (/\b(couldn't find|couldn't access|no access|blocked)\b/.test(resp)) return 'access_barrier';
  if (/\b(confus|didn't understand|unclear|complex)\b/.test(resp)) return 'comprehension_gap';
  if (/\b(slow|buggy|crashed|error|broken)\b/.test(resp)) return 'tool_friction';
  if (/\b(no time|rushed|deadline)\b/.test(resp)) return 'time_constraint';
  if (/\b(didn't know|which step|what next)\b/.test(resp)) return 'process_unclear';
  return 'unclassified';
}

function generateRecommendations(hypothesis: string): Recommendation[] {
  const patterns: Record<string, Recommendation[]> = {
    access_barrier: [
      { title: 'Improve access pathways', description: 'Review and simplify the path to key resources', category: 'product', priority: 'high' },
    ],
    comprehension_gap: [
      { title: 'Simplify documentation', description: 'Rewrite complex sections with clearer language', category: 'product', priority: 'high' },
    ],
    tool_friction: [
      { title: 'Fix reliability issues', description: 'Address reported bugs and performance problems', category: 'product', priority: 'high' },
    ],
    process_unclear: [
      { title: 'Document workflows', description: 'Create step-by-step guides for common tasks', category: 'process', priority: 'high' },
    ],
  };

  const recs = patterns[hypothesis] || [];
  recs.push({ title: 'Validate findings', description: `Confirm ${hypothesis} hypothesis with additional respondents`, category: 'validation', priority: 'medium' });
  return recs;
}

function generateEvidenceSummary(session: Session): string {
  const lines = [
    `Session: ${session.id}`,
    `Project: ${session.projectId}`,
    `Respondent: ${session.respondentDescription}`,
    `Rounds completed: ${session.currentRound}`,
    '',
    session.dominantHypothesis ? `Dominant hypothesis: ${session.dominantHypothesis} (${Math.round(session.dominantPosterior * 100)}%)` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function countResponses(session: Session): number {
  return session.rounds.reduce((count, round) => count + round.questions.filter((q) => q.response).length, 0);
}
