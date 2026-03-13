# Forge Intent System Specification

**Version:** 1.0
**Date:** 2026-03-13
**Status:** Architecture Complete — Ready for Implementation

---

## 1. Executive Summary

Forge Intent is an AI-powered interview system that conducts structured CDM (Critical Decision Method) interviews to identify root causes of user friction. The system uses OpenClaw for multi-channel communication with interviewees and outputs interview summaries to FigJam.

### Key Principles

1. **Context MCP is the brain** — All methodology, patterns, and rules live in Context MCP, version-controlled in GitHub
2. **Forge Intent is the executor** — Stateless orchestration engine, no embedded intelligence
3. **Interview DATA ≠ Context** — Q&A responses are data, stored separately, must not bias methodology
4. **MCP protocol compliance** — Context MCP operates as a standard MCP server (tools, not REST)

---

## 2. System Architecture (Final)

```
┌─────────────────────────────────────────────────────────────────┐
│                  Forge Intent Server (ECS)                       │
│                                                                  │
│  ┌──────────────────┐       ┌──────────────────────────────┐   │
│  │  Forge Intent    │◄─────►│  OpenClaw Gateway (1 process) │   │
│  │  Orchestrator    │ HTTP  │                              │   │
│  │                  │       │  ┌────────────────────────┐  │   │
│  │  - Question gen  │       │  │ Cron Scheduler         │  │   │
│  │  - Grammar fix   │       │  │ (all interviewee jobs) │  │   │
│  │  - S3 storage    │       │  └────────────────────────┘  │   │
│  │  - Level mgmt    │       │                              │   │
│  └──────────────────┘       │  ┌────────────────────────┐  │   │
│          │                  │  │ Multi-Agent Router     │  │   │
│          ▼                  │  │ ├─ interviewee-001     │  │   │
│  ┌──────────────────┐       │  │ ├─ interviewee-002     │  │   │
│  │  Context MCP     │       │  │ └─ interviewee-NNN     │  │   │
│  │  (DynamoDB)      │       │  └────────────────────────┘  │   │
│  └──────────────────┘       └──────────────────────────────┘   │
│          │                              │                       │
│          ▼                              ▼                       │
│  ┌──────────────────┐       ┌──────────────────────────────┐   │
│  │ S3: arcfoundry-  │       │ Channels:                    │   │
│  │ context          │       │ Email, SMS, WhatsApp, Slack  │   │
│  │ (methodology)    │       └──────────────────────────────┘   │
│  └──────────────────┘                                          │
│          │                                                      │
│  ┌──────────────────┐                                          │
│  │ S3: arcfoundry-  │                                          │
│  │ interview-data   │                                          │
│  │ (Q&A responses)  │                                          │
│  └──────────────────┘                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. System Components

### 3.1 Context MCP Server (context.arcfoundry.ai)

**Role:** The knowledge repository — all intelligence for conducting interviews

**Contains:**
- CDM methodology (4 phases)
- Question generation patterns
- Bayesian analysis rules
- Root cause detection criteria
- Domain knowledge (hot/warm/cold tiers)

**Interface:** Standard MCP protocol (tools)
- `forge_get_context` — Fetch methodology/patterns
- `forge_search_context` — Semantic search for relevant knowledge
- `forge_list_domains` — List available domains

**Storage:** S3 (`arcfoundry-context` bucket) + GitHub version control

### 3.2 Forge Intent POC Server

**Role:** Execution engine — orchestrates interviews, stores DATA

**Responsibilities:**
- Web UI for employee to enter interviewee info + problem statement
- Fetch methodology from Context MCP
- Generate interview questions (calls Claude API with methodology context)
- Grammar correction of responses
- Interface with OpenClaw via webhooks
- Store interview DATA in S3 (`arcfoundry-interview-data`)
- Analyze responses and manage level progression
- Push results to FigJam

**Storage:** S3 (`arcfoundry-interview-data` bucket)

### 3.3 OpenClaw Gateway

**Role:** Communication layer — conducts actual interviews with humans

**Deployment:** Single Gateway process co-located on Forge Intent ECS task

**Architecture:**
- **Multi-agent routing:** 1 agent per interviewee (dynamic creation)
- **Cron scheduler:** Per-interviewee jobs (reminders, timeouts, escalation)
- **Channels:** Email (SMTP), SMS (Twilio), WhatsApp (Twilio), Slack

**Responsibilities:**
- Receive interview commands from Forge Intent via webhooks
- Contact interviewees via their preferred channel
- Manage session lifecycle (reminders at configurable intervals)
- Timeout handling and escalation
- Return responses to Forge Intent via callbacks

**Cost:** ~$35/month (1 vCPU, 2GB RAM for 50 interviews/day)

**Configuration:** See `config/openclaw.json`

### 3.4 FigJam Integration

**Role:** Output visualization

**Mechanism:** Figma API push of interview summaries to whiteboard

---

## 4. Resolved Architecture Decisions

### DECISION 1: Question Generation — RESOLVED

**Choice:** Option A — Standard MCP Pattern

Forge Intent calls Claude API with methodology fetched from Context MCP.

```
Forge Intent                    Context MCP                 Claude API
     │                               │                           │
     │── forge_get_context ─────────▶│                           │
     │◀── methodology/patterns ──────│                           │
     │                               │                           │
     │── Claude API (with context) ─────────────────────────────▶│
     │◀── generated questions ───────────────────────────────────│
