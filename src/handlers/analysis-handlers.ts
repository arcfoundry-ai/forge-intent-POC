/**
 * Convergence & Analysis Handlers (4 tools)
 * - interview_check_convergence
 * - interview_generate_report
 * - interview_run_gate_c
 * - interview_analyze_project
 */

import { s3Client } from '../storage/s3-client.js';
import { getSession, listSessions } from './session-handlers.js';
import type {
  Session,
  ConvergenceReport,
  EvidenceSummary,
  Recommendation,
  GateCResult,
  MultiRespondentAnalysis,
  HypothesisRanking,
  ConsensusFinding,
  DivergenceFinding,
  ThemeCluster,
} from '../types.js';

/**
 * Check if a session has reached convergence
 */
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

/**
 * Generate a convergence report for a session
 */
export async function generateReport(
  sessionId: string
): Promise<ConvergenceReport | null> {
  const session = await getSession(sessionId);
  if (!session) return null;

  const evidenceChain = extractEvidenceChain(session);
  const recommendations = generateRecommendations(
    session.dominantHypothesis || 'unknown',
    evidenceChain
  );

  const report: ConvergenceReport = {
    sessionId: session.id,
    projectId: session.projectId,
    rootCause: session.dominantHypothesis || 'Unknown',
    hypothesis: session.dominantHypothesis || 'unclassified',
    confidence: session.dominantPosterior,
    severity: inferSeverity(session),
    isStructural: inferStructural(session),
    evidenceChain,
    recommendations,
    totalResponses: countResponses(session),
    generatedAt: new Date().toISOString(),
  };

  // Save report to S3
  await s3Client.saveReport(report);

  return report;
}

/**
 * Run Gate C (multi-respondent certification)
 */
export async function runGateC(
  projectId: string,
  minRespondents: number = 5
): Promise<GateCResult> {
  const summaries = await listSessions(projectId);

  // Load full sessions for converged ones
  const sessions: Session[] = [];
  for (const summary of summaries) {
    const session = await s3Client.getSession(projectId, summary.sessionId);
    if (session) sessions.push(session);
  }

  const totalRespondents = sessions.length;
  const convergedSessions = sessions.filter(
    (s) => s.state === 'CONVERGENCE_REACHED'
  );
  const convergedRatio = totalRespondents > 0
    ? convergedSessions.length / totalRespondents
    : 0;

  // Count hypothesis agreement
  const hypothesisCounts: Record<string, number> = {};
  for (const s of convergedSessions) {
    if (s.dominantHypothesis) {
      hypothesisCounts[s.dominantHypothesis] =
        (hypothesisCounts[s.dominantHypothesis] || 0) + 1;
    }
  }

  // Find consensus hypothesis
  let consensusHypothesis: string | null = null;
  let maxCount = 0;
  for (const [hyp, count] of Object.entries(hypothesisCounts)) {
    if (count > maxCount) {
      maxCount = count;
      consensusHypothesis = hyp;
    }
  }

  const agreementRatio = totalRespondents > 0
    ? maxCount / totalRespondents
    : 0;

  const checks = {
    minRespondents: {
      required: minRespondents,
      actual: totalRespondents,
      passed: totalRespondents >= minRespondents,
    },
    majorityConverged: {
      required: 0.6,
      actual: convergedRatio,
      passed: convergedRatio >= 0.6,
    },
    rootCauseAgreement: {
      required: 0.5,
      actual: agreementRatio,
      passed: agreementRatio >= 0.5,
    },
  };

  const passed = checks.minRespondents.passed &&
    checks.majorityConverged.passed &&
    checks.rootCauseAgreement.passed;

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

  return {
    gate: 'C',
    passed,
    checks,
    consensusHypothesis,
    recommendation,
  };
}

/**
 * Run full multi-respondent analysis
 */
