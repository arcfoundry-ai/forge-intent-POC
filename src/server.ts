/**
 * Forge Intent POC Server
 * - MCP Server (stdio) for Claude/agent integration
 * - HTTP API for portal frontend
 */

import express from 'express';
import cors from 'cors';
import { TOOL_DEFINITIONS } from './mcp/tools.js';
import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
} from './handlers/session-handlers.js';
import {
  getQuestions,
  submitResponse,
  runTurn,
  advanceRound,
} from './handlers/execution-handlers.js';
import {
  checkConvergence,
  generateReport,
  runGateC,
  analyzeProject,
} from './handlers/analysis-handlers.js';
import { handoff, terminate } from './handlers/lifecycle-handlers.js';
import { registerOpenClawRoutes } from './handlers/openclaw-callback-handler.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─────────────────────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'forge-intent-poc', version: '0.1.0' });
});

// ─────────────────────────────────────────────────────────────
// MCP Tool List (for discovery)
// ─────────────────────────────────────────────────────────────

app.get('/api/mcp/tools', (_req, res) => {
  res.json({ tools: TOOL_DEFINITIONS });
});

// ─────────────────────────────────────────────────────────────
// Session Management APIs
// ─────────────────────────────────────────────────────────────

app.post('/api/sessions', async (req, res) => {
  try {
    const result = await createSession(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/sessions/:sessionId', async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(session);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.delete('/api/sessions/:sessionId', async (req, res) => {
  try {
    const result = await deleteSession(req.params.sessionId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ─────────────────────────────────────────────────────────────
// Project APIs
// ─────────────────────────────────────────────────────────────

app.get('/api/projects/:projectId/sessions', async (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const sessions = await listSessions(req.params.projectId, status);
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/projects/:projectId/analyze', async (req, res) => {
  try {
    const analysis = await analyzeProject(req.params.projectId);
    res.json(analysis);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/projects/:projectId/gate-c', async (req, res) => {
  try {
    const minRespondents = req.body.minRespondents || 5;
    const result = await runGateC(req.params.projectId, minRespondents);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ─────────────────────────────────────────────────────────────
// Interview Execution APIs
// ─────────────────────────────────────────────────────────────

app.get('/api/sessions/:sessionId/questions', async (req, res) => {
  try {
    const result = await getQuestions(req.params.sessionId);
    if (!result) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/sessions/:sessionId/responses', async (req, res) => {
  try {
    const result = await submitResponse({
      sessionId: req.params.sessionId,
      questionId: req.body.questionId,
      response: req.body.response,
    });
    if (!result) {
      return res.status(404).json({ error: 'Session or question not found' });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/sessions/:sessionId/turn', async (req, res) => {
  try {
    const result = await runTurn({
      sessionId: req.params.sessionId,
      responses: req.body.responses,
    });
    if (!result) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/sessions/:sessionId/advance', async (req, res) => {
  try {
    const result = await advanceRound(req.params.sessionId);
    if (!result) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ─────────────────────────────────────────────────────────────
// Convergence & Analysis APIs
// ─────────────────────────────────────────────────────────────

app.get('/api/sessions/:sessionId/convergence', async (req, res) => {
  try {
    const result = await checkConvergence(req.params.sessionId);
    if (!result) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/sessions/:sessionId/report', async (req, res) => {
  try {
    const report = await generateReport(req.params.sessionId);
    if (!report) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ─────────────────────────────────────────────────────────────
// Lifecycle APIs
// ─────────────────────────────────────────────────────────────

app.post('/api/sessions/:sessionId/handoff', async (req, res) => {
  try {
    const result = await handoff({
      sessionId: req.params.sessionId,
      targetAgent: req.body.targetAgent,
      reason: req.body.reason,
    });
    if ('error' in result) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/sessions/:sessionId/terminate', async (req, res) => {
  try {
    const result = await terminate({
      sessionId: req.params.sessionId,
      reason: req.body.reason,
    });
    if ('error' in result) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ─────────────────────────────────────────────────────────────
// MCP Tool Execution (unified endpoint)
// ─────────────────────────────────────────────────────────────

app.post('/api/mcp/execute', async (req, res) => {
  const { tool, arguments: args } = req.body;

  try {
    let result: unknown;

    switch (tool) {
      // Session Management
      case 'interview_create_session':
        result = await createSession(args);
        break;
      case 'interview_get_session':
        result = await getSession(args.sessionId);
        break;
      case 'interview_list_sessions':
        result = await listSessions(args.projectId, args.status);
        break;
      case 'interview_delete_session':
        result = await deleteSession(args.sessionId);
        break;

      // Execution
      case 'interview_get_questions':
        result = await getQuestions(args.sessionId);
        break;
      case 'interview_submit_response':
        result = await submitResponse(args);
        break;
      case 'interview_run_turn':
        result = await runTurn(args);
        break;
      case 'interview_advance_round':
        result = await advanceRound(args.sessionId);
        break;

      // Analysis
      case 'interview_check_convergence':
        result = await checkConvergence(args.sessionId);
        break;
      case 'interview_generate_report':
        result = await generateReport(args.sessionId);
        break;
      case 'interview_run_gate_c':
        result = await runGateC(args.projectId, args.minRespondents);
        break;
      case 'interview_analyze_project':
        result = await analyzeProject(args.projectId);
        break;

      // Lifecycle
      case 'interview_handoff':
        result = await handoff(args);
        break;
      case 'interview_terminate':
        result = await terminate(args);
        break;

      default:
        return res.status(400).json({ error: `Unknown tool: ${tool}` });
    }

    res.json({ result });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ─────────────────────────────────────────────────────────────
// OpenClaw Callback Routes
// ─────────────────────────────────────────────────────────────

registerOpenClawRoutes(app);

// ─────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Forge Intent POC Server running on http://localhost:${PORT}`);
  console.log(`API endpoints available at http://localhost:${PORT}/api`);
  console.log(`MCP tools available at http://localhost:${PORT}/api/mcp/tools`);
});

export { app };
