# S3 Interview Data Structure

**Version:** 1.0
**Date:** 2026-03-13
**Status:** Draft

---

## Overview

Interview DATA is stored separately from Context (methodology). This document defines the S3 bucket structure for interview data.

| Bucket | Purpose | Access |
|--------|---------|--------|
| `arcfoundry-context` | Methodology, patterns, rules | Context MCP (read-only) |
| `arcfoundry-interview-data` | Interview Q&A, responses | Forge Intent (read/write) |

**Principle:** Interview data must NEVER contaminate context. Separate buckets enforce this boundary.

---

## Bucket: arcfoundry-interview-data

### Prefix Structure

```
arcfoundry-interview-data/
├── interviews/
│   └── {interviewId}/
│       ├── manifest.json              # Interview metadata
│       ├── levels/
│       │   ├── L1/
│       │   │   ├── questions.json     # Generated questions
│       │   │   └── {intervieweeId}/
│       │   │       ├── response-raw.json
│       │   │       ├── response-corrected.json
│       │   │       └── analysis.json
│       │   ├── L2/
│       │   │   └── {intervieweeId}/
│       │   │       ├── questions.json  # Custom questions (per interviewee)
│       │   │       ├── response-raw.json
│       │   │       ├── response-corrected.json
│       │   │       └── analysis.json
│       │   └── L{N}/...
│       ├── convergence/
│       │   ├── summary.json           # Final root cause analysis
│       │   └── figjam-export.json     # Data pushed to FigJam
│       └── audit/
│           └── events.jsonl           # Append-only audit log
│
├── interviewees/
│   └── {intervieweeId}/
│       ├── profile.json               # Contact info, preferences
│       └── history/
│           └── {interviewId}.json     # Reference to interview participation
│
└── exports/
    └── {exportId}/
        ├── manifest.json
        └── data.json                  # Aggregated export for FigJam/reporting
```

---

## Object Schemas

### interviews/{interviewId}/manifest.json

```json
{
  "interviewId": "int_abc123",
  "projectId": "proj_checkout_friction",
  "problemStatement": "Users are abandoning checkout at payment step",
  "status": "in_progress",
  "createdAt": "2026-03-13T10:00:00Z",
  "createdBy": "emp_001",
  "interviewees": [
    {
      "intervieweeId": "user_xyz789",
      "status": "active",
      "currentLevel": 2,
      "joinedAt": "2026-03-13T10:00:00Z"
    },
    {
      "intervieweeId": "user_abc456",
      "status": "completed",
      "currentLevel": 4,
      "joinedAt": "2026-03-13T10:00:00Z",
      "completedAt": "2026-03-15T14:00:00Z"
    }
  ],
  "config": {
    "maxLevels": 7,
    "convergenceThreshold": 0.85,
    "timeoutHours": 72,
    "reminderSchedule": [24, 48]
  },
  "metrics": {
    "totalResponses": 12,
    "avgResponseTime": "6h32m",
    "convergenceScore": 0.72
  }
}
```

---

### interviews/{interviewId}/levels/L1/questions.json

Level 1 questions are shared across all interviewees.

```json
{
  "interviewId": "int_abc123",
  "level": 1,
  "generatedAt": "2026-03-13T10:00:00Z",
  "generatedBy": "forge-intent",
  "methodologyVersion": "cdm-v2.1",
  "questions": [
    {
      "id": "q1_001",
      "text": "Can you describe a recent time you experienced this issue?",
      "type": "open",
      "cdmPhase": "incident_identification",
      "expectedInsights": ["timeline", "context", "initial_impact"]
    },
    {
      "id": "q1_002",
      "text": "What were you trying to accomplish when the issue occurred?",
      "type": "open",
      "cdmPhase": "goal_clarification",
      "expectedInsights": ["user_goal", "task_context"]
    }
  ]
}
```

---

### interviews/{interviewId}/levels/L{N}/{intervieweeId}/questions.json

Level 2+ questions are custom per interviewee.

```json
{
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "level": 2,
  "generatedAt": "2026-03-13T16:00:00Z",
  "basedOnLevel": 1,
  "questions": [
    {
      "id": "q2_001",
      "text": "You mentioned the payment form was confusing. Which specific fields caused the most confusion?",
      "type": "open",
      "cdmPhase": "deep_dive",
      "derivedFrom": {
        "questionId": "q1_001",
        "responseSnippet": "the form kept asking for my zip code"
      }
    }
  ]
}
```

---