export async function analyzeProject(
  projectId: string
): Promise<MultiRespondentAnalysis> {
  const summaries = await listSessions(projectId);

  // Load full sessions
  const sessions: Session[] = [];
  for (const summary of summaries) {
    const session = await s3Client.getSession(projectId, summary.sessionId);
    if (session) sessions.push(session);
  }

  const hypothesisRankings = comparePosteriorsAcrossSessions(sessions);
  const consensusFindings = detectConsensus(sessions);
  const divergenceFindings = detectDivergence(sessions);
  const themeClusters = clusterThemes(sessions);
  const gateC = await runGateC(projectId);

  return {
    projectId,
    totalSessions: sessions.length,
    convergedSessions: sessions.filter((s) => s.state === 'CONVERGENCE_REACHED').length,
    hypothesisRankings,
    consensusFindings,
    divergenceFindings,
    themeClusters,
    gateC,
    generatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Internal Analysis Functions
// ─────────────────────────────────────────────────────────────

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
          hypothesis: inferHypothesisFromResponse(q.response),
        });
      }
    }
  }

  // Sort by contribution score
  return evidence.sort((a, b) => b.contributionScore - a.contributionScore);
}

function generateRecommendations(
  hypothesis: string,
  evidence: EvidenceSummary[]
): Recommendation[] {
  const recommendations: Recommendation[] = [];

  const patterns: Record<string, Recommendation[]> = {
    access_barrier: [
      {
        title: 'Improve access pathways',
        description: 'Review and simplify the path to key resources',
        category: 'product',
        priority: 'high',
      },
      {
        title: 'Add discoverability features',
        description: 'Implement search, navigation aids, or shortcuts',
        category: 'product',
        priority: 'medium',
      },
    ],
    comprehension_gap: [
      {
        title: 'Simplify documentation',
        description: 'Rewrite complex sections with clearer language',
        category: 'product',
        priority: 'high',
      },
      {
        title: 'Add inline help',
        description: 'Provide contextual tooltips and examples',
        category: 'product',
        priority: 'medium',
      },
    ],
    tool_friction: [
      {
        title: 'Fix reliability issues',
        description: 'Address reported bugs and performance problems',
        category: 'product',
        priority: 'high',
      },
      {
        title: 'Improve error handling',
        description: 'Make error messages actionable and clear',
        category: 'product',
        priority: 'medium',
      },
    ],
    process_unclear: [
      {
        title: 'Document workflows',
        description: 'Create step-by-step guides for common tasks',
        category: 'process',
        priority: 'high',
      },
    ],
    time_constraint: [
      {
        title: 'Streamline critical paths',
        description: 'Reduce steps required for common workflows',
        category: 'process',
        priority: 'medium',
      },
    ],
  };

  recommendations.push(...(patterns[hypothesis] || []));

  // Always add validation
  recommendations.push({
    title: 'Validate findings',
    description: `Confirm ${hypothesis} hypothesis with additional respondents`,
    category: 'validation',
    priority: 'medium',
  });

  return recommendations;
}

function comparePosteriorsAcrossSessions(sessions: Session[]): HypothesisRanking[] {
  const hypothesisData: Record<string, { total: number; count: number; sessions: string[] }> = {};

  for (const session of sessions) {
    for (const [hyp, posterior] of Object.entries(session.posteriors)) {
      if (!hypothesisData[hyp]) {
        hypothesisData[hyp] = { total: 0, count: 0, sessions: [] };
      }
      hypothesisData[hyp].total += posterior;
      hypothesisData[hyp].count++;
      hypothesisData[hyp].sessions.push(session.id);
    }
  }

  const rankings: HypothesisRanking[] = Object.entries(hypothesisData).map(
    ([hypothesis, data]) => ({
      hypothesis,
      weightedPosterior: data.count > 0 ? data.total / data.count : 0,
      sessionCount: data.count,
      sessions: data.sessions,
    })
  );

  return rankings.sort((a, b) => b.weightedPosterior - a.weightedPosterior);
}

function detectConsensus(sessions: Session[], threshold = 0.6): ConsensusFinding[] {
  const hypothesisCounts: Record<string, string[]> = {};

  for (const session of sessions) {
    if (session.dominantHypothesis && session.dominantPosterior >= 0.7) {
      if (!hypothesisCounts[session.dominantHypothesis]) {
        hypothesisCounts[session.dominantHypothesis] = [];
      }
      hypothesisCounts[session.dominantHypothesis].push(session.id);
    }
  }

  const findings: ConsensusFinding[] = [];
  const total = sessions.length;

  for (const [hypothesis, sessionIds] of Object.entries(hypothesisCounts)) {
    const ratio = total > 0 ? sessionIds.length / total : 0;
    if (ratio >= threshold) {
      findings.push({
        hypothesis,
        agreementRatio: ratio,
        sessionIds,
        confidence: ratio,
      });
    }
  }

  return findings.sort((a, b) => b.agreementRatio - a.agreementRatio);
}

