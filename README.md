# Forge Intent Engine — CDM Interview System

> AI-powered root cause discovery using Critical Decision Method (CDM) interviews with multi-channel communication via OpenClaw Gateway.

## Overview

The Forge Intent Engine conducts structured interviews to identify root causes of user friction. It uses a **Bayesian probability model** to iteratively narrow down hypotheses based on respondent feedback, converging on the most likely root cause with quantifiable confidence.

### Key Capabilities

| Capability | Description |
|------------|-------------|
| **Multi-Channel Interviews** | Email, SMS, Slack, WhatsApp — interviewee chooses preferred channel |
| **Adaptive Questioning** | Level 1 questions are standard; Level 2+ are custom per interviewee |
| **Autonomous Session Management** | Configurable timeouts, automated reminders, escalation handling |
| **Parallel Interviews** | 50+ interviews per day, 5 rounds each via single OpenClaw Gateway |
| **Root Cause Convergence** | Bayesian analysis identifies when interviews have converged |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FORGE INTENT SYSTEM                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────┐ │
│  │   Employee UI   │    │  Forge Intent   │    │   Context MCP Server    │ │
│  │   (Web App)     │───▶│   Orchestrator  │◀──▶│  context.arcfoundry.ai  │ │
│  │                 │    │                 │    │                         │ │
│  │  - Enter info   │    │  - Question gen │    │  - CDM methodology      │ │
│  │  - Start intv   │    │  - Grammar fix  │    │  - Analysis patterns    │ │
│  │  - View status  │    │  - Level mgmt   │    │  - Domain knowledge     │ │
│  └─────────────────┘    │  - DynamoDB     │    └─────────────────────────┘ │
│                         └────────┬────────┘                                 │
│                                  │                                          │
│                                  │ HTTP webhooks                            │
│                                  ▼                                          │
│                    ┌─────────────────────────────┐                         │
│                    │    OpenClaw Gateway         │                         │
│                    │    (Multi-Agent Router)     │                         │
│                    │                             │                         │
│                    │  ┌───────────────────────┐ │                         │
│                    │  │    Cron Scheduler     │ │                         │
│                    │  │  - Reminders          │ │                         │
│                    │  │  - Timeouts           │ │                         │
│                    │  │  - Escalations        │ │                         │
│                    │  └───────────────────────┘ │                         │
│                    │                             │                         │
│                    │  ┌───────────────────────┐ │                         │
│                    │  │  Channel Adapters     │ │                         │
│                    │  │  Email│SMS│Slack│WA   │ │                         │
│                    │  └───────────────────────┘ │                         │
│                    └──────────────┬──────────────┘                         │
│                                   │                                         │
└───────────────────────────────────┼─────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │       INTERVIEWEES            │
                    │  (Email, SMS, Slack, WhatsApp)│
                    └───────────────────────────────┘
```

### Data Storage

| Store | Purpose | Contents |
|-------|---------|----------|
| **DynamoDB** | Session state | Interview progress, interviewee info, OpenClaw session IDs |
| **S3** | Interview data | Questions, responses (raw + corrected), audit logs |
| **Context MCP** | Methodology | CDM rules, analysis patterns, domain knowledge |

---

## MCP Tools (14 Total)

The engine exposes 14 MCP tools for integration with Claude and other AI agents:

| Category | Tool | Description |
|----------|------|-------------|
| **Session** | `interview_create_session` | Create a new interview session |
| | `interview_get_session` | Get session details and state |
| | `interview_list_sessions` | List sessions for a project |
| | `interview_delete_session` | Delete a session |
| **Execution** | `interview_get_questions` | Get current round questions |
| | `interview_submit_response` | Submit a single response |
| | `interview_run_turn` | Submit responses and run Bayesian update |
| | `interview_advance_round` | Move to next round of questions |
| **Analysis** | `interview_check_convergence` | Check if 85% confidence reached |
| | `interview_generate_report` | Generate recommendations report |
| | `interview_run_gate_c` | Multi-respondent certification gate |
| | `interview_analyze_project` | Cross-session synthesis |
| **Lifecycle** | `interview_handoff` | Hand off to another agent |
| | `interview_terminate` | Terminate session |

---

## DynamoDB Schema

### Table: `forge-intent-sessions`

**Primary Key:** `PK` (HASH) + `SK` (RANGE)

**Global Secondary Indexes:**
- `OpenClawSessionIndex` — Lookup by OpenClaw session ID
- `IntervieweeIndex` — Lookup by interviewee ID

### Interview Record (PK: `INTERVIEW#{interviewId}`, SK: `MANIFEST`)

