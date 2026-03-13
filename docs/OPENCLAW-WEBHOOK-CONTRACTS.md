# OpenClaw Webhook Contracts

**Version:** 1.0
**Date:** 2026-03-13
**Status:** Draft

---

## Overview

Bidirectional webhook communication between Forge Intent and OpenClaw Gateway.

```
┌─────────────────┐                    ┌─────────────────┐
│  Forge Intent   │                    │  OpenClaw       │
│  (Orchestrator) │                    │  (Gateway)      │
│                 │                    │                 │
│  POST /hooks/   │───────────────────▶│  Receives       │
│  interview-*    │                    │  Commands       │
│                 │                    │                 │
│  POST /api/     │◀───────────────────│  Sends          │
│  openclaw/*     │                    │  Callbacks      │
└─────────────────┘                    └─────────────────┘
```

---

## 1. Forge Intent → OpenClaw (Commands)

Base URL: `http://localhost:3100/openclaw/hooks`

All requests include:
```
Authorization: Bearer ${FORGE_INTENT_WEBHOOK_SECRET}
Content-Type: application/json
X-Request-Id: <uuid>
```

---

### 1.1 POST /hooks/interview-start

Start a new interview session for an interviewee.

**Request:**
```json
{
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "interviewee": {
    "name": "Jane Doe",
    "email": "jane@example.com",
    "phone": "+14155551234",
    "slackUserId": "U12345678",
    "preferredChannel": "email"
  },
  "problemStatement": "Users are abandoning checkout at payment step",
  "level": 1,
  "questions": [
    {
      "id": "q1_001",
      "text": "Can you describe a recent time you experienced this issue?",
      "type": "open"
    },
    {
      "id": "q1_002",
      "text": "What were you trying to accomplish when the issue occurred?",
      "type": "open"
    }
  ],
  "session": {
    "timeoutHours": 72,
    "reminderSchedule": [24, 48],
    "escalateAfterReminders": 2,
    "timezone": "America/Los_Angeles"
  },
  "callbackUrl": "https://forge-intent.arcfoundry.ai/api/openclaw/callback",
  "metadata": {
    "employeeId": "emp_001",
    "projectId": "proj_checkout_friction"
  }
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "sessionId": "oc_sess_abc123xyz",
  "agentId": "interviewee-user_xyz789",
  "cronJobs": [
    {
      "id": "cron_reminder_1",
      "type": "reminder",
      "scheduledAt": "2026-03-14T10:00:00-07:00"
    },
    {
      "id": "cron_reminder_2",
      "type": "reminder",
      "scheduledAt": "2026-03-15T10:00:00-07:00"
    },
    {
      "id": "cron_timeout",
      "type": "timeout",
      "scheduledAt": "2026-03-16T10:00:00-07:00"
    }
  ],
  "messageSentAt": "2026-03-13T10:00:00-07:00",
  "channel": "email"
}
```

**Error Response (4xx/5xx):**
```json
{
  "success": false,
  "error": {
    "code": "CHANNEL_UNAVAILABLE",
    "message": "Email channel not configured",
    "details": {}
  }
}
```

---

### 1.2 POST /hooks/interview-continue

Send next level questions to an active interview.

**Request:**
```json
{
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "sessionId": "oc_sess_abc123xyz",
  "level": 2,
  "questions": [
    {
      "id": "q2_001",
      "text": "You mentioned the payment form was confusing. Which specific fields caused the most confusion?",
      "type": "open",
      "context": "Follow-up to L1 response about payment form"
    },
    {
      "id": "q2_002",
      "text": "Did you try any workarounds before giving up?",
      "type": "open"
    }
  ],
  "session": {
    "timeoutHours": 72,
    "reminderSchedule": [24, 48]
  }
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "sessionId": "oc_sess_abc123xyz",
  "cronJobs": [
    {
      "id": "cron_reminder_3",
      "type": "reminder",
      "scheduledAt": "2026-03-14T14:30:00-07:00"
    }
  ],
  "messageSentAt": "2026-03-13T14:30:00-07:00",
  "previousCronJobsCancelled": ["cron_reminder_1", "cron_reminder_2", "cron_timeout"]
}
```

