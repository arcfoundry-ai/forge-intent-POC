/**
 * Forge Intent POC - Main Entry Point
 */

export * from './types.js';
export * from './handlers/session-handlers.js';
export * from './handlers/execution-handlers.js';
export * from './handlers/analysis-handlers.js';
export * from './handlers/lifecycle-handlers.js';
export * from './mcp/tools.js';
export { s3Client, ForgeIntentS3Client } from './storage/s3-client.js';
