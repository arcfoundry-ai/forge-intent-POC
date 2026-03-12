/**
 * MCP Tool Definitions for Forge Intent
 * 14 tools across 4 categories
 */

export const TOOL_DEFINITIONS = [
  // ─────────────────────────────────────────────────────────────
  // Session Management (4 tools)
  // ─────────────────────────────────────────────────────────────
  {
    name: 'interview_create_session',
    description: 'Create a new interview session for a respondent',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project identifier' },
        respondentDescription: { type: 'string', description: 'Description of the respondent' },
        domainActivity: { type: 'string', description: 'The domain activity being investigated' },
      },
      required: ['projectId', 'respondentDescription', 'domainActivity'],
    },
  },
  {
    name: 'interview_get_session',
    description: 'Retrieve the full state of an interview session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to retrieve' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'interview_list_sessions',
    description: 'List all sessions for a project, optionally filtered by status',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project identifier' },
        status: {
          type: 'string',
          enum: ['INITIALIZED', 'EXECUTING', 'WAITING_FOR_INPUT', 'CONVERGENCE_REACHED', 'TERMINATED'],
          description: 'Filter by session state',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'interview_delete_session',
    description: 'Delete an interview session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to delete' },
      },
      required: ['sessionId'],
    },
  },

  // ─────────────────────────────────────────────────────────────
  // Interview Execution (4 tools)
  // ─────────────────────────────────────────────────────────────
  {
    name: 'interview_get_questions',
    description: 'Get the current round of questions for a session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'interview_submit_response',
    description: 'Submit a single response to a question',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        questionId: { type: 'string', description: 'Question ID' },
        response: { type: 'string', description: 'The respondent\'s answer' },
      },
      required: ['sessionId', 'questionId', 'response'],
    },
  },
  {
    name: 'interview_run_turn',
    description: 'Execute a full turn: submit multiple responses and run Bayesian update',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        responses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              questionId: { type: 'string' },
              response: { type: 'string' },
            },
            required: ['questionId', 'response'],
          },
          description: 'Array of question-response pairs',
        },
      },
      required: ['sessionId', 'responses'],
    },
  },
  {
    name: 'interview_advance_round',
    description: 'Force advance to the next round of questions',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['sessionId'],
    },
  },

  // ─────────────────────────────────────────────────────────────
  // Convergence & Analysis (4 tools)
  // ─────────────────────────────────────────────────────────────
  {
    name: 'interview_check_convergence',
    description: 'Check if a session has reached Bayesian convergence',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'interview_generate_report',
    description: 'Generate a convergence report with evidence chain and recommendations',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'interview_run_gate_c',
    description: 'Run Gate C multi-respondent certification for a project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project identifier' },
        minRespondents: {
          type: 'number',
          description: 'Minimum respondents required (default: 5)',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'interview_analyze_project',
    description: 'Run full multi-respondent analysis with consensus/divergence detection',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project identifier' },
      },
      required: ['projectId'],
    },
  },

  // ─────────────────────────────────────────────────────────────
  // Lifecycle & Handoff (2 tools)
  // ─────────────────────────────────────────────────────────────
  {
    name: 'interview_handoff',
    description: 'Prepare session for agent handoff to another ArcFoundry agent',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        targetAgent: {
          type: 'string',
          enum: ['forge-builder', 'forge-platform', 'forge-phoenix', 'human-review'],
          description: 'Target agent for handoff',
        },
        reason: {
          type: 'string',
          enum: ['convergence', 'escalation', 'timeout'],
          description: 'Reason for handoff',
        },
      },
      required: ['sessionId', 'targetAgent'],
    },
  },
  {
    name: 'interview_terminate',
    description: 'Terminate and archive a session to cold storage',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        reason: { type: 'string', description: 'Reason for termination' },
      },
      required: ['sessionId', 'reason'],
    },
  },
] as const;

export type ToolName = typeof TOOL_DEFINITIONS[number]['name'];
