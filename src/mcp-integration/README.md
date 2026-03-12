# MCP Integration for ArcFoundry Context MCP

This directory contains the interview gateway code designed to be merged into `arcfoundry-ai/arcfoundry-context-MCP`.

## Files

- `interview-gateway.ts` - 14 MCP tools for CDM interview system

## Integration Instructions

1. Copy `interview-gateway.ts` to `arcfoundry-context-MCP/server/src/`
2. Update `server.ts` to import and register interview tools
3. Add `uuid` dependency to `package.json`

## Tool Summary

| Category | Tools |
|----------|-------|
| Session Management | `interview_create_session`, `interview_get_session`, `interview_list_sessions`, `interview_delete_session` |
| Execution | `interview_get_questions`, `interview_submit_response`, `interview_run_turn`, `interview_advance_round` |
| Analysis | `interview_check_convergence`, `interview_generate_report`, `interview_run_gate_c`, `interview_analyze_project` |
| Lifecycle | `interview_handoff`, `interview_terminate` |

## S3 Storage Structure

```
s3://arcfoundry-context/forge-intent/
├── warm/sessions/{projectId}/{sessionId}.json
└── cold/archives/{year}/{month}/{projectId}-{sessionId}.json
```