```typescript
{
  interviewId: string;
  projectId: string;
  problemStatement: string;
  status: 'draft' | 'active' | 'converged' | 'cancelled';
  totalInterviewees: number;
  activeInterviewees: number;
  completedInterviewees: number;
  convergenceScore: number;
  rootCauseIdentified: boolean;
  config: {
    timeoutHours: number;
    reminderSchedule: number[];
    maxLevels: number;
    convergenceThreshold: number;
  };
  createdAt: string;
  createdBy: string;
}
```

### Session Record (PK: `INTERVIEW#{interviewId}`, SK: `SESSION#{intervieweeId}`)

```typescript
{
  interviewId: string;
  intervieweeId: string;
  openclawSessionId: string | null;  // GSI1 key
  openclawAgentId: string | null;
  interviewee: {
    name: string;
    email?: string;
    phone?: string;
    slackUserId?: string;
    preferredChannel: 'email' | 'sms' | 'whatsapp' | 'slack';
    timezone: string;
  };
  status: 'pending' | 'active' | 'processing' | 'completed' | 'timed_out' | 'cancelled';
  currentLevel: number;
  levelsCompleted: number[];
  totalResponsesReceived: number;
  convergenceScore: number;
  createdAt: string;
  startedAt: string | null;
  lastActivityAt: string;
  completedAt: string | null;
}
```

---

## OpenClaw Integration

### Webhook Contracts

**Forge Intent → OpenClaw**

| Endpoint | Purpose |
|----------|---------|
| `POST /hooks/interview-start` | Start new interview session |
| `POST /hooks/interview-continue` | Send next level questions |
| `POST /hooks/interview-complete` | Mark interview complete |
| `POST /hooks/interview-cancel` | Cancel interview |

**OpenClaw → Forge Intent**

| Callback Type | Purpose |
|---------------|---------|
| `response` | Interviewee responded to questions |
| `partial_response` | Some questions answered |
| `timeout` | Session timed out |
| `escalation` | Reminders exhausted |
| `error` | Delivery or processing error |

### Callback Endpoint

```
POST /api/openclaw/callback
Authorization: X-OpenClaw-Signature: sha256=...
Content-Type: application/json

{
  "type": "response",
  "sessionId": "oc_sess_abc123",
  "interviewId": "int_xyz789",
  "intervieweeId": "user_def456",
  "level": 1,
  "responses": [
    { "questionId": "q1", "answer": "..." }
  ],
  "sessionState": {
    "remindersSent": 1,
    "totalResponseTime": 3600
  }
}
```

---

## API Endpoints

### Base URL

- **Local**: `http://localhost:3001/api`
- **Production**: `https://forge-intent.arcfoundry.ai/api`

### Session Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sessions` | Create new session |
| `GET` | `/sessions/:sessionId` | Get session |
| `DELETE` | `/sessions/:sessionId` | Delete session |
| `GET` | `/projects/:projectId/sessions` | List sessions for project |

### Interview Execution

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/sessions/:sessionId/questions` | Get current questions |
| `POST` | `/sessions/:sessionId/responses` | Submit single response |
| `POST` | `/sessions/:sessionId/turn` | Submit all responses + Bayesian update |
| `POST` | `/sessions/:sessionId/advance` | Advance to next round |

### Analysis

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/sessions/:sessionId/convergence` | Check convergence status |
| `POST` | `/sessions/:sessionId/report` | Generate report |
| `POST` | `/projects/:projectId/analyze` | Cross-session analysis |
| `POST` | `/projects/:projectId/gate-c` | Run Gate C certification |

### Lifecycle

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sessions/:sessionId/handoff` | Hand off to target agent |
| `POST` | `/sessions/:sessionId/terminate` | Terminate session |

### MCP

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/mcp/tools` | List available MCP tools |
| `POST` | `/mcp/execute` | Execute MCP tool |