```

**Rationale:**
- Context MCP stays pure MCP (no LLM integration)
- Forge Intent controls LLM calls and costs
- Standard pattern, easier to maintain

---

### DECISION 2: Analysis Knowledge/Execution — RESOLVED

**Choice:** Knowledge in Context MCP, Execution in Forge Intent

- **Context MCP provides:** Analysis rules, Bayesian patterns, convergence criteria
- **Forge Intent executes:** Calls Claude API with rules + responses to generate analysis

**Flow:**
1. Forge Intent receives response from OpenClaw
2. Fetches analysis rules from Context MCP
3. Calls Claude API: `{rules} + {responses} → analysis + next questions`
4. Stores analysis in S3
5. Sends next questions to OpenClaw

---

### DECISION 3: S3 Strategy — RESOLVED

**Choice:** Option B — Separate Buckets

| Bucket | Purpose | Owner |
|--------|---------|-------|
| `arcfoundry-context` | Methodology, patterns, rules | Context MCP (read-only) |
| `arcfoundry-interview-data` | Interview Q&A, responses | Forge Intent (read/write) |

**Enforcement:** IAM policy explicitly denies Context MCP access to interview data bucket.

**Structure:** See `docs/S3-INTERVIEW-DATA-STRUCTURE.md`

---

### DECISION 4: OpenClaw Integration — RESOLVED

**Choice:** Single Gateway with Multi-Agent Routing + Webhook Callbacks

**Architecture:**
- Single OpenClaw Gateway process on Forge Intent server
- Multi-agent routing: 1 agent per interviewee
- Cron scheduler: Per-interviewee jobs (reminders, timeouts)
- Bidirectional webhooks for communication

**Integration Flow:**
```
1. Forge Intent → OpenClaw: POST /hooks/interview-start
   {intervieweeId, channel, questions, timeoutHours, reminderSchedule}

2. OpenClaw creates:
   - Agent for interviewee (if not exists)
   - Cron jobs for reminders + timeout
   - Sends questions via channel

3. [Cron manages wait/remind cycle]

4. OpenClaw → Forge Intent: POST /api/openclaw/callback
   {type: "response", intervieweeId, level, responses}

