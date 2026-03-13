# Forge Intent MCP Integration — Merge Instructions

> For DEV team to merge interview tools into arcfoundry-context-MCP

## Current State

| Component | Status | Location |
|-----------|--------|----------|
| Interview Gateway | ✅ Ready | Local: `/Documents/forge-app/arcfoundry-context-MCP/server/src/interview-gateway.ts` |
| Server Integration | ✅ Ready | Local: `server/src/server.ts` (14 tools registered) |
| Pending Commit | ✅ Ready | `5cc11d5` — "feat: Add Forge Intent interview tools (14 MCP tools)" |
| Push Status | ❌ Blocked | No write access to `arcfoundry-ai/arcfoundry-context-MCP` |

---

## Option A: Push Existing Commit (Fastest)

If you have write access to `arcfoundry-ai/arcfoundry-context-MCP`:

```bash
cd /Users/jtapiasme.com/Documents/forge-app/arcfoundry-context-MCP
git push origin main
```

This pushes commit `5cc11d5` which includes:
- `server/src/interview-gateway.ts` (874 lines, 14 MCP tools)
- Updated `server/src/server.ts` with all interview tool registrations
- Updated `server/package.json` with `uuid` dependency

---

## Option B: Manual Merge (If Fresh Clone Needed)

### Step 1: Clone and Setup

```bash
git clone https://github.com/arcfoundry-ai/arcfoundry-context-MCP.git
cd arcfoundry-context-MCP/server
npm install uuid
```

### Step 2: Copy Interview Gateway

```bash
cp /Users/jtapiasme.com/Documents/forge-app/forge-intent-POC/src/mcp-integration/interview-gateway.ts \
   ./src/interview-gateway.ts
```

### Step 3: Update server.ts

Add these imports at the top:

```typescript
import {
  initInterviewClients,
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
  HANDOFF_TARGETS,
} from './interview-gateway.js';
import { S3Client } from '@aws-sdk/client-s3';
import { Octokit } from '@octokit/rest';
```

In the `main()` function, after `initClients()`:

```typescript
// Initialize interview clients
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' });
const octokitClient = githubToken ? new Octokit({ auth: githubToken }) : undefined;
initInterviewClients(s3Client, octokitClient);
```

In `createServer()`, add all 14 interview tools (see existing server.ts lines 161-373 for full implementation).

### Step 4: Build and Test

```bash
npm run build
npm start -- --http

# Test health
curl http://localhost:3100/health

# Test tools list (should show 20 tools: 6 forge + 14 interview)
curl http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### Step 5: Commit and Push

```bash
git add .
git commit -m "feat: Add Forge Intent interview tools (14 MCP tools)

- interview_create_session, interview_get_session, interview_list_sessions, interview_delete_session
- interview_get_questions, interview_submit_response, interview_run_turn, interview_advance_round
- interview_check_convergence, interview_generate_report, interview_run_gate_c, interview_analyze_project
- interview_handoff, interview_terminate

S3 storage: s3://arcfoundry-context/forge-intent/warm/sessions/
Cold archive: s3://arcfoundry-context/forge-intent/cold/archives/

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

git push origin main
```

---

## Step 6: Redeploy to ECS

```bash
# Build new Docker image
cd arcfoundry-context-MCP
docker build -t arcfoundry-context-mcp:latest .

# Push to ECR
aws ecr get-login-password --region us-west-2 | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.us-west-2.amazonaws.com

docker tag arcfoundry-context-mcp:latest \
  <ACCOUNT_ID>.dkr.ecr.us-west-2.amazonaws.com/arcfoundry-context-mcp:latest

docker push <ACCOUNT_ID>.dkr.ecr.us-west-2.amazonaws.com/arcfoundry-context-mcp:latest

# Force new deployment
aws ecs update-service \
  --cluster arcfoundry-prod \
  --service context-mcp \
  --force-new-deployment
```

---

## Step 7: Update Portal API Endpoint

Once deployed, update the portal to use the unified endpoint.

Edit `forge-intent-POC/public/index.html`:

```javascript
// Change this:
const API_ENDPOINTS = [
  'http://localhost:3001/api',
  'https://forge-intent-api.arcfoundry.ai/api',
];

// To this:
const API_ENDPOINTS = [
  'http://localhost:3100/api',
  'https://context.arcfoundry.ai/api',
];
```

The `/api` routes need to be added to context MCP. See next section.

---

## Step 8: Add REST API Routes (for Portal)

The portal uses REST endpoints, not MCP protocol. Add these routes to the Express app in `server.ts`:

```typescript
// ─── Interview REST API (for Portal) ─────────────────────────────

app.post('/api/sessions', async (req, res) => {
  const { projectId, respondentDescription, domainActivity } = req.body;
  const result = await createSession(projectId, respondentDescription, domainActivity);
  res.json(result);
});

app.get('/api/sessions/:sessionId', async (req, res) => {
  const session = await getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.get('/api/sessions/:sessionId/questions', async (req, res) => {
  const result = await getQuestions(req.params.sessionId);
  if (!result) return res.status(404).json({ error: 'Session not found' });
  res.json(result);
});

app.post('/api/sessions/:sessionId/turn', async (req, res) => {
  const result = await runTurn(req.params.sessionId, req.body.responses);
  if (!result) return res.status(404).json({ error: 'Session not found' });
  res.json(result);
});

app.post('/api/sessions/:sessionId/report', async (req, res) => {
  const report = await generateReport(req.params.sessionId);
  if (!report) return res.status(404).json({ error: 'Session not found' });
  res.json(report);
});
```

---

## Verification Checklist

After deployment:

- [ ] `curl https://context.arcfoundry.ai/health` returns `status: ok`
- [ ] MCP tools list shows 20 tools (6 forge + 14 interview)
- [ ] `POST /api/sessions` creates a new interview session
- [ ] Portal at https://arcfoundry-ai.github.io/forge-intent-POC/ connects without demo mode badge
- [ ] Full interview flow completes with Bayesian convergence

---

## Files Reference

| File | Lines | Purpose |
|------|-------|---------|
| `interview-gateway.ts` | 874 | All interview logic + S3 storage |
| `server.ts` (updated) | 495 | MCP tool registrations + REST routes |

---

## Contact

Questions: Joe Tapias (joe@arcfoundry.ai)
