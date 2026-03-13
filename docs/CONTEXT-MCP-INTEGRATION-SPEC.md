# Context MCP Integration Specification

## Overview

The Forge Intent POC interview system needs to fetch context from the Context MCP server (`context.arcfoundry.ai`) rather than relying on Claude's internal knowledge.

## Problem Statement

Currently, the interview system generates questions and analyzes responses using hardcoded templates without leveraging the organization's knowledge base stored in the Context MCP server.

## Goals

1. Fetch relevant context from Context MCP when creating interview sessions
2. Use fetched context to generate more targeted questions
3. Enhance convergence reports with context-based recommendations
4. Provide tools to refresh and inspect context status

## Architecture

```
┌─────────────────────────┐     ┌─────────────────────────┐
│  Forge Intent POC       │────▶│  Context MCP Server     │
│  (interview system)     │     │  context.arcfoundry.ai  │
└─────────────────────────┘     └─────────────────────────┘
         │                                │
         │ MCP Protocol                   │ S3 + GitHub
         │ (JSON-RPC over HTTP)           │
         ▼                                ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│  Session Storage        │     │  Context Storage        │
│  (S3: arcfoundry-context│     │  (S3: arcfoundry-context│
│   /forge-intent/...)    │     │   /forge-*/...)         │
└─────────────────────────┘     └─────────────────────────┘
```

## Context MCP Tools Available

| Tool | Description |
|------|-------------|
| `forge_list_domains` | List all context domains with tier counts |
| `forge_get_context` | Read context from domain/tier/topic |
| `forge_search_context` | Search cold-tier context by keyword |

## New Components

### 1. Context Client (`src/mcp-integration/context-client.ts`)

**Purpose**: HTTP client that communicates with Context MCP server using MCP protocol.

**Functions**:
- `isAvailable()` → Check if Context MCP server is reachable
- `listDomains()` → Get all available domains
- `getContext(domain, tier, topic?)` → Fetch specific context
- `searchContext(query, domain?, maxResults?)` → Search context
- `getRelevantContext(domainActivity)` → Fetch context relevant to an activity
- `closeSession()` → Clean up MCP session

**Configuration**:
- `CONTEXT_MCP_URL` env var (default: `https://context.arcfoundry.ai`)

### 2. Session Context Type

```typescript
interface SessionContext {
  searchResults: SearchResult[];  // From context search
  hotContext: Record<string, string>;  // Hot-tier content
  fetchedAt: string;  // ISO timestamp
}
```

### 3. Updated Session Interface

```typescript
interface Session {
  // ... existing fields ...
  context?: SessionContext;  // NEW: Context from Context MCP
}
```

## New MCP Tools

### `interview_refresh_context`

Refreshes context for an existing session from Context MCP server.

**Input**:
```json
{
  "sessionId": "sess-abc123"
}
```

**Output**:
```json
{
  "updated": true
}
```

### `interview_context_status`

Gets the context status for a session.

**Input**:
```json
{
  "sessionId": "sess-abc123"
}
```

**Output**:
```json
{
  "hasContext": true,
  "searchResultCount": 5,
  "hotContextKeys": ["forge-intent/methodology", "forge-phoenix/patterns"],
  "fetchedAt": "2026-03-13T10:30:00Z",
  "contextMCPAvailable": true
}
```

## New REST API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sessions/:id/context/refresh` | Refresh context from Context MCP |
| GET | `/api/sessions/:id/context/status` | Get context status |

## Behavior Changes

### Session Creation

**Before**: Session created with empty context.

**After**:
1. Check if Context MCP is available
2. If available, call `getRelevantContext(domainActivity)`
3. Store context in session
4. Return `contextFetched: true/false` in response

### Question Generation

**Before**: Static CDM question templates.

**After**:
1. Start with base CDM templates
2. If session has context:
   - Round 1: Add question about known patterns from search results
   - Round 2: Ask about specific friction points from context
   - Round 3: Use hot-tier methodology for process questions

### Report Generation

**Before**: Recommendations based only on hypothesis patterns.

**After**:
1. Generate base recommendations
2. If session has context:
   - Search for solutions related to dominant hypothesis
   - Add references to relevant documentation
   - Include methodology links from hot context

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Context MCP unavailable | Continue without context, log warning |
| Context fetch timeout | Continue without context, log warning |
| Context fetch error | Continue without context, log error |
| No search results | Proceed with base questions only |

## Configuration

| Env Variable | Default | Description |
|--------------|---------|-------------|
| `CONTEXT_MCP_URL` | `https://context.arcfoundry.ai` | Context MCP server URL |

## Testing Plan

1. **Unit Tests**:
   - Context client MCP protocol handling
   - Session creation with/without context
   - Question generation with/without context

2. **Integration Tests**:
   - End-to-end with mock Context MCP server
   - Session lifecycle with context refresh

3. **Manual Tests**:
   - Create session with live Context MCP
   - Verify questions reflect context
   - Check report includes context recommendations

## Migration

No data migration required. Existing sessions without context continue to work with base question templates.

## Dependencies

- No new npm packages required
- Uses native `fetch` for HTTP
- MCP protocol is JSON-RPC 2.0 over HTTP

## Files to Create/Modify

### New Files
- `src/mcp-integration/context-client.ts`

### Modified Files
- `src/types.ts` (add SessionContext, ContextSearchResult)
- `src/handlers/session-handlers.ts` (add context fetch, new handlers)
- `src/mcp/tools.ts` (add 2 new tool definitions)
- `src/server.ts` (add new routes and MCP handlers)

## Open Questions

1. Should context be cached or always fetched fresh?
2. What's the timeout for Context MCP calls?
3. Should we retry failed context fetches?
4. How much hot-tier content should we fetch per domain?
