/**
 * DynamoDB Client for Forge Intent Interview Sessions
 *
 * Table: forge-intent-sessions
 * GSI1: OpenClawSessionIndex (lookup by openclawSessionId)
 * GSI2: IntervieweeIndex (lookup by intervieweeId)
 */

import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import type {
  Interview,
  InterviewRecord,
  InterviewSession,
  InterviewSessionRecord,
  CreateInterviewInput,
  AddIntervieweeInput,
  StartSessionInput,
  UpdateSessionStateInput,
  SessionLookupResult,
  InterviewSessionStatus,
} from './dynamodb-types.js';

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const TABLE_NAME = process.env.DYNAMODB_TABLE || 'forge-intent-sessions';
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';

const DEFAULT_CONFIG = {
  timeoutHours: 72,
  reminderSchedule: [24, 48],
  maxLevels: 7,
  convergenceThreshold: 0.85,
};

// ─────────────────────────────────────────────────────────────
// Client Setup
// ─────────────────────────────────────────────────────────────

const dynamoClient = new DynamoDBClient({ region: AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true },
});

// ─────────────────────────────────────────────────────────────
// Key Builders
// ─────────────────────────────────────────────────────────────

const keys = {
  interview: (interviewId: string) => ({
    PK: `INTERVIEW#${interviewId}`,
    SK: 'MANIFEST',
  }),
  session: (interviewId: string, intervieweeId: string) => ({
    PK: `INTERVIEW#${interviewId}`,
    SK: `SESSION#${intervieweeId}`,
  }),
  gsi1: (openclawSessionId: string) => ({
    GSI1PK: `OCSESS#${openclawSessionId}`,
    GSI1SK: 'SESSION',
  }),
  gsi2: (intervieweeId: string, interviewId: string) => ({
    GSI2PK: `INTERVIEWEE#${intervieweeId}`,
    GSI2SK: `INTERVIEW#${interviewId}`,
  }),
};

// ─────────────────────────────────────────────────────────────
// Interview Operations
// ─────────────────────────────────────────────────────────────

export async function createInterview(
  input: CreateInterviewInput
): Promise<Interview> {
  const interviewId = `int_${uuidv4().slice(0, 12)}`;
  const now = new Date().toISOString();

  const interview: Interview = {
    interviewId,
    projectId: input.projectId,
    problemStatement: input.problemStatement,
    status: 'draft',
    totalInterviewees: 0,
    activeInterviewees: 0,
    completedInterviewees: 0,
    convergenceScore: 0,
    rootCauseIdentified: false,
    createdAt: now,
    createdBy: input.employeeId,
    startedAt: null,
    completedAt: null,
    config: { ...DEFAULT_CONFIG, ...input.config },
  };

  const record: InterviewRecord = {
    ...interview,
    ...keys.interview(interviewId),
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
      ConditionExpression: 'attribute_not_exists(PK)',
    })
  );

  return interview;
}

export async function getInterview(
  interviewId: string
): Promise<Interview | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: keys.interview(interviewId),
    })
  );

  if (!result.Item) return null;

  const { PK, SK, ...interview } = result.Item as InterviewRecord;
  return interview as Interview;
}

export async function updateInterviewStatus(
  interviewId: string,
  status: Interview['status'],
  updates?: Partial<Pick<Interview, 'convergenceScore' | 'rootCauseIdentified'>>
): Promise<void> {
  const now = new Date().toISOString();

  let updateExpression = 'SET #status = :status';
  const expressionNames: Record<string, string> = { '#status': 'status' };
  const expressionValues: Record<string, unknown> = { ':status': status };

  if (status === 'active') {
    updateExpression += ', startedAt = :startedAt';
    expressionValues[':startedAt'] = now;
  }

  if (status === 'converged' || status === 'cancelled') {
    updateExpression += ', completedAt = :completedAt';
    expressionValues[':completedAt'] = now;
  }

  if (updates?.convergenceScore !== undefined) {
    updateExpression += ', convergenceScore = :convergenceScore';
    expressionValues[':convergenceScore'] = updates.convergenceScore;
  }

  if (updates?.rootCauseIdentified !== undefined) {
    updateExpression += ', rootCauseIdentified = :rootCauseIdentified';
    expressionValues[':rootCauseIdentified'] = updates.rootCauseIdentified;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.interview(interviewId),
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
    })
  );
}

