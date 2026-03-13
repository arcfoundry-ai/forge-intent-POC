# Forge Intent Engine — CDM Interview System

> AI-powered root cause discovery using Critical Decision Method (CDM) interviews with Bayesian convergence detection.

## Overview

The Forge Intent Engine conducts structured interviews to identify root causes of process failures, knowledge gaps, and organizational challenges. It uses a **Bayesian probability model** to iteratively narrow down hypotheses based on respondent feedback, converging on the most likely root cause with quantifiable confidence.

### What This Does

1. **Structured CDM Interviews** — Guides respondents through Critical Decision Method questions that elicit expert knowledge about incidents and challenges
2. **Bayesian Convergence** — Updates hypothesis probabilities in real-time based on responses, stopping when 85% confidence is reached
3. **Multi-Respondent Analysis** — Aggregates findings across 5+ respondents to detect consensus vs. divergence
4. **Actionable Reports** — Generates recommendations based on identified root causes

### Use Cases

- **Post-Incident Analysis** — Understand what went wrong after production incidents
- **Process Improvement** — Identify bottlenecks and inefficiencies in workflows
- **Knowledge Discovery** — Surface tacit knowledge from domain experts
- **Onboarding Assessment** — Understand challenges new team members face

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Forge Intent Engine                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   Frontend   │───▶│   HTTP API   │───▶│  MCP Tools   │       │
│  │   Portal     │    │   (Express)  │    │  (14 tools)  │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│         │                   │                   │                │
│         │                   ▼                   │                │
│         │           ┌──────────────┐           │                │
│         │           │   Handlers   │◀──────────┘                │
│         │           │  • Session   │                            │
│         │           │  • Execution │                            │
│         │           │  • Analysis  │                            │
│         │           │  • Lifecycle │                            │
│         │           └──────────────┘                            │
│         │                   │                                    │
│         ▼                   ▼                                    │
│  ┌──────────────────────────────────────────────────┐           │
│  │                    S3 Storage                     │           │
│  │  s3://arcfoundry-context/forge-intent/           │           │
│  │  ├── hot/index.json     (active sessions index)  │           │
│  │  ├── warm/sessions/     (session data)           │           │
│  │  └── cold/archives/     (completed sessions)     │           │
│  └──────────────────────────────────────────────────┘           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

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

## AWS Infrastructure Additions

### S3 Storage Structure

Add the following paths to the existing `arcfoundry-context` bucket:

```
s3://arcfoundry-context/
└── forge-intent/
    ├── hot/
    │   └── index.json          # Active sessions index (updated per activity)
    ├── warm/
    │   └── sessions/
    │       └── {projectId}/
    │           └── {sessionId}.json
    └── cold/
        └── archives/
            └── {year}/{month}/
                └── {projectId}-{sessionId}.json
```

### Required IAM Permissions