5. Forge Intent processes → generates next level → POST /hooks/interview-continue
```

**Contracts:** See `docs/OPENCLAW-WEBHOOK-CONTRACTS.md`

---

## 5. Interview Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PHASE 0: SETUP (Employee in Forge Intent Web App)                      │
│  ├── Enter interviewee contact info                                     │
│  │   ├── Name                                                           │
│  │   ├── Preferred channel (WhatsApp, SMS, email, Slack)                │
│  │   └── Contact details                                                │
│  └── Define problem statement for Phase 1                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PHASE 1: LEVEL 1 QUESTIONS (Same for all interviewees)                 │
│  ├── Forge Intent fetches methodology from Context MCP                  │
│  ├── Forge Intent calls Claude API → generates L1 questions             │
│  ├── POST /hooks/interview-start to OpenClaw                            │
│  └── OpenClaw contacts ALL interviewees simultaneously                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PHASE 2+: CUSTOM QUESTIONS (Per interviewee)                           │
│  ├── OpenClaw returns responses via callback                            │
│  ├── Forge Intent grammar-corrects responses                            │
│  ├── Forge Intent analyzes (Claude API + Context MCP rules)             │
│  ├── Level 2+ questions are UNIQUE per interviewee                      │
│  ├── POST /hooks/interview-continue to OpenClaw                         │
│  └── Loop until root cause identified (typically 4-7 levels)            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PHASE 3: CONVERGENCE                                                   │
│  ├── Root cause identified (convergence threshold: 0.85)                │
│  ├── POST /hooks/interview-complete to OpenClaw                         │
│  ├── Interview summary generated                                        │
│  └── Push to FigJam via Figma API                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Confirmed Decisions Summary

| Decision | Choice |
|----------|--------|
| AWS Region | us-west-2 |
| Context storage | S3 (`arcfoundry-context`) + GitHub |
| Interview data storage | S3 (`arcfoundry-interview-data`) |
| Context MCP protocol | Standard MCP (tools) |
| Question generation | Forge Intent calls Claude API with Context MCP methodology |
| Analysis execution | Forge Intent (rules from Context MCP) |
| OpenClaw deployment | Single Gateway, co-located on ECS |
| OpenClaw routing | Multi-agent (1 per interviewee) |
| OpenClaw integration | Bidirectional webhooks |
| Session management | Cron-based reminders + timeouts |
| Channels | Email, SMS, WhatsApp, Slack |
| Voice capability | Yes, browser recording → S3 → Transcribe |
| Interview trigger | Employee clicks "Start" in web app |
| Level 1 questions | Same for all interviewees |
| Level 2+ questions | Custom per interviewee |
| Termination criteria | Root cause identification (convergence ≥ 0.85) |
| Output | FigJam via Figma API |

---

## 7. Cost Estimate

| Component | Monthly Cost |
|-----------|--------------|
| OpenClaw Gateway (1 vCPU, 2GB) | ~$35 |
| DynamoDB (on-demand) | ~$5-10 |
| S3 (interview data) | ~$1-2 |
| Context MCP (existing) | ~$30 |
| Claude API (questions + analysis) | ~$50-100 |
| **Total** | **~$120-180** |

Based on 1,500 interviews/month (50/day × 30 days).

---

## 8. Next Steps (Implementation Phase)

1. **DynamoDB schema finalization** — Session state table with interview tracking
2. **Forge Intent API endpoints** — `/api/openclaw/callback` handler
3. **OpenClaw Gateway setup** — Deploy with `config/openclaw.json`
4. **S3 bucket creation** — `arcfoundry-interview-data` with IAM policies
5. **Context MCP content** — Author CDM methodology for `forge-intent` domain
6. **Web app UI** — Employee interface for interview setup
7. **FigJam API integration** — Push convergence summaries

---

## 9. Reference Documents

### Architecture
- ArcFoundry Context MCP Architecture (`ArcFoundryContextMCP-Architecture.md`)
- ArcFoundry Context MCP Implementation (`ArcFoundryContextMCP-Implementation.md`)

### Integration
- OpenClaw Configuration: `config/openclaw.json`
- OpenClaw Webhook Contracts: `docs/OPENCLAW-WEBHOOK-CONTRACTS.md`
- S3 Interview Data Structure: `docs/S3-INTERVIEW-DATA-STRUCTURE.md`

### External
- OpenClaw Documentation: `docs.openclaw.ai`
- OpenClaw GitHub: `github.com/openclaw/openclaw`
- Auragen AI System Spec v1.2 (voice architecture reference)

---

## Appendix A: Terminology

| Term | Definition |
|------|------------|
| **Context** | Methodology, patterns, rules stored in Context MCP. Version-controlled. |
| **DATA** | Interview questions and responses. NOT context. Must not bias methodology. |
| **Level 1** | Initial questions, same for all interviewees |
| **Level 2+** | Custom follow-up questions based on individual responses |
| **Root cause** | The identified friction point, terminates the interview |
| **CDM** | Critical Decision Method — structured interview methodology |
| **Convergence** | When analysis confidence reaches threshold (0.85) |
| **Gateway** | OpenClaw process that manages all interviewee agents |
| **Agent** | Per-interviewee OpenClaw instance managing their session |