// ─────────────────────────────────────────────────────────────
// Session Operations
// ─────────────────────────────────────────────────────────────

export async function addInterviewee(
  input: AddIntervieweeInput
): Promise<InterviewSession> {
  const intervieweeId = `user_${uuidv4().slice(0, 12)}`;
  const now = new Date().toISOString();

  // Get interview config
  const interview = await getInterview(input.interviewId);
  if (!interview) {
    throw new Error(`Interview not found: ${input.interviewId}`);
  }

  const session: InterviewSession = {
    interviewId: input.interviewId,
    intervieweeId,
    openclawSessionId: null,
    openclawAgentId: null,
    interviewee: input.interviewee,
    status: 'pending',
    currentLevel: 0,
    problemStatement: interview.problemStatement,
    levelsCompleted: [],
    totalResponsesReceived: 0,
    convergenceScore: 0,
    createdAt: now,
    startedAt: null,
    lastActivityAt: now,
    completedAt: null,
    config: interview.config,
    employeeId: input.employeeId,
    projectId: interview.projectId,
  };

  const record: InterviewSessionRecord = {
    ...session,
    ...keys.session(input.interviewId, intervieweeId),
    ...keys.gsi2(intervieweeId, input.interviewId),
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
    })
  );

  // Update interview counts
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.interview(input.interviewId),
      UpdateExpression: 'SET totalInterviewees = totalInterviewees + :one',
      ExpressionAttributeValues: { ':one': 1 },
    })
  );

  return session;
}

export async function getSession(
  interviewId: string,
  intervieweeId: string
): Promise<InterviewSession | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: keys.session(interviewId, intervieweeId),
    })
  );

  if (!result.Item) return null;

  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ...session } =
    result.Item as InterviewSessionRecord;
  return session as InterviewSession;
}

export async function getSessionByOpenClawId(
  openclawSessionId: string
): Promise<SessionLookupResult | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'OpenClawSessionIndex',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK = :sk',
      ExpressionAttributeValues: {
        ':pk': `OCSESS#${openclawSessionId}`,
        ':sk': 'SESSION',
      },
    })
  );

  if (!result.Items || result.Items.length === 0) return null;

  const record = result.Items[0] as InterviewSessionRecord;
  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ...session } = record;

  // Fetch the parent interview
  const interview = await getInterview(session.interviewId);
  if (!interview) return null;

  return {
    session: session as InterviewSession,
    interview,
  };
}

export async function listSessionsForInterview(
  interviewId: string
): Promise<InterviewSession[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `INTERVIEW#${interviewId}`,
        ':skPrefix': 'SESSION#',
      },
    })
  );

  if (!result.Items) return [];

  return result.Items.map((item) => {
    const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ...session } =
      item as InterviewSessionRecord;
    return session as InterviewSession;
  });
}

export async function startSession(input: StartSessionInput): Promise<void> {
  const now = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.session(input.interviewId, input.intervieweeId),
      UpdateExpression: `
        SET openclawSessionId = :ocSessionId,
            openclawAgentId = :ocAgentId,
            #status = :status,
            currentLevel = :level,
            startedAt = :startedAt,
            lastActivityAt = :lastActivity,
            GSI1PK = :gsi1pk,
            GSI1SK = :gsi1sk
      `,
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':ocSessionId': input.openclawSessionId,
        ':ocAgentId': input.openclawAgentId,
        ':status': 'active',
        ':level': 1,
        ':startedAt': now,
        ':lastActivity': now,
        ':gsi1pk': `OCSESS#${input.openclawSessionId}`,
        ':gsi1sk': 'SESSION',
      },
    })
  );

  // Update interview active count
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.interview(input.interviewId),
      UpdateExpression: `
        SET activeInterviewees = activeInterviewees + :one,
            #status = :status
      `,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':one': 1, ':status': 'active' },
    })
  );
}

