/**
 * S3 Storage Client for Forge Intent MCP
 * Handles hot/warm/cold tier storage
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type {
  Session,
  SessionSummary,
  ActiveSessionsIndex,
  ProjectManifest,
  ConvergenceReport,
} from '../types.js';

const BUCKET_NAME = process.env.S3_BUCKET || 'arcfoundry-context';
const PREFIX = 'forge-intent';

export class ForgeIntentS3Client {
  private s3: S3Client;

  constructor(region: string = 'us-east-1') {
    this.s3 = new S3Client({ region });
  }

  // ─────────────────────────────────────────────────────────────
  // HOT TIER: Active Sessions Index
  // ─────────────────────────────────────────────────────────────

  async getActiveSessionsIndex(): Promise<ActiveSessionsIndex> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `${PREFIX}/hot/active-sessions.json`,
        })
      );
      const body = await response.Body?.transformToString();
      return body ? JSON.parse(body) : this.createEmptyIndex();
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'NoSuchKey') {
        return this.createEmptyIndex();
      }
      throw error;
    }
  }

  async updateActiveSessionsIndex(
    index: ActiveSessionsIndex
  ): Promise<void> {
    index.lastUpdated = new Date().toISOString();
    await this.s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `${PREFIX}/hot/active-sessions.json`,
        Body: JSON.stringify(index, null, 2),
        ContentType: 'application/json',
      })
    );
  }

  async addToActiveIndex(summary: SessionSummary): Promise<void> {
    const index = await this.getActiveSessionsIndex();
    const existing = index.activeSessions.findIndex(
      (s) => s.sessionId === summary.sessionId
    );
    if (existing >= 0) {
      index.activeSessions[existing] = summary;
    } else {
      index.activeSessions.push(summary);
    }
    await this.updateActiveSessionsIndex(index);
  }

  async removeFromActiveIndex(sessionId: string): Promise<void> {
    const index = await this.getActiveSessionsIndex();
    index.activeSessions = index.activeSessions.filter(
      (s) => s.sessionId !== sessionId
    );
    await this.updateActiveSessionsIndex(index);
  }

  private createEmptyIndex(): ActiveSessionsIndex {
    return {
      version: 1,
      lastUpdated: new Date().toISOString(),
      activeSessions: [],
    };
  }

  // ─────────────────────────────────────────────────────────────
  // WARM TIER: Sessions & Reports
  // ─────────────────────────────────────────────────────────────

  async getSession(
    projectId: string,
    sessionId: string
  ): Promise<Session | null> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `${PREFIX}/warm/sessions/${projectId}/${sessionId}.json`,
        })
      );
      const body = await response.Body?.transformToString();
      return body ? JSON.parse(body) : null;
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  async saveSession(session: Session): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `${PREFIX}/warm/sessions/${session.projectId}/${session.id}.json`,
        Body: JSON.stringify(session, null, 2),
        ContentType: 'application/json',
      })
    );

    // Update active index (per-activity)
    await this.addToActiveIndex(this.sessionToSummary(session));

    // Update project manifest
    await this.updateProjectManifest(session.projectId);
  }

  async deleteSession(
    projectId: string,
    sessionId: string
  ): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `${PREFIX}/warm/sessions/${projectId}/${sessionId}.json`,
      })
    );
    await this.removeFromActiveIndex(sessionId);
    await this.updateProjectManifest(projectId);
  }

  async getProjectManifest(projectId: string): Promise<ProjectManifest | null> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `${PREFIX}/warm/sessions/${projectId}/manifest.json`,
        })
      );
      const body = await response.Body?.transformToString();
      return body ? JSON.parse(body) : null;
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  async updateProjectManifest(projectId: string): Promise<void> {
    // List all sessions for the project
    const response = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: `${PREFIX}/warm/sessions/${projectId}/`,
      })
    );

    const sessions: SessionSummary[] = [];
    const hypothesisCounts: Record<string, number> = {};
    let convergedCount = 0;

    for (const obj of response.Contents || []) {
      if (obj.Key?.endsWith('.json') && !obj.Key.endsWith('manifest.json')) {
        const session = await this.getSession(
          projectId,
          obj.Key.split('/').pop()!.replace('.json', '')
        );
        if (session) {
          const summary = this.sessionToSummary(session);
          sessions.push(summary);

          if (session.state === 'CONVERGENCE_REACHED' && session.dominantHypothesis) {
            convergedCount++;
            hypothesisCounts[session.dominantHypothesis] =
              (hypothesisCounts[session.dominantHypothesis] || 0) + 1;
          }
        }
      }
    }

    const manifest: ProjectManifest = {
      projectId,
      totalSessions: sessions.length,
      convergedSessions: convergedCount,
      dominantHypotheses: hypothesisCounts,
      sessions,
      lastUpdated: new Date().toISOString(),
    };

    await this.s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `${PREFIX}/warm/sessions/${projectId}/manifest.json`,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: 'application/json',
      })
    );
  }

  async listProjectSessions(projectId: string): Promise<SessionSummary[]> {
    const manifest = await this.getProjectManifest(projectId);
    return manifest?.sessions || [];
  }

  async saveReport(report: ConvergenceReport): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `${PREFIX}/warm/reports/${report.projectId}/${report.sessionId}-report.json`,
        Body: JSON.stringify(report, null, 2),
        ContentType: 'application/json',
      })
    );
  }

  async getReport(
    projectId: string,
    sessionId: string
  ): Promise<ConvergenceReport | null> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `${PREFIX}/warm/reports/${projectId}/${sessionId}-report.json`,
        })
      );
      const body = await response.Body?.transformToString();
      return body ? JSON.parse(body) : null;
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // COLD TIER: Archives
  // ─────────────────────────────────────────────────────────────

  async archiveSession(session: Session): Promise<string> {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const key = `${PREFIX}/cold/archives/${year}/${month}/${session.projectId}-${session.id}.json`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: JSON.stringify(session, null, 2),
        ContentType: 'application/json',
        StorageClass: 'STANDARD_IA', // Infrequent access
      })
    );

    // Remove from warm tier
    await this.deleteSession(session.projectId, session.id);

    return `s3://${BUCKET_NAME}/${key}`;
  }

  // ─────────────────────────────────────────────────────────────
  // CDM PROMPTS (fetched from S3)
  // ─────────────────────────────────────────────────────────────

  async getCdmRules(): Promise<unknown> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `${PREFIX}/prompts/cdm-rules.json`,
        })
      );
      const body = await response.Body?.transformToString();
      return body ? JSON.parse(body) : null;
    } catch {
      return null;
    }
  }

  async getQuestionTemplates(): Promise<unknown> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `${PREFIX}/prompts/question-templates.json`,
        })
      );
      const body = await response.Body?.transformToString();
      return body ? JSON.parse(body) : null;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  private sessionToSummary(session: Session): SessionSummary {
    return {
      sessionId: session.id,
      projectId: session.projectId,
      state: session.state,
      currentRound: session.currentRound,
      dominantHypothesis: session.dominantHypothesis,
      dominantPosterior: session.dominantPosterior,
      lastActivity: session.lastActivity,
    };
  }
}

export const s3Client = new ForgeIntentS3Client();