---

### 1.3 POST /hooks/interview-complete

Mark interview as complete, cleanup resources.

**Request:**
```json
{
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "sessionId": "oc_sess_abc123xyz",
  "reason": "root_cause_identified",
  "finalMessage": {
    "send": true,
    "text": "Thank you for participating in this interview! Your insights will help us improve the checkout experience."
  }
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "sessionId": "oc_sess_abc123xyz",
  "status": "completed",
  "cronJobsCancelled": ["cron_reminder_3", "cron_timeout_2"],
  "agentArchived": true,
  "completedAt": "2026-03-15T09:00:00-07:00"
}
```

---

### 1.4 POST /hooks/interview-cancel

Cancel an active interview.

**Request:**
```json
{
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "sessionId": "oc_sess_abc123xyz",
  "reason": "employee_cancelled",
  "notifyInterviewee": false
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "sessionId": "oc_sess_abc123xyz",
  "status": "cancelled",
  "cronJobsCancelled": ["cron_reminder_1", "cron_timeout"],
  "cancelledAt": "2026-03-13T11:00:00-07:00"
}
```

---

## 2. OpenClaw → Forge Intent (Callbacks)

Base URL: `${FORGE_INTENT_CALLBACK_URL}` (configured per interview)

All requests include:
```
Authorization: Bearer ${FORGE_INTENT_WEBHOOK_SECRET}
Content-Type: application/json
X-OpenClaw-Signature: sha256=<hmac_signature>
X-Request-Id: <uuid>
```

---

### 2.1 POST /api/openclaw/callback (type: response)

Interviewee responded to questions.

**Request:**
```json
{
  "type": "response",
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "sessionId": "oc_sess_abc123xyz",
  "level": 1,
  "responses": [
    {
      "questionId": "q1_001",
      "rawText": "yeah so last week i was tryin to buy somethin and the form kept asking for my zip code but i already put it in twice it was super frustrating",
      "receivedAt": "2026-03-13T15:42:00-07:00",
      "channel": "sms",
      "metadata": {
        "messageId": "sms_msg_123"
      }
    },
    {
      "questionId": "q1_002",
      "rawText": "I just wanted to finish checking out quick before my lunch break ended. had like 10 minutes and gave up after 5",
      "receivedAt": "2026-03-13T15:43:00-07:00",
      "channel": "sms",
      "metadata": {
        "messageId": "sms_msg_124"
      }
    }
  ],
  "sessionState": {
    "remindersSent": 0,
    "totalResponseTime": "5h42m",
    "channelUsed": "sms"
  }
}
```

**Response (200 OK):**
```json
{
  "received": true,
  "nextAction": "processing"
}
```

---

### 2.2 POST /api/openclaw/callback (type: partial_response)

Interviewee responded to some questions, still waiting on others.

**Request:**
```json
{
  "type": "partial_response",
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "sessionId": "oc_sess_abc123xyz",
  "level": 2,
  "responses": [
    {
      "questionId": "q2_001",
      "rawText": "The CVV field was the worst - it kept saying invalid but my card works everywhere else",
      "receivedAt": "2026-03-14T10:15:00-07:00",
      "channel": "email"
    }
  ],
  "pendingQuestions": ["q2_002"],
  "sessionState": {
    "remindersSent": 1,
    "lastReminderAt": "2026-03-14T10:00:00-07:00"
  }
}
```

**Response (200 OK):**
```json
{
  "received": true,
  "action": "wait_for_remaining"
}
```

---

### 2.3 POST /api/openclaw/callback (type: timeout)

Interview session timed out without response.