export async function updateSessionState(
  input: UpdateSessionStateInput
): Promise<void> {
  const now = new Date().toISOString();

  let updateExpression = 'SET lastActivityAt = :lastActivity';
  const expressionNames: Record<string, string> = {};
  const expressionValues: Record<string, unknown> = {
    ':lastActivity': input.lastActivityAt || now,
  };

  if (input.status) {
    updateExpression += ', #status = :status';
    expressionNames['#status'] = 'status';
    expressionValues[':status'] = input.status;

    if (
      input.status === 'completed' ||
      input.status === 'timed_out' ||
      input.status === 'cancelled'
    ) {
      updateExpression += ', completedAt = :completedAt';
      expressionValues[':completedAt'] = now;
    }
  }

  if (input.currentLevel !== undefined) {
    updateExpression += ', currentLevel = :currentLevel';
    expressionValues[':currentLevel'] = input.currentLevel;
  }

  if (input.convergenceScore !== undefined) {
    updateExpression += ', convergenceScore = :convergenceScore';
    expressionValues[':convergenceScore'] = input.convergenceScore;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.session(input.interviewId, input.intervieweeId),
      UpdateExpression: updateExpression,
      ExpressionAttributeNames:
        Object.keys(expressionNames).length > 0 ? expressionNames : undefined,
      ExpressionAttributeValues: expressionValues,
    })
  );
}

export async function incrementResponseCount(
  interviewId: string,
  intervieweeId: string,
  responseCount: number = 1
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.session(interviewId, intervieweeId),
      UpdateExpression: `
        SET totalResponsesReceived = totalResponsesReceived + :count,
            lastActivityAt = :now
      `,
      ExpressionAttributeValues: {
        ':count': responseCount,
        ':now': new Date().toISOString(),
      },
    })
  );
}

export async function markLevelCompleted(
  interviewId: string,
  intervieweeId: string,
  level: number
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.session(interviewId, intervieweeId),
      UpdateExpression: `
        SET levelsCompleted = list_append(levelsCompleted, :level),
            lastActivityAt = :now
      `,
      ExpressionAttributeValues: {
        ':level': [level],
        ':now': new Date().toISOString(),
      },
    })
  );
}

export async function completeSession(
  interviewId: string,
  intervieweeId: string,
  convergenceScore: number
): Promise<void> {
  const now = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.session(interviewId, intervieweeId),
      UpdateExpression: `
        SET #status = :status,
            completedAt = :completedAt,
            lastActivityAt = :lastActivity,
            convergenceScore = :convergenceScore
      `,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'completed',
        ':completedAt': now,
        ':lastActivity': now,
        ':convergenceScore': convergenceScore,
      },
    })
  );

  // Update interview counts
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.interview(interviewId),
      UpdateExpression: `
        SET activeInterviewees = activeInterviewees - :one,
            completedInterviewees = completedInterviewees + :one
      `,
      ExpressionAttributeValues: { ':one': 1 },
    })
  );
}

// ─────────────────────────────────────────────────────────────
// Table Setup (for local dev / initial deployment)
// ─────────────────────────────────────────────────────────────

export async function ensureTableExists(): Promise<void> {
  try {
    await dynamoClient.send(
      new DescribeTableCommand({ TableName: TABLE_NAME })
    );
    console.log(`DynamoDB table ${TABLE_NAME} exists`);
  } catch (error: unknown) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') {
      console.log(`Creating DynamoDB table ${TABLE_NAME}...`);
      await dynamoClient.send(
        new CreateTableCommand({
          TableName: TABLE_NAME,
          KeySchema: [
            { AttributeName: 'PK', KeyType: 'HASH' },
            { AttributeName: 'SK', KeyType: 'RANGE' },
          ],
          AttributeDefinitions: [
            { AttributeName: 'PK', AttributeType: 'S' },
            { AttributeName: 'SK', AttributeType: 'S' },
            { AttributeName: 'GSI1PK', AttributeType: 'S' },
            { AttributeName: 'GSI1SK', AttributeType: 'S' },
            { AttributeName: 'GSI2PK', AttributeType: 'S' },
            { AttributeName: 'GSI2SK', AttributeType: 'S' },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: 'OpenClawSessionIndex',
              KeySchema: [
                { AttributeName: 'GSI1PK', KeyType: 'HASH' },
                { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
              ],
              Projection: { ProjectionType: 'ALL' },
            },
            {
              IndexName: 'IntervieweeIndex',
              KeySchema: [
                { AttributeName: 'GSI2PK', KeyType: 'HASH' },
                { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
              ],
              Projection: { ProjectionType: 'ALL' },
            },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        })
      );
      console.log(`DynamoDB table ${TABLE_NAME} created`);
    } else {
      throw error;
    }
  }
}

// Export client for direct access if needed
export { docClient, TABLE_NAME };