### OpenClaw Callbacks

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/openclaw/callback` | Receive callbacks from OpenClaw |

---

## File Structure

```
forge-intent-POC/
├── public/
│   └── index.html           # Frontend portal
├── src/
│   ├── server.ts            # Express HTTP API + OpenClaw routes
│   ├── index.ts             # MCP server entry
│   ├── types.ts             # TypeScript interfaces
│   ├── handlers/
│   │   ├── session-handlers.ts
│   │   ├── execution-handlers.ts
│   │   ├── analysis-handlers.ts
│   │   ├── lifecycle-handlers.ts
│   │   └── openclaw-callback-handler.ts   # Webhook callback processing
│   ├── services/
│   │   └── openclaw-client.ts             # OpenClaw API client
│   ├── mcp/
│   │   └── tools.ts         # MCP tool definitions (14 tools)
│   ├── mcp-integration/
│   │   └── interview-gateway.ts           # Context MCP integration
│   └── storage/
│       ├── dynamodb-client.ts             # DynamoDB operations
│       ├── dynamodb-types.ts              # DynamoDB type definitions
│       └── s3-client.ts                   # S3 operations
├── config/
│   └── openclaw.json        # OpenClaw gateway configuration
├── docs/
│   ├── FORGE-INTENT-ARCHITECTURE-SUMMARY.md
│   ├── FORGE-INTENT-SYSTEM-SPEC.md
│   ├── OPENCLAW-WEBHOOK-CONTRACTS.md
│   ├── S3-INTERVIEW-DATA-STRUCTURE.md
│   └── CONTEXT-MCP-INTEGRATION-SPEC.md
├── package.json
├── tsconfig.json
└── README.md
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3001` |
| `AWS_REGION` | AWS region | `us-west-2` |
| `DYNAMODB_TABLE` | DynamoDB table name | `forge-intent-sessions` |
| `S3_BUCKET` | S3 bucket for interview data | — |
| `OPENCLAW_BASE_URL` | OpenClaw Gateway URL | `http://localhost:3100/openclaw` |
| `FORGE_INTENT_WEBHOOK_SECRET` | Webhook signing secret | `dev-secret` |
| `FORGE_INTENT_URL` | Callback URL for OpenClaw | `http://localhost:3001` |

---

## Local Development

### Prerequisites

- Node.js 18+
- AWS credentials configured (for DynamoDB/S3)
- OpenClaw Gateway running (optional, for multi-channel)

### Setup

```bash
git clone https://github.com/arcfoundry-ai/forge-intent-POC.git
cd forge-intent-POC
npm install
```

### Run Development Server

```bash
npm run dev
```

Server starts at http://localhost:3001

### Run Tests

```bash
npm test
```

### Build

```bash
npm run build
```

---

## Session State Machine

```
pending ──▶ active ──▶ processing ──▶ completed
              │            │
              │            ▼
              │       [next level] ──▶ active
              │
              ├──▶ timed_out
              ├──▶ cancelled
              └──▶ error
```

| State | Description |
|-------|-------------|
| `pending` | Interviewee added, session not started |
| `active` | Questions sent, awaiting response |
| `processing` | Response received, running analysis |
| `completed` | Interview finished (convergence or max levels) |
| `timed_out` | No response within timeout window |
| `cancelled` | Manually cancelled |
| `error` | Unrecoverable error |

---

## Handoff Targets

When converging on a root cause, sessions can be handed off to specialized agents:

| Target | Purpose |
|--------|---------|
| `forge-builder` | Code/implementation changes |
| `forge-platform` | Infrastructure/deployment changes |
| `forge-phoenix` | Design/UX changes |
| `human-review` | Requires human decision |

---

## Documentation

See the `docs/` directory for detailed specifications:

- **FORGE-INTENT-ARCHITECTURE-SUMMARY.md** — Complete system architecture (5 pages)
- **FORGE-INTENT-SYSTEM-SPEC.md** — Detailed system specification
- **OPENCLAW-WEBHOOK-CONTRACTS.md** — Webhook API contracts
- **S3-INTERVIEW-DATA-STRUCTURE.md** — S3 storage structure
- **CONTEXT-MCP-INTEGRATION-SPEC.md** — Context MCP integration

---

## License

MIT License - ArcFoundry 2026