Add to the existing ECS task role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::arcfoundry-context/forge-intent/*",
        "arn:aws:s3:::arcfoundry-context"
      ],
      "Condition": {
        "StringLike": {
          "s3:prefix": ["forge-intent/*"]
        }
      }
    }
  ]
}
```

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `AWS_REGION` | AWS region | `us-west-2` |
| `S3_BUCKET` | S3 bucket name | `arcfoundry-context` |
| `S3_PREFIX` | Prefix for intent data | `forge-intent` |
| `PORT` | HTTP server port | `3001` |
| `GITHUB_TOKEN` | GitHub PAT for archiving | `ghp_...` |
| `GITHUB_OWNER` | GitHub org | `arcfoundry-ai` |
| `GITHUB_REPO` | Archive repo | `forge-intent-archives` |

---

## Deployment Guide

### Option A: Integrate into Existing ArcFoundry Context MCP

This is the recommended approach — add interview tools to the existing MCP server.

#### Step 1: Merge Interview Gateway

Copy the integration code:

```bash
cp src/mcp-integration/interview-gateway.ts \
   ../arcfoundry-context-MCP/server/src/interview-gateway.ts
```

#### Step 2: Add Dependencies

```bash
cd ../arcfoundry-context-MCP/server
npm install uuid
```

#### Step 3: Register Tools in server.ts

Add imports:

```typescript
import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  getQuestions,
  submitResponse,
  runTurn,
  advanceRound,
  checkConvergence,
  generateReport,
  runGateC,
  analyzeProject,
  handoff,
  terminate,
  INTERVIEW_TOOL_DEFINITIONS,
} from './interview-gateway.js';
```

Register tools:

```typescript
// Add to tool registration
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...CONTEXT_TOOLS,
    ...INTERVIEW_TOOL_DEFINITIONS,  // Add interview tools
  ],
}));

// Add tool handlers in CallToolRequestSchema handler
case 'interview_create_session':
  return createSession(args);
case 'interview_get_session':
  return getSession(args.sessionId);
// ... (see interview-gateway.ts for all 14 tools)
```

#### Step 4: Deploy to ECS

```bash
# Build and push Docker image
docker build -t arcfoundry-context-mcp .
docker tag arcfoundry-context-mcp:latest \
  <AWS_ACCOUNT>.dkr.ecr.us-west-2.amazonaws.com/arcfoundry-context-mcp:latest
docker push <AWS_ACCOUNT>.dkr.ecr.us-west-2.amazonaws.com/arcfoundry-context-mcp:latest

# Update ECS service
aws ecs update-service \
  --cluster arcfoundry-prod \
  --service context-mcp \
  --force-new-deployment
```

---

### Option B: Standalone Deployment

Deploy Forge Intent as a separate ECS service.

#### Step 1: Create ECR Repository

```bash
aws ecr create-repository \
  --repository-name forge-intent-engine \
  --image-scanning-configuration scanOnPush=true
```

#### Step 2: Build and Push

```bash
cd forge-intent-POC

# Build
npm install
npm run build

# Docker
docker build -t forge-intent-engine .
docker tag forge-intent-engine:latest \
  <AWS_ACCOUNT>.dkr.ecr.us-west-2.amazonaws.com/forge-intent-engine:latest

# Push
aws ecr get-login-password --region us-west-2 | \
  docker login --username AWS --password-stdin <AWS_ACCOUNT>.dkr.ecr.us-west-2.amazonaws.com
docker push <AWS_ACCOUNT>.dkr.ecr.us-west-2.amazonaws.com/forge-intent-engine:latest
```

#### Step 3: Create ECS Task Definition

```json
{
  "family": "forge-intent-engine",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::<AWS_ACCOUNT>:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::<AWS_ACCOUNT>:role/forge-intent-task-role",
  "containerDefinitions": [
    {
      "name": "forge-intent-engine",
      "image": "<AWS_ACCOUNT>.dkr.ecr.us-west-2.amazonaws.com/forge-intent-engine:latest",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 3001,
          "protocol": "tcp"
        }
      ],
      "environment": [
        { "name": "AWS_REGION", "value": "us-west-2" },
        { "name": "S3_BUCKET", "value": "arcfoundry-context" },
        { "name": "S3_PREFIX", "value": "forge-intent" },
        { "name": "PORT", "value": "3001" }
      ],
      "secrets": [
        {
          "name": "GITHUB_TOKEN",
          "valueFrom": "arn:aws:secretsmanager:us-west-2:<AWS_ACCOUNT>:secret:forge-intent/github-token"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/forge-intent-engine",
          "awslogs-region": "us-west-2",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

#### Step 4: Create ECS Service

```bash
aws ecs create-service \
  --cluster arcfoundry-prod \
  --service-name forge-intent-engine \
  --task-definition forge-intent-engine:1 \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx,subnet-yyy],securityGroups=[sg-xxx],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:us-west-2:<AWS_ACCOUNT>:targetgroup/forge-intent-tg/xxx,containerName=forge-intent-engine,containerPort=3001"
```

#### Step 5: Configure ALB

Add listener rule to existing ALB:

```bash
aws elbv2 create-rule \
  --listener-arn arn:aws:elasticloadbalancing:us-west-2:<AWS_ACCOUNT>:listener/app/arcfoundry-alb/xxx/yyy \
  --priority 20 \
  --conditions Field=host-header,Values="forge-intent-api.arcfoundry.ai" \
  --actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:us-west-2:<AWS_ACCOUNT>:targetgroup/forge-intent-tg/xxx
```

#### Step 6: Add Route53 Record

```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id Z0123456789ABC \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "forge-intent-api.arcfoundry.ai",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z35SXDOTRQ7X7K",
          "DNSName": "arcfoundry-alb-xxx.us-west-2.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'
```

---

## Local Development

### Prerequisites

- Node.js 18+
- AWS credentials configured
- Access to `arcfoundry-context` S3 bucket

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

## Portal Deployment

The frontend portal is deployed to GitHub Pages.

### Update Portal

1. Edit `public/index.html`
2. Commit and push to `main`
3. GitHub Actions deploys automatically

### Portal URL

- **Production**: https://arcfoundry-ai.github.io/forge-intent-POC/

### Portal Configuration

The portal automatically detects API availability:

1. Tries `http://localhost:3001/api` (local dev)
2. Falls back to `https://forge-intent-api.arcfoundry.ai/api` (production)
3. If no API available, runs in **Demo Mode** with simulated data

---

## API Reference

### Base URL

- **Local**: `http://localhost:3001/api`
- **Production**: `https://forge-intent-api.arcfoundry.ai/api`

### Endpoints

#### Create Session

```http
POST /api/sessions
Content-Type: application/json

{
  "projectId": "forge-phoenix-ux",
  "respondentDescription": "Senior Developer",
  "domainActivity": "debugging production issues"
}
```

Response:

```json
{
  "sessionId": "sess-abc12345",
  "state": "INITIALIZED",
  "receipt": { ... }
}
```

#### Run Interview Turn

```http
POST /api/sessions/{sessionId}/turn
Content-Type: application/json

{
  "responses": [
    { "questionId": "cdm-r1-q1", "response": "We had a major outage last week..." },
    { "questionId": "cdm-r1-q2", "response": "I was the on-call engineer..." }
  ]
}
```

Response:

```json
{
  "bayesian": {
    "posteriors": {
      "process_gaps": 0.45,
      "tooling_limitations": 0.25,
      "communication_breakdown": 0.15,
      "knowledge_silos": 0.10,
      "resource_constraints": 0.05
    },
    "dominantHypothesis": "process_gaps",
    "dominantPosterior": 0.45,
    "convergenceReached": false,
    "recommendation": "Continue interview to gather more evidence."
  },
  "nextQuestions": [ ... ]
}
```

#### Generate Report

```http
POST /api/sessions/{sessionId}/report
```

Response:

```json
{
  "sessionId": "sess-abc12345",
  "rootCause": "process_gaps",
  "confidence": 0.87,
  "evidenceChain": [ ... ],
  "recommendations": [
    {
      "title": "Document Critical Processes",
      "description": "Create runbooks for high-impact workflows",
      "category": "Process",
      "priority": "HIGH"
    }
  ]
}
```

---

## Session State Machine

```
INITIALIZED ──▶ EXECUTING ──▶ WAITING_FOR_INPUT
                    │                │
                    │                ▼
                    │         CONVERGENCE_REACHED ──▶ TERMINATED
                    │                │
                    ▼                ▼
              TERMINATED ◀────── handoff()
```

| State | Description |
|-------|-------------|
| `INITIALIZED` | Session created, not yet started |
| `EXECUTING` | Processing responses, updating Bayesian model |
| `WAITING_FOR_INPUT` | Awaiting respondent's answers |
| `CONVERGENCE_REACHED` | 85% confidence achieved on root cause |
| `TERMINATED` | Session ended (complete or abandoned) |

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

## Files Structure

```
forge-intent-POC/
├── public/
│   └── index.html           # Frontend portal
├── src/
│   ├── server.ts            # Express HTTP API
│   ├── index.ts             # MCP server entry
│   ├── types.ts             # TypeScript interfaces
│   ├── handlers/
│   │   ├── session-handlers.ts
│   │   ├── execution-handlers.ts
│   │   ├── analysis-handlers.ts
│   │   └── lifecycle-handlers.ts
│   ├── mcp/
│   │   └── tools.ts         # MCP tool definitions
│   ├── mcp-integration/
│   │   ├── interview-gateway.ts  # Full integration (874 lines)
│   │   └── README.md
│   └── storage/
│       └── s3-client.ts     # S3 operations
├── .github/
│   └── workflows/
│       └── deploy-pages.yml # GitHub Pages deployment
├── package.json
├── tsconfig.json
└── README.md
```

---

## Integration with ArcFoundry Context MCP

This POC is designed to be merged into the main `arcfoundry-context-MCP` repository. The integration code is in `src/mcp-integration/interview-gateway.ts`.

### Integration Checklist

- [ ] Copy `interview-gateway.ts` to `arcfoundry-context-MCP/server/src/`
- [ ] Add `uuid` dependency
- [ ] Register 14 interview tools in `server.ts`
- [ ] Deploy updated MCP server to ECS
- [ ] Verify tools available at `https://context.arcfoundry.ai`
- [ ] Update portal API_BASE to production URL

---

## License

MIT License - ArcFoundry 2026
