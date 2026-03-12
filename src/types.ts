/**
 * Forge Intent MCP Integration Types
 */

// Session States
export type SessionState =
  | 'INITIALIZED'
  | 'EXECUTING'
  | 'WAITING_FOR_INPUT'
  | 'CONVERGENCE_REACHED'
  | 'TERMINATED';

// Handoff Targets (Allowlist - Option A)
export const HANDOFF_TARGETS = [
  'forge-builder',
  'forge-platform',
  'forge-phoenix',
  'human-review',
] as const;

export type HandoffTarget = typeof HANDOFF_TARGETS[number];

// Core Session Types
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
  wolframAssessment: WolframScore | null;
}

export interface Question {
  questionId: string;
  questionText: string;
  response?: string;
  timestamp?: string;
  wolframScore?: WolframScore | null;
}

export interface WolframScore {
  quality: number;
  relevance: number;
  specificity: number;
  composite: number;
}

// Session Summary (for listings)
export interface SessionSummary {
  sessionId: string;
  projectId: string;
  state: SessionState;
  currentRound: number;
  dominantHypothesis: string | null;
  dominantPosterior: number;
  lastActivity: string;
}

// Bayesian Result
export interface BayesianResult {
  posteriors: Record<string, number>;
  dominantHypothesis: string;
  dominantPosterior: number;
  convergenceReached: boolean;
  recommendation: string;
}

// Convergence Report
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

// Gate C Result
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

// Multi-Respondent Analysis
export interface MultiRespondentAnalysis {
  projectId: string;
  totalSessions: number;
  convergedSessions: number;
  hypothesisRankings: HypothesisRanking[];
  consensusFindings: ConsensusFinding[];
  divergenceFindings: DivergenceFinding[];
  themeClusters: ThemeCluster[];
  gateC: GateCResult;
  generatedAt: string;
}

export interface HypothesisRanking {
  hypothesis: string;
  weightedPosterior: number;
  sessionCount: number;
  sessions: string[];
}

export interface ConsensusFinding {
  hypothesis: string;
  agreementRatio: number;
  sessionIds: string[];
  confidence: number;
}

export interface DivergenceFinding {
  groupA: { hypothesis: string; sessions: string[]; support: number };
  groupB: { hypothesis: string; sessions: string[]; support: number };
  divergenceScore: number;
}

export interface ThemeCluster {
  theme: string;
  keywords: string[];
  sessionIds: string[];
  frequency: number;
}

// Handoff Payload
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

// S3 Storage Types
export interface ActiveSessionsIndex {
  version: number;
  lastUpdated: string;
  activeSessions: SessionSummary[];
}

export interface ProjectManifest {
  projectId: string;
  totalSessions: number;
  convergedSessions: number;
  dominantHypotheses: Record<string, number>;
  sessions: SessionSummary[];
  lastUpdated: string;
}

// MCP Tool Input/Output Types
export interface CreateSessionInput {
  projectId: string;
  respondentDescription: string;
  domainActivity: string;
}

export interface SubmitResponseInput {
  sessionId: string;
  questionId: string;
  response: string;
}

export interface RunTurnInput {
  sessionId: string;
  responses: Array<{ questionId: string; response: string }>;
}

export interface HandoffInput {
  sessionId: string;
  targetAgent: HandoffTarget;
  reason?: 'convergence' | 'escalation' | 'timeout';
}

export interface TerminateInput {
  sessionId: string;
  reason: string;
}