**Request:**
```json
{
  "type": "timeout",
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "sessionId": "oc_sess_abc123xyz",
  "level": 1,
  "timeoutAt": "2026-03-16T10:00:00-07:00",
  "remindersSent": 2,
  "lastReminderAt": "2026-03-15T10:00:00-07:00",
  "partialResponses": [],
  "sessionState": {
    "status": "timed_out",
    "totalWaitTime": "72h"
  }
}
```

**Response (200 OK):**
```json
{
  "received": true,
  "action": "archive"
}
```

---

### 2.4 POST /api/openclaw/callback (type: escalation)

Escalation triggered (reminders exhausted, interviewee unresponsive).

**Request:**
```json
{
  "type": "escalation",
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "sessionId": "oc_sess_abc123xyz",
  "level": 2,
  "escalationReason": "reminders_exhausted",
  "remindersSent": 2,
  "pendingQuestions": ["q2_001", "q2_002"],
  "metadata": {
    "employeeId": "emp_001"
  }
}
```

**Response (200 OK):**
```json
{
  "received": true,
  "action": "notify_employee"
}
```

---

### 2.5 POST /api/openclaw/callback (type: error)

Error occurred in OpenClaw processing.

**Request:**
```json
{
  "type": "error",
  "interviewId": "int_abc123",
  "intervieweeId": "user_xyz789",
  "sessionId": "oc_sess_abc123xyz",
  "error": {
    "code": "CHANNEL_DELIVERY_FAILED",
    "message": "SMS delivery failed after 3 retries",
    "channel": "sms",
    "retryable": false,
    "occurredAt": "2026-03-13T10:05:00-07:00"
  }
}
```

**Response (200 OK):**
```json
{
  "received": true,
  "action": "fallback_channel"
}
```

---

## 3. Error Codes

| Code | Description | Retryable |
|------|-------------|-----------|
| `CHANNEL_UNAVAILABLE` | Requested channel not configured | No |
| `CHANNEL_DELIVERY_FAILED` | Message delivery failed | Maybe |
| `INTERVIEWEE_BLOCKED` | Interviewee blocked/unsubscribed | No |
| `SESSION_NOT_FOUND` | Session ID doesn't exist | No |
| `SESSION_EXPIRED` | Session already timed out | No |
| `RATE_LIMITED` | Too many requests | Yes |
| `INTERNAL_ERROR` | OpenClaw internal error | Yes |

---

## 4. Webhook Security

### HMAC Signature Verification

All OpenClaw → Forge Intent callbacks include `X-OpenClaw-Signature` header.

```typescript
function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return `sha256=${expected}` === signature;
}
```

### Replay Protection

- Include `X-Request-Id` (UUID) in all requests
- Forge Intent should track seen request IDs (TTL: 5 minutes)
- Reject duplicate request IDs

---

## 5. Retry Policy

### Forge Intent → OpenClaw
- Retries: 3
- Backoff: exponential (1s, 2s, 4s)
- Timeout: 30s per request

### OpenClaw → Forge Intent
- Retries: 5
- Backoff: exponential (5s, 15s, 60s, 300s, 900s)
- Timeout: 30s per request
- Dead letter: After 5 failures, store in DLQ and alert

---

## 6. Rate Limits

| Endpoint | Limit |
|----------|-------|
| `/hooks/interview-start` | 100/min |
| `/hooks/interview-continue` | 200/min |
| `/hooks/interview-complete` | 100/min |
| `/api/openclaw/callback` | 500/min |

---

## 7. Environment Variables

### Forge Intent
```env
OPENCLAW_BASE_URL=http://localhost:3100/openclaw
FORGE_INTENT_WEBHOOK_SECRET=<shared-secret>
FORGE_INTENT_URL=https://forge-intent.arcfoundry.ai
```

### OpenClaw
```env
FORGE_INTENT_WEBHOOK_SECRET=<shared-secret>
FORGE_INTENT_URL=https://forge-intent.arcfoundry.ai
```
