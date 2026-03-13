# Forge Intent System Architecture

**Version:** 1.0
**Date:** 2026-03-13
**Status:** Architecture Complete — Ready for Review
**Authors:** ArcFoundry Architecture Team

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Context MCP Server](#3-context-mcp-server)
4. [Forge Intent Orchestrator](#4-forge-intent-orchestrator)
5. [OpenClaw Communication Layer](#5-openclaw-communication-layer)
6. [Data Architecture](#6-data-architecture)
7. [Infrastructure & Operations](#7-infrastructure--operations)
8. [Security Architecture](#8-security-architecture)
9. [Cost Analysis](#9-cost-analysis)
10. [Implementation Roadmap](#10-implementation-roadmap)

---

## 1. Executive Summary

### 1.1 Purpose

Forge Intent is an AI-powered interview system that conducts structured Critical Decision Method (CDM) interviews to identify root causes of user friction. The system automates multi-round, multi-channel interviews with stakeholders, progressively narrowing toward root cause identification through Bayesian analysis.

### 1.2 Key Capabilities

| Capability | Description |
|------------|-------------|
| **Multi-Channel Interviews** | Email, SMS, Slack, WhatsApp, voice — interviewee chooses |
| **Adaptive Questioning** | Level 1 questions are standard; Level 2+ are custom per interviewee based on prior responses |
| **Autonomous Session Management** | Configurable timeouts, automated reminders, escalation handling |
| **Parallel Interviews** | 50+ interviews per day, 5 rounds each, ~300 concurrent at steady state |
| **Root Cause Convergence** | Bayesian analysis identifies when interviews have converged on root cause |
| **FigJam Output** | Interview summaries pushed to collaborative whiteboard for team review |

### 1.3 Architecture Principles

1. **Separation of Concerns** — Context MCP holds knowledge, Forge Intent executes, OpenClaw communicates
2. **Data ≠ Context** — Interview responses are DATA, stored separately, must not bias methodology
3. **Standard Protocols** — MCP for context retrieval, HTTP webhooks for OpenClaw integration
4. **Stateless Orchestration** — Forge Intent is stateless; all state persists in DynamoDB/S3
5. **Cost Efficiency** — Single OpenClaw Gateway handles all interviews (~$35/month compute)

### 1.4 Architecture Decisions Summary

| Decision | Resolution |
|----------|------------|
| Question Generation | Standard MCP pattern — Forge Intent calls Claude API with methodology from Context MCP |
| Analysis Execution | Knowledge in Context MCP, execution in Forge Intent |
| S3 Strategy | Separate buckets: `arcfoundry-context` (methodology), new bucket (interview data) |
| OpenClaw Integration | Option A — Single Gateway, multi-agent routing, cron-managed sessions |

---

## 2. System Architecture Overview

### 2.1 High-Level Architecture

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
│  └─────────────────┘    │  - S3 storage   │    │  - Hot/Warm/Cold tiers  │ │
│                         └────────┬────────┘    └─────────────────────────┘ │
│                                  │                                          │
│                                  │ HTTP webhooks                            │
│                                  ▼                                          │
│                    ┌─────────────────────────────┐                         │
│                    │    OpenClaw Gateway         │                         │
│                    │    (Single Process)         │                         │
│                    │                             │                         │
│                    │  ┌───────────────────────┐ │                         │
│                    │  │    Cron Scheduler     │ │                         │
│                    │  │  - Reminders          │ │                         │
│                    │  │  - Timeouts           │ │                         │
│                    │  │  - Escalations        │ │                         │
│                    │  └───────────────────────┘ │                         │
│                    │                             │                         │
│                    │  ┌───────────────────────┐ │                         │
│                    │  │  Multi-Agent Router   │ │                         │
│                    │  │  ├─ interviewee-001   │ │                         │
│                    │  │  ├─ interviewee-002   │ │                         │
│                    │  │  └─ interviewee-NNN   │ │                         │
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

### 2.2 Component Responsibilities

| Component | Role | Key Responsibilities |
|-----------|------|----------------------|
| **Employee UI** | Human interface | Enter interviewee info, define problem, start interviews, monitor progress |
| **Forge Intent Orchestrator** | Execution engine | Question generation, grammar correction, level progression, S3 storage, FigJam output |
| **Context MCP Server** | Knowledge repository | CDM methodology, question patterns, analysis rules, Bayesian inference patterns |
| **OpenClaw Gateway** | Communication layer | Multi-channel messaging, session management via cron, response capture |
| **DynamoDB** | Session state | Interview progress, level tracking, timeout configuration |
| **S3 (Interview Data)** | Data storage | Questions asked, raw responses, grammar-corrected responses |
| **S3 (Context)** | Methodology storage | Hot/warm/cold context tiers, version-controlled via GitHub |

---

## 3. Context MCP Server

### 3.1 Overview

The Context MCP Server (`context.arcfoundry.ai`) is the knowledge repository for all ArcFoundry systems. For Forge Intent, it provides:

- **CDM Methodology** — The 4-phase Critical Decision Method process
- **Question Generation Patterns** — Templates and rules for generating interview questions
- **Analysis Rules** — Bayesian inference patterns for response analysis
- **Root Cause Detection** — Convergence criteria for terminating interviews

### 3.2 Three-Tier Context Model

| Tier | Size | Retrieval | Forge Intent Use Case |
|------|------|-----------|----------------------|
| **Hot** | ~5-10K tokens | Always loaded | Core CDM rules, question constraints, termination criteria |
| **Warm** | ~20-50K tokens | Per-task request | Analysis patterns, domain-specific methodology |
| **Cold** | Unlimited | Semantic search | Historical lessons, edge case patterns, deep reference |

### 3.3 MCP Tools

```typescript
// Read tools
forge_list_domains()     // List available context domains
forge_get_context(domain, tier, topic?)  // Fetch specific context
forge_search_context(query, domain?, maxResults?)  // Semantic search

// Write tools (for methodology updates, not interview data)
forge_add_context(domain, tier, topic, content, summary)
forge_update_context(domain, tier, topic, content, summary)
forge_delete_context(domain, tier, topic, reason)
```

### 3.4 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Context MCP Server                            │
│                    (ECS Fargate, us-west-2)                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐│
│  │ MCP Protocol │   │   Express    │   │   Context Gateway    ││
│  │   Handler    │   │   Server     │   │   (S3 + GitHub)      ││
│  │              │   │              │   │                      ││
│  │  - stdio     │   │  - /health   │   │  - S3 reads (fast)   ││
│  │  - HTTP      │   │  - /console  │   │  - GitHub writes     ││
│  │              │   │  - /mcp      │   │  - CI/CD triggers    ││
│  └──────────────┘   └──────────────┘   └──────────────────────┘│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌──────────────┐    ┌──────────────────┐    ┌──────────────┐
│   Agents     │    │   Web Console    │    │   S3 Bucket  │
│   (Claude    │    │   (Test/Admin)   │    │   arcfoundry │
│    Code)     │    │                  │    │   -context   │
└──────────────┘    └──────────────────┘    └──────────────┘
```

### 3.5 Forge Intent Domain Structure

```
s3://arcfoundry-context/forge-intent/
├── hot/
│   ├── cdm-methodology.md        # Core 4-phase CDM process
│   ├── question-constraints.md   # Rules for question generation
│   └── termination-criteria.md   # When to stop interviews
├── warm/
│   ├── bayesian-analysis.md      # Response analysis patterns
│   ├── level-progression.md      # How to advance levels
│   ├── convergence-rules.md      # Root cause detection
│   └── domain-knowledge.md       # Industry-specific patterns
└── cold/
    ├── lessons/                  # Historical learnings
    ├── edge-cases/               # Unusual scenarios
    └── patterns/                 # Reusable interview patterns
```

---

## 4. Forge Intent Orchestrator

### 4.1 Overview

The Forge Intent Orchestrator is the execution engine. It is intentionally stateless — all state persists in DynamoDB and S3. Its responsibilities:

1. **Question Generation** — Fetch methodology from Context MCP, call Claude API to generate questions
2. **Grammar Correction** — Clean up interviewee responses before storage
3. **Level Progression** — Determine when to advance to next level, generate custom questions
4. **Session Management** — Track interview state in DynamoDB
5. **S3 Storage** — Store interview data (questions, responses, grammar-corrected versions)
6. **FigJam Output** — Push final summaries to collaborative whiteboard

### 4.2 Question Generation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        QUESTION GENERATION FLOW                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Forge Intent                     2. Context MCP                         │
│     │                                    │                                  │
│     │── forge_get_context ──────────────▶│                                  │
│     │   (domain: forge-intent,           │                                  │
│     │    tier: hot,                      │                                  │
│     │    topic: cdm-methodology)         │                                  │
│     │                                    │                                  │
│     │◀── methodology content ────────────│                                  │
│     │                                    │                                  │
│                                                                              │
│  3. Forge Intent                     4. Claude API                          │
│     │                                    │                                  │
│     │── API call ───────────────────────▶│                                  │
│     │   System: [methodology]            │                                  │
│     │   User: [problem + history]        │                                  │
│     │                                    │                                  │
│     │◀── generated questions ────────────│                                  │
│     │                                    │                                  │
│                                                                              │
│  5. Forge Intent stores questions in S3                                     │
│  6. Forge Intent triggers OpenClaw to send questions                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Multi-Interviewee Session Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     MULTI-INTERVIEWEE SESSIONS                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Problem: "Why is checkout conversion dropping?"                            │
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │ Interviewee A   │  │ Interviewee B   │  │ Interviewee C   │             │
│  │ (Product Mgr)   │  │ (Engineer)      │  │ (Support Rep)   │             │
│  │ Channel: Email  │  │ Channel: Slack  │  │ Channel: SMS    │             │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘             │
│           │                    │                    │                       │
│           ▼                    ▼                    ▼                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    LEVEL 1 QUESTIONS (SAME FOR ALL)                  │   │
│  │  Q1: What is the core problem you're seeing?                        │   │
│  │  Q2: Who are the primary stakeholders affected?                     │   │
│  │  Q3: When did you first notice this issue?                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│           │                    │                    │                       │
│           ▼                    ▼                    ▼                       │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐                 │
│  │ L1 Response │      │ L1 Response │      │ L1 Response │                 │
│  │ "Payments   │      │ "API timeout│      │ "Customers  │                 │
│  │  failing"   │      │  at checkout│      │  calling in │                 │
│  └──────┬──────┘      └──────┬──────┘      └──────┬──────┘                 │
│         │                    │                    │                        │
│         ▼                    ▼                    ▼                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              LEVEL 2+ QUESTIONS (CUSTOM PER INTERVIEWEE)             │   │
│  │                                                                      │   │
│  │  A: "Which payment methods are failing?"                            │   │
│  │  B: "What's the API timeout threshold? What changed recently?"      │   │
│  │  C: "What are the top 3 complaints customers mention?"              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  [Process continues until convergence on root cause]                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.4 DynamoDB Session Schema

```typescript
// Table: forge-intent-sessions
{
  intervieweeId: string;       // PK: "alice-001"
  problemId: string;           // FK to problem being investigated
  currentLevel: number;        // 1, 2, 3, 4, 5
  status: string;              // "awaiting_response" | "processing" | "complete"
  channel: string;             // "email" | "sms" | "slack"
  contact: string;             // "alice@company.com"
  timeoutMinutes: number;      // Configurable per interviewee
  reminderMinutes: number[];   // [360, 720, 1200] (6h, 12h, 20h)
  history: {
    level: number;
    questionsSentAt: string;   // ISO 8601
    responseReceivedAt?: string;
    questionsS3Key: string;
    responseS3Key?: string;
  }[];
  createdAt: string;
  updatedAt: string;
}
```

### 4.5 Features & Functions

| Feature | Function | Description |
|---------|----------|-------------|
| **Interview Initialization** | `startInterview()` | Create session, generate L1 questions, trigger OpenClaw |
| **Question Generation** | `generateQuestions()` | Fetch methodology, call Claude, store in S3 |
| **Response Processing** | `processResponse()` | Grammar correction, store in S3, update session |
| **Level Progression** | `advanceLevel()` | Analyze responses, generate custom questions for next level |
| **Convergence Detection** | `checkConvergence()` | Apply Bayesian rules to detect root cause |
| **FigJam Export** | `exportToFigJam()` | Push interview summary to Figma API |
| **Timeout Handling** | `handleTimeout()` | Mark interviewee non-responsive, notify employee |

---

## 5. OpenClaw Communication Layer

### 5.1 Overview

OpenClaw is a multi-channel AI gateway that handles actual communication with interviewees. It runs as a single Node.js process on the Forge Intent server, managing all interview sessions through multi-agent routing.

### 5.2 Architecture (Option A: Single Gateway)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         OPENCLAW GATEWAY                                     │
│                         (Single Node.js Process)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                        CRON SCHEDULER                                  │ │
│  │                                                                        │ │
│  │  Job: alice-001-L1-reminder-1    │  Job: bob-002-L2-timeout           │ │
│  │  At: 2026-03-13T16:00:00Z        │  At: 2026-03-14T10:00:00Z          │ │
│  │  Action: Send reminder email     │  Action: Webhook to Forge Intent   │ │
│  │                                  │                                     │ │
│  │  Job: alice-001-L1-reminder-2    │  Job: carol-003-L1-reminder-1      │ │
│  │  At: 2026-03-13T22:00:00Z        │  At: 2026-03-13T18:00:00Z          │ │
│  │  Action: Send reminder email     │  Action: Send reminder SMS         │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                      MULTI-AGENT ROUTER                                │ │
│  │                                                                        │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │ │
│  │  │ Agent:      │  │ Agent:      │  │ Agent:      │  │ Agent:      │  │ │
│  │  │ alice-001   │  │ bob-002     │  │ carol-003   │  │ dave-004    │  │ │
│  │  │             │  │             │  │             │  │             │  │ │
│  │  │ Channel:    │  │ Channel:    │  │ Channel:    │  │ Channel:    │  │ │
│  │  │ email       │  │ slack       │  │ sms         │  │ whatsapp    │  │ │
│  │  │             │  │             │  │             │  │             │  │ │
│  │  │ Workspace:  │  │ Workspace:  │  │ Workspace:  │  │ Workspace:  │  │ │
│  │  │ ~/.oc/001/  │  │ ~/.oc/002/  │  │ ~/.oc/003/  │  │ ~/.oc/004/  │  │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                      CHANNEL ADAPTERS                                  │ │
│  │                                                                        │ │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐     │ │
│  │  │  Email  │  │   SMS   │  │  Slack  │  │WhatsApp │  │  Voice  │     │ │
│  │  │  SMTP   │  │ Twilio  │  │  API    │  │  API    │  │ Twilio  │     │ │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────┘     │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Integration Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FORGE INTENT ↔ OPENCLAW INTEGRATION                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  STEP 1: Start Interview                                                    │
│  ────────────────────────                                                   │
│  Forge Intent → POST /hooks/interview-start                                 │
│  {                                                                          │
│    "intervieweeId": "alice-001",                                            │
│    "channel": "email",                                                      │
│    "contact": "alice@company.com",                                          │
│    "questions": ["Q1...", "Q2...", "Q3..."],                               │
│    "timeoutHours": 24,                                                      │
│    "reminderHours": [6, 12, 20],                                            │
│    "callbackUrl": "https://forge-intent.internal/api/response"             │
│  }                                                                          │
│                                                                              │
│  OpenClaw:                                                                  │
│    1. Creates/assigns agent for alice-001                                   │
│    2. Sends questions via email                                             │
│    3. Creates cron jobs:                                                    │
│       - alice-001-L1-reminder-1 @ T+6h                                      │
│       - alice-001-L1-reminder-2 @ T+12h                                     │
│       - alice-001-L1-reminder-3 @ T+20h                                     │
│       - alice-001-L1-timeout @ T+24h                                        │
│                                                                              │
│  STEP 2: Cron-Managed Wait Cycle                                            │
│  ───────────────────────────────                                            │
│  [T+6h]  Cron fires → Send reminder: "Hi Alice, checking in..."            │
│  [T+12h] Cron fires → Send reminder: "Hi Alice, we'd love to hear..."      │
│  [T+14h] Response received → Cancel remaining jobs                          │
│                                                                              │
│  STEP 3: Response Callback                                                  │
│  ─────────────────────────                                                  │
│  OpenClaw → POST /api/response (to Forge Intent)                           │
│  {                                                                          │
│    "intervieweeId": "alice-001",                                            │
│    "level": 1,                                                              │
│    "rawResponse": "Alice's answers...",                                     │
│    "channel": "email",                                                      │
│    "respondedAt": "2026-03-13T14:00:00Z"                                   │
│  }                                                                          │
│                                                                              │
│  STEP 4: Continue Interview                                                 │
│  ──────────────────────────                                                 │
│  Forge Intent processes response, generates L2 questions                   │
│  Forge Intent → POST /hooks/interview-continue                             │
│  {                                                                          │
│    "intervieweeId": "alice-001",                                            │
│    "level": 2,                                                              │
│    "questions": ["L2-Q1...", "L2-Q2..."],                                  │
│    "timeoutHours": 48,                                                      │
│    "reminderHours": [12, 24, 36]                                            │
│  }                                                                          │
│                                                                              │
│  [Repeat until all levels complete or root cause identified]               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.4 OpenClaw Configuration

```json
{
  "gateway": {
    "port": 18789,
    "host": "127.0.0.1"
  },
  "cron": {
    "enabled": true,
    "maxConcurrentRuns": 5,
    "sessionRetention": "72h"
  },
  "agents": {
    "list": [
      {
        "id": "template",
        "name": "Interview Template",
        "workspace": "~/.openclaw/interviews/template",
        "agentDir": "~/.openclaw/agents/interview/agent"
      }
    ]
  },
  "channels": {
    "email": {
      "enabled": true,
      "smtp": {
        "host": "${SMTP_HOST}",
        "port": 587,
        "user": "${SMTP_USER}",
        "pass": "${SMTP_PASS}"
      }
    },
    "twilio": {
      "enabled": true,
      "accountSid": "${TWILIO_ACCOUNT_SID}",
      "authToken": "${TWILIO_AUTH_TOKEN}",
      "fromNumber": "${TWILIO_FROM_NUMBER}"
    },
    "slack": {
      "enabled": true,
      "botToken": "${SLACK_BOT_TOKEN}",
      "socketMode": true
    }
  },
  "webhooks": {
    "authToken": "${OPENCLAW_WEBHOOK_TOKEN}"
  }
}
```

---

## 6. Data Architecture

### 6.1 Storage Separation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DATA ARCHITECTURE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────┐    ┌─────────────────────────────────────┐│
│  │  S3: arcfoundry-context     │    │  S3: arcfoundry-interview-data     ││
│  │  (METHODOLOGY)              │    │  (INTERVIEW DATA)                   ││
│  │                             │    │                                     ││
│  │  forge-intent/              │    │  problems/                          ││
│  │  ├── hot/                   │    │  └── {problemId}/                   ││
│  │  │   ├── cdm-methodology    │    │      ├── metadata.json              ││
│  │  │   └── termination-rules  │    │      └── interviewees/              ││
│  │  ├── warm/                  │    │          └── {intervieweeId}/       ││
│  │  │   ├── bayesian-analysis  │    │              ├── L1-questions.json  ││
│  │  │   └── convergence-rules  │    │              ├── L1-response-raw.md ││
│  │  └── cold/                  │    │              ├── L1-response.md     ││
│  │      └── lessons/           │    │              ├── L2-questions.json  ││
│  │                             │    │              ├── L2-response-raw.md ││
│  │  Version: GitHub            │    │              ├── L2-response.md     ││
│  │  Access: Context MCP        │    │              └── summary.json       ││
│  └─────────────────────────────┘    │                                     ││
│                                     │  Version: S3 versioning             ││
│                                     │  Access: Forge Intent only          ││
│                                     └─────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                          DynamoDB                                        ││
│  │                          (SESSION STATE)                                 ││
│  │                                                                          ││
│  │  Table: forge-intent-sessions                                           ││
│  │  PK: intervieweeId                                                      ││
│  │  Attributes: problemId, currentLevel, status, channel, history[],      ││
│  │              timeoutMinutes, reminderMinutes[], createdAt, updatedAt   ││
│  │                                                                          ││
│  │  Table: forge-intent-problems                                           ││
│  │  PK: problemId                                                          ││
│  │  Attributes: description, createdBy, intervieweeIds[], status,         ││
│  │              convergenceScore, rootCause, createdAt, completedAt       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Data Flow

```
Employee enters problem + interviewees
         │
         ▼
┌─────────────────────┐
│ DynamoDB: Create    │
│ problem + sessions  │
└─────────────────────┘
         │
         ▼
┌─────────────────────┐      ┌─────────────────────┐
│ Context MCP:        │      │ Claude API:         │
│ Fetch methodology   │─────▶│ Generate questions  │
└─────────────────────┘      └─────────────────────┘
                                      │
                                      ▼
                             ┌─────────────────────┐
                             │ S3: Store questions │
                             │ (interview-data)    │
                             └─────────────────────┘
                                      │
                                      ▼
                             ┌─────────────────────┐
                             │ OpenClaw: Send to   │
                             │ interviewee         │
                             └─────────────────────┘
                                      │
                             [Wait for response]
                                      │
                                      ▼
                             ┌─────────────────────┐
                             │ OpenClaw: Response  │
                             │ received            │
                             └─────────────────────┘
                                      │
                                      ▼
                             ┌─────────────────────┐
                             │ S3: Store raw       │
                             │ response            │
                             └─────────────────────┘
                                      │
                                      ▼
                             ┌─────────────────────┐
                             │ Claude API: Grammar │
                             │ correction          │
                             └─────────────────────┘
                                      │
                                      ▼
                             ┌─────────────────────┐
                             │ S3: Store corrected │
                             │ response            │
                             └─────────────────────┘
                                      │
                                      ▼
                             ┌─────────────────────┐
                             │ DynamoDB: Update    │
                             │ session state       │
                             └─────────────────────┘
                                      │
                       [Generate next level questions]
                                      │
                             [Repeat until convergence]
                                      │
                                      ▼
                             ┌─────────────────────┐
                             │ FigJam: Push        │
                             │ summary             │
                             └─────────────────────┘
```

---

## 7. Infrastructure & Operations

### 7.1 AWS Infrastructure (us-west-2)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AWS INFRASTRUCTURE                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                              VPC                                         ││
│  │                                                                          ││
│  │  ┌─────────────────────┐    ┌─────────────────────┐                    ││
│  │  │   Public Subnet     │    │   Private Subnet    │                    ││
│  │  │                     │    │                     │                    ││
│  │  │  ┌───────────────┐ │    │  ┌───────────────┐ │                    ││
│  │  │  │      ALB      │ │    │  │  ECS Fargate  │ │                    ││
│  │  │  │               │ │───▶│  │               │ │                    ││
│  │  │  │ - TLS (ACM)   │ │    │  │ - Context MCP │ │                    ││
│  │  │  │ - Cognito     │ │    │  │ - Forge Intent│ │                    ││
│  │  │  │ - Path routing│ │    │  │ - OpenClaw    │ │                    ││
│  │  │  └───────────────┘ │    │  └───────────────┘ │                    ││
│  │  │                     │    │                     │                    ││
│  │  └─────────────────────┘    └─────────────────────┘                    ││
│  │                                      │                                   ││
│  │                                      ▼                                   ││
│  │  ┌─────────────────────────────────────────────────────────────────────┐││
│  │  │                         AWS Services                                │││
│  │  │                                                                     │││
│  │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐ │││
│  │  │  │   S3    │  │DynamoDB │  │ Cognito │  │ Secrets │  │   ECR   │ │││
│  │  │  │         │  │         │  │         │  │ Manager │  │         │ │││
│  │  │  │- context│  │- sessions│ │- users  │  │- tokens │  │- images │ │││
│  │  │  │- data   │  │- problems│ │- groups │  │- keys   │  │         │ │││
│  │  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────┘ │││
│  │  └─────────────────────────────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  DNS: context.arcfoundry.ai → ALB (CNAME via GoDaddy)                       │
│  DNS: forge-intent.arcfoundry.ai → ALB (CNAME via GoDaddy)                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Deployment Architecture

| Component | Service | Spec | Scaling |
|-----------|---------|------|---------|
| Context MCP | ECS Fargate | 0.5 vCPU, 1GB | 1 task (can scale to 2) |
| Forge Intent | ECS Fargate | 1 vCPU, 2GB | 1-3 tasks based on load |
| OpenClaw | ECS Fargate | 1 vCPU, 2GB | 1 task (handles 300+ concurrent) |
| DynamoDB | On-Demand | — | Auto-scales |
| S3 | Standard | — | Unlimited |

---

## 8. Security Architecture

### 8.1 Authentication & Authorization

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| **Employee UI** | AWS Cognito | `arcfoundry-internal` group required |
| **Context MCP** | Cognito JWT via ALB | Read: all internal, Write: admin only |
| **Forge Intent API** | Cognito JWT | Internal employees only |
| **OpenClaw Webhooks** | Bearer token | Shared secret between Forge Intent ↔ OpenClaw |
| **Channel Credentials** | AWS Secrets Manager | SMTP, Twilio, Slack tokens |

### 8.2 Data Security

| Data Type | Encryption | Access Control |
|-----------|------------|----------------|
| Context (S3) | SSE-S3 | IAM role (Context MCP task only) |
| Interview Data (S3) | SSE-S3 | IAM role (Forge Intent task only) |
| Session State (DynamoDB) | Encryption at rest | IAM role |
| Secrets | Secrets Manager | Scoped to task roles |

### 8.3 Network Security

- **TLS everywhere** — ALB terminates TLS, internal traffic over HTTPS
- **No public S3 access** — Bucket policies deny all public access
- **Private subnets** — ECS tasks run in private subnets, NAT for outbound
- **Security groups** — ALB → ECS only, no direct internet access to tasks

---

## 9. Cost Analysis

### 9.1 Monthly Cost Breakdown

| Component | Service | Spec | Monthly Cost |
|-----------|---------|------|--------------|
| **Context MCP** | ECS Fargate | 0.5 vCPU, 1GB, 24/7 | ~$18 |
| **Forge Intent** | ECS Fargate | 1 vCPU, 2GB, 24/7 | ~$35 |
| **OpenClaw** | ECS Fargate | 1 vCPU, 2GB, 24/7 | ~$35 |
| **Load Balancer** | ALB | 1 ALB, 2 target groups | ~$20 |
| **DynamoDB** | On-Demand | ~10K writes/day | ~$5-10 |
| **S3 (Context)** | Standard | < 1 GB | < $1 |
| **S3 (Interview Data)** | Standard | < 10 GB | < $1 |
| **Cognito** | User Pool | < 50K MAU | Free |
| **Secrets Manager** | 5 secrets | — | ~$2 |
| **ACM** | 2 certificates | — | Free |
| **Claude API** | API calls | ~7,500 calls/month | ~$50-100 |
| **Twilio** | SMS | ~1,500 SMS/month | ~$15 |
| **SMTP** | Email | ~5,000 emails/month | ~$5-10 |
| | | | |
| **TOTAL** | | | **~$190-250/month** |

### 9.2 Scaling Costs

| Scale | Interviews/Month | Compute | Claude API | Total |
|-------|------------------|---------|------------|-------|
| Pilot | 100 | ~$100 | ~$10 | ~$120 |
| Production | 1,500 | ~$100 | ~$100 | ~$250 |
| Enterprise | 10,000 | ~$200 | ~$500 | ~$800 |

---

## 10. Implementation Roadmap

### 10.1 Phase 1: Foundation (Weeks 1-2)

- [ ] Create S3 bucket for interview data
- [ ] Set up DynamoDB tables (sessions, problems)
- [ ] Deploy OpenClaw Gateway on ECS
- [ ] Configure channel adapters (email, SMS)
- [ ] Implement Forge Intent ↔ OpenClaw webhook contracts

### 10.2 Phase 2: Core Flow (Weeks 3-4)

- [ ] Implement question generation flow (Context MCP → Claude → S3)
- [ ] Build response processing pipeline (grammar correction, storage)
- [ ] Implement level progression logic
- [ ] Configure OpenClaw cron jobs for reminders/timeouts
- [ ] Build Employee UI (basic: enter interviewees, start interview)

### 10.3 Phase 3: Intelligence (Weeks 5-6)

- [ ] Author CDM methodology content for Context MCP
- [ ] Implement Bayesian analysis for response evaluation
- [ ] Build convergence detection logic
- [ ] Add root cause identification criteria
- [ ] Test multi-interviewee parallel interviews

### 10.4 Phase 4: Output & Polish (Weeks 7-8)

- [ ] Implement FigJam integration (Figma API)
- [ ] Build interview summary generation
- [ ] Add Employee UI dashboard (status, progress, results)
- [ ] Load testing (50 interviews/day)
- [ ] Documentation and training

---

## Appendix A: API Contracts

### A.1 Forge Intent → OpenClaw

**Start Interview**
```
POST /hooks/interview-start
Authorization: Bearer {OPENCLAW_WEBHOOK_TOKEN}
Content-Type: application/json

{
  "intervieweeId": "string",
  "channel": "email" | "sms" | "slack" | "whatsapp",
  "contact": "string",
  "questions": ["string"],
  "timeoutHours": number,
  "reminderHours": [number],
  "callbackUrl": "string"
}

Response: 200 OK
{
  "status": "started",
  "agentId": "string",
  "cronJobs": ["string"]
}
```

**Continue Interview**
```
POST /hooks/interview-continue
Authorization: Bearer {OPENCLAW_WEBHOOK_TOKEN}
Content-Type: application/json

{
  "intervieweeId": "string",
  "level": number,
  "questions": ["string"],
  "timeoutHours": number,
  "reminderHours": [number]
}

Response: 200 OK
{
  "status": "continued",
  "cronJobs": ["string"]
}
```

### A.2 OpenClaw → Forge Intent

**Response Received**
```
POST /api/response
Authorization: Bearer {FORGE_INTENT_TOKEN}
Content-Type: application/json

{
  "intervieweeId": "string",
  "level": number,
  "rawResponse": "string",
  "channel": "string",
  "respondedAt": "ISO 8601"
}

Response: 200 OK
{
  "status": "received",
  "nextAction": "continue" | "complete"
}
```

**Timeout**
```
POST /api/timeout
Authorization: Bearer {FORGE_INTENT_TOKEN}
Content-Type: application/json

{
  "intervieweeId": "string",
  "level": number,
  "timeoutAt": "ISO 8601"
}

Response: 200 OK
{
  "status": "acknowledged",
  "action": "mark_non_responsive" | "extend" | "escalate"
}
```

---

## Appendix B: Terminology

| Term | Definition |
|------|------------|
| **CDM** | Critical Decision Method — structured interview methodology for root cause analysis |
| **Context** | Methodology, patterns, rules stored in Context MCP. Version-controlled. |
| **DATA** | Interview questions and responses. NOT context. Must not bias methodology. |
| **Level 1** | Initial questions, same for all interviewees |
| **Level 2+** | Custom follow-up questions based on individual responses |
| **Root Cause** | The identified friction point, terminates the interview |
| **Convergence** | When multiple interviewees' responses point to the same root cause |
| **Hot Tier** | Always-loaded context (~5-10K tokens) |
| **Warm Tier** | Per-task context (~20-50K tokens) |
| **Cold Tier** | Semantic search context (unlimited) |

---

**Document End**