function detectDivergence(sessions: Session[]): DivergenceFinding[] {
  const groups: Record<string, string[]> = {};

  for (const session of sessions) {
    if (session.dominantHypothesis && session.dominantPosterior >= 0.6) {
      if (!groups[session.dominantHypothesis]) {
        groups[session.dominantHypothesis] = [];
      }
      groups[session.dominantHypothesis].push(session.id);
    }
  }

  const hypotheses = Object.keys(groups);
  const findings: DivergenceFinding[] = [];
  const total = sessions.length;

  for (let i = 0; i < hypotheses.length; i++) {
    for (let j = i + 1; j < hypotheses.length; j++) {
      const hypA = hypotheses[i];
      const hypB = hypotheses[j];
      const supportA = total > 0 ? groups[hypA].length / total : 0;
      const supportB = total > 0 ? groups[hypB].length / total : 0;

      // Both groups have significant support (>20%)
      if (supportA >= 0.2 && supportB >= 0.2) {
        findings.push({
          groupA: { hypothesis: hypA, sessions: groups[hypA], support: supportA },
          groupB: { hypothesis: hypB, sessions: groups[hypB], support: supportB },
          divergenceScore: Math.min(supportA, supportB) / Math.max(supportA, supportB),
        });
      }
    }
  }

  return findings.sort((a, b) => b.divergenceScore - a.divergenceScore);
}

function clusterThemes(sessions: Session[]): ThemeCluster[] {
  const keywordCounts: Record<string, { count: number; sessions: Set<string> }> = {};

  const keywords = [
    'documentation', 'access', 'permission', 'confusing', 'slow', 'error',
    'workflow', 'process', 'training', 'onboarding', 'support', 'help',
  ];

  for (const session of sessions) {
    for (const round of session.rounds) {
      for (const q of round.questions) {
        if (q.response) {
          const resp = q.response.toLowerCase();
          for (const kw of keywords) {
            if (resp.includes(kw)) {
              if (!keywordCounts[kw]) {
                keywordCounts[kw] = { count: 0, sessions: new Set() };
              }
              keywordCounts[kw].count++;
              keywordCounts[kw].sessions.add(session.id);
            }
          }
        }
      }
    }
  }

  const clusters: ThemeCluster[] = Object.entries(keywordCounts)
    .filter(([, data]) => data.sessions.size >= 2)
    .map(([theme, data]) => ({
      theme,
      keywords: [theme],
      sessionIds: Array.from(data.sessions),
      frequency: data.count,
    }));

  return clusters.sort((a, b) => b.frequency - a.frequency);
}

function inferHypothesisFromResponse(response: string): string {
  const resp = response.toLowerCase();

  if (/\b(couldn't find|couldn't access|no access|blocked)\b/.test(resp)) {
    return 'access_barrier';
  }
  if (/\b(confus|didn't understand|unclear|complex)\b/.test(resp)) {
    return 'comprehension_gap';
  }
  if (/\b(slow|buggy|crashed|error|broken)\b/.test(resp)) {
    return 'tool_friction';
  }
  if (/\b(no time|rushed|deadline)\b/.test(resp)) {
    return 'time_constraint';
  }
  if (/\b(didn't know|which step|what next)\b/.test(resp)) {
    return 'process_unclear';
  }

  return 'unclassified';
}

function inferSeverity(session: Session): string | null {
  if (session.dominantPosterior >= 0.9) return 'critical';
  if (session.dominantPosterior >= 0.8) return 'high';
  if (session.dominantPosterior >= 0.7) return 'medium';
  return 'low';
}

function inferStructural(session: Session): boolean | null {
  // Structural issues are those affecting the system design, not individual usage
  const structuralHypotheses = ['access_barrier', 'tool_friction', 'process_unclear'];
  return session.dominantHypothesis
    ? structuralHypotheses.includes(session.dominantHypothesis)
    : null;
}

function countResponses(session: Session): number {
  let count = 0;
  for (const round of session.rounds) {
    for (const q of round.questions) {
      if (q.response) count++;
    }
  }
  return count;
}