### interviews/{interviewId}/levels/L{N}/{intervieweeId}/response-raw.json

Raw response from interviewee (via OpenClaw).

```json
{
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "level": 1,
  "receivedAt": "2026-03-13T15:43:00Z",
  "openclawSessionId": "oc_sess_abc123xyz",
  "channel": "sms",
  "responses": [
    {
      "questionId": "q1_001",
      "rawText": "yeah so last week i was tryin to buy somethin and the form kept asking for my zip code but i already put it in twice it was super frustrating",
      "receivedAt": "2026-03-13T15:42:00Z",
      "metadata": {
        "messageId": "sms_msg_123",
        "wordCount": 32
      }
    },
    {
      "questionId": "q1_002",
      "rawText": "I just wanted to finish checking out quick before my lunch break ended. had like 10 minutes and gave up after 5",
      "receivedAt": "2026-03-13T15:43:00Z",
      "metadata": {
        "messageId": "sms_msg_124",
        "wordCount": 22
      }
    }
  ],
  "sessionMetrics": {
    "responseTime": "5h42m",
    "remindersSent": 0
  }
}
```

---

### interviews/{interviewId}/levels/L{N}/{intervieweeId}/response-corrected.json

Grammar-corrected response (processed by Forge Intent).

```json
{
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "level": 1,
  "processedAt": "2026-03-13T15:45:00Z",
  "processor": "forge-intent",
  "model": "claude-sonnet-4-5",
  "responses": [
    {
      "questionId": "q1_001",
      "rawText": "yeah so last week i was tryin to buy somethin and the form kept asking for my zip code but i already put it in twice it was super frustrating",
      "correctedText": "Last week, I was trying to buy something, and the form kept asking for my zip code. I had already entered it twice, which was very frustrating.",
      "corrections": [
        {"type": "capitalization", "count": 3},
        {"type": "punctuation", "count": 4},
        {"type": "spelling", "count": 2}
      ],
      "preservedMeaning": true
    },
    {
      "questionId": "q1_002",
      "rawText": "I just wanted to finish checking out quick before my lunch break ended. had like 10 minutes and gave up after 5",
      "correctedText": "I just wanted to finish checking out quickly before my lunch break ended. I had about 10 minutes and gave up after 5.",
      "corrections": [
        {"type": "grammar", "count": 2},
        {"type": "capitalization", "count": 1}
      ],
      "preservedMeaning": true
    }
  ]
}
```

---

### interviews/{interviewId}/levels/L{N}/{intervieweeId}/analysis.json

Analysis of response for next-level question generation.

```json
{
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "level": 1,
  "analyzedAt": "2026-03-13T15:46:00Z",
  "analyzer": "forge-intent",
  "model": "claude-sonnet-4-5",
  "insights": [
    {
      "id": "ins_001",
      "category": "friction_point",
      "text": "Duplicate zip code entry requirement",
      "confidence": 0.92,
      "sourceQuestionId": "q1_001",
      "sourceSnippet": "form kept asking for my zip code but i already put it in twice"
    },
    {
      "id": "ins_002",
      "category": "time_pressure",
      "text": "User had limited time (10 minutes), abandoned after 5",
      "confidence": 0.95,
      "sourceQuestionId": "q1_002",
      "sourceSnippet": "had like 10 minutes and gave up after 5"
    }
  ],
  "cdmPhaseProgress": {
    "incident_identification": "complete",
    "goal_clarification": "complete",
    "deep_dive": "pending",
    "root_cause": "pending"
  },
  "convergenceScore": 0.35,
  "recommendedNextPhase": "deep_dive",
  "suggestedProbes": [
    "Explore the specific form fields causing confusion",
    "Investigate if this is device-specific (mobile vs desktop)",
    "Clarify if error messages were shown"
  ]
}
```

---

### interviews/{interviewId}/convergence/summary.json

Final convergence summary when root cause identified.

```json
{
  "interviewId": "int_abc123",
  "completedAt": "2026-03-16T10:00:00Z",
  "problemStatement": "Users are abandoning checkout at payment step",
  "rootCause": {
    "primary": "Payment form zip code validation fires prematurely, marking field as invalid before user finishes typing",
    "confidence": 0.94,
    "category": "ux_validation",
    "evidence": [
      {
        "intervieweeId": "user_xyz789",
        "level": 3,
        "snippet": "it turns red before I even finish typing"
      },
      {
        "intervieweeId": "user_abc456",
        "level": 2,
        "snippet": "validation error appears immediately"
      }
    ]
  },
  "contributingFactors": [
    {
      "factor": "Time pressure amplifies frustration",
      "confidence": 0.78
    },
    {
      "factor": "Mobile keyboard auto-correct interferes",
      "confidence": 0.65
    }
  ],
  "recommendations": [
    "Implement debounced validation (wait 500ms after last keystroke)",
    "Show validation only on blur, not on input",
    "Add clear error messages with correction hints"
  ],
  "intervieweeCount": 5,
  "totalResponses": 23,
  "averageLevels": 3.4,
  "convergenceAchievedAt": "level_3"
}
```

---

### interviewees/{intervieweeId}/profile.json

```json
{
  "intervieweeId": "user_xyz789",
  "name": "Jane Doe",
  "contact": {
    "email": "jane@example.com",
    "phone": "+14155551234",
    "slackUserId": "U12345678"
  },
  "preferences": {
    "preferredChannel": "email",
    "timezone": "America/Los_Angeles",
    "language": "en"
  },
  "createdAt": "2026-03-13T10:00:00Z",
  "lastActiveAt": "2026-03-15T14:00:00Z",
  "interviewCount": 3
}
```

---

### audit/events.jsonl

Append-only audit log (JSON Lines format).

```jsonl
{"ts":"2026-03-13T10:00:00Z","event":"interview.created","interviewId":"int_abc123","actor":"emp_001"}
{"ts":"2026-03-13T10:00:05Z","event":"questions.generated","interviewId":"int_abc123","level":1}
{"ts":"2026-03-13T10:00:10Z","event":"openclaw.session_started","interviewId":"int_abc123","intervieweeId":"user_xyz789","sessionId":"oc_sess_abc123xyz"}
{"ts":"2026-03-13T15:43:00Z","event":"response.received","interviewId":"int_abc123","intervieweeId":"user_xyz789","level":1}
{"ts":"2026-03-13T15:45:00Z","event":"response.corrected","interviewId":"int_abc123","intervieweeId":"user_xyz789","level":1}
{"ts":"2026-03-13T15:46:00Z","event":"analysis.completed","interviewId":"int_abc123","intervieweeId":"user_xyz789","level":1,"convergenceScore":0.35}
```

---

## Access Patterns

| Operation | Path Pattern | Frequency |
|-----------|--------------|-----------|
| Create interview | `interviews/{id}/manifest.json` | Low |
| Store L1 questions | `interviews/{id}/levels/L1/questions.json` | Low |
| Store response | `interviews/{id}/levels/L{n}/{userId}/response-raw.json` | Medium |
| Get all responses for level | `interviews/{id}/levels/L{n}/*/response-corrected.json` | Medium |
| Get interviewee history | `interviewees/{id}/history/*` | Low |
| Append audit event | `interviews/{id}/audit/events.jsonl` | High |
| Export for FigJam | `exports/{id}/data.json` | Low |

---

## Lifecycle & Retention

| Object Type | Retention | Lifecycle Action |
|-------------|-----------|------------------|
| Active interview | Indefinite | None |
| Completed interview | 2 years | Move to Glacier |
| Cancelled interview | 90 days | Delete |
| Audit logs | 7 years | Move to Glacier Deep Archive |
| Exports | 1 year | Delete |

---

## IAM Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ForgeIntentReadWrite",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/forge-intent-ecs-task"
      },
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::arcfoundry-interview-data",
        "arn:aws:s3:::arcfoundry-interview-data/*"
      ]
    },
    {
      "Sid": "DenyContextMCPAccess",
      "Effect": "Deny",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/context-mcp-lambda"
      },
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::arcfoundry-interview-data",
        "arn:aws:s3:::arcfoundry-interview-data/*"
      ]
    }
  ]
}
```

---

## Encryption

- **At rest:** SSE-S3 (AES-256)
- **In transit:** HTTPS only (bucket policy enforces)
- **PII fields:** Client-side encryption for `interviewees/*/profile.json`

---

## Bucket Configuration

```bash
aws s3api create-bucket \
  --bucket arcfoundry-interview-data \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

aws s3api put-bucket-versioning \
  --bucket arcfoundry-interview-data \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket arcfoundry-interview-data \
  --server-side-encryption-configuration '{
    "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]
  }'

aws s3api put-public-access-block \
  --bucket arcfoundry-interview-data \
  --public-access-block-configuration '{
    "BlockPublicAcls": true,
    "IgnorePublicAcls": true,
    "BlockPublicPolicy": true,
    "RestrictPublicBuckets": true
  }'
```
