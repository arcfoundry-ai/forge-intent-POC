# Forge Intent Engine — AWS Deployment Guide

> Step-by-step deployment instructions for the DEV team

## Prerequisites

- AWS CLI configured with production credentials
- Docker installed
- Access to `arcfoundry-context` S3 bucket
- GitHub PAT with repo access (for audit trail)

---

## Part 1: Backend API Deployment

### 1.1 Create ECR Repository

```bash
aws ecr create-repository \
  --repository-name forge-intent-engine \
  --region us-west-2 \
  --image-scanning-configuration scanOnPush=true

# Note the repositoryUri from output:
# <ACCOUNT_ID>.dkr.ecr.us-west-2.amazonaws.com/forge-intent-engine
```

### 1.2 Create Dockerfile

The Dockerfile should be at the repo root:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/public ./public
EXPOSE 3001
CMD ["node", "dist/server.js"]
```

### 1.3 Build and Push Docker Image

```bash
cd forge-intent-POC

# Build
npm install
npm run build
docker build -t forge-intent-engine:latest .

# Login to ECR
aws ecr get-login-password --region us-west-2 | \
  docker login --username AWS --password-stdin \
  <ACCOUNT_ID>.dkr.ecr.us-west-2.amazonaws.com

# Tag and push
docker tag forge-intent-engine:latest \
  <ACCOUNT_ID>.dkr.ecr.us-west-2.amazonaws.com/forge-intent-engine:latest

docker push <ACCOUNT_ID>.dkr.ecr.us-west-2.amazonaws.com/forge-intent-engine:latest
```

### 1.4 Create IAM Task Role

Create `forge-intent-task-role` with this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3Access",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::arcfoundry-context",
        "arn:aws:s3:::arcfoundry-context/forge-intent/*"
      ]
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:us-west-2:*:log-group:/ecs/forge-intent-engine:*"
    }
  ]
}
```

Trust relationship:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ecs-tasks.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### 1.5 Store GitHub Token in Secrets Manager

```bash
aws secretsmanager create-secret \
  --name forge-intent/github-token \
  --secret-string "ghp_YOUR_GITHUB_PAT_HERE" \
  --region us-west-2
```

### 1.6 Create CloudWatch Log Group

```bash
aws logs create-log-group \
  --log-group-name /ecs/forge-intent-engine \
  --region us-west-2
```

### 1.7 Register ECS Task Definition

Save as `task-definition.json`:

```json
{
  "family": "forge-intent-engine",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/forge-intent-task-role",
  "containerDefinitions": [
    {
      "name": "forge-intent-engine",
      "image": "<ACCOUNT_ID>.dkr.ecr.us-west-2.amazonaws.com/forge-intent-engine:latest",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 3001,
          "protocol": "tcp"
        }
      ],
      "environment": [
        { "name": "AWS_REGION", "value": "us-west-2" },
        { "name": "CONTEXT_BUCKET", "value": "arcfoundry-context" },
        { "name": "PORT", "value": "3001" },
        { "name": "GITHUB_OWNER", "value": "arcfoundry-ai" },
        { "name": "GITHUB_REPO", "value": "arcfoundry-context-MCP" }
      ],
      "secrets": [
        {
          "name": "GITHUB_TOKEN",
          "valueFrom": "arn:aws:secretsmanager:us-west-2:<ACCOUNT_ID>:secret:forge-intent/github-token"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/forge-intent-engine",
          "awslogs-region": "us-west-2",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "wget -q -O - http://localhost:3001/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
```

Register it:
```bash
aws ecs register-task-definition --cli-input-json file://task-definition.json
```

### 1.8 Create Target Group

```bash
aws elbv2 create-target-group \
  --name forge-intent-tg \
  --protocol HTTP \
  --port 3001 \
  --vpc-id vpc-YOUR_VPC_ID \
  --target-type ip \
  --health-check-path /health \
  --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3

# Note the TargetGroupArn from output
```

### 1.9 Create ECS Service

```bash
aws ecs create-service \
  --cluster arcfoundry-prod \
  --service-name forge-intent-engine \
  --task-definition forge-intent-engine:1 \
  --desired-count 2 \
  --launch-type FARGATE \
  --platform-version LATEST \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-PRIVATE_1,subnet-PRIVATE_2],securityGroups=[sg-YOUR_SG],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:us-west-2:<ACCOUNT_ID>:targetgroup/forge-intent-tg/xxx,containerName=forge-intent-engine,containerPort=3001" \
  --health-check-grace-period-seconds 120
```

### 1.10 Add ALB Listener Rule

```bash
# Get ALB listener ARN first
aws elbv2 describe-listeners \
  --load-balancer-arn arn:aws:elasticloadbalancing:us-west-2:<ACCOUNT_ID>:loadbalancer/app/arcfoundry-alb/xxx

# Create rule for forge-intent-api.arcfoundry.ai
aws elbv2 create-rule \
  --listener-arn arn:aws:elasticloadbalancing:us-west-2:<ACCOUNT_ID>:listener/app/arcfoundry-alb/xxx/yyy \
  --priority 20 \
  --conditions Field=host-header,Values=forge-intent-api.arcfoundry.ai \
  --actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:us-west-2:<ACCOUNT_ID>:targetgroup/forge-intent-tg/xxx
```

### 1.11 Create Route53 DNS Record

```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id YOUR_HOSTED_ZONE_ID \
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

## Part 2: Verify Deployment

### 2.1 Check ECS Service Status

```bash
aws ecs describe-services \
  --cluster arcfoundry-prod \
  --services forge-intent-engine \
  --query 'services[0].{status:status,running:runningCount,desired:desiredCount}'
```

Expected output:
```json
{
  "status": "ACTIVE",
  "running": 2,
  "desired": 2
}
```

### 2.2 Test Health Endpoint

```bash
curl https://forge-intent-api.arcfoundry.ai/health
```

Expected response:
```json
{"status":"ok","service":"forge-intent-poc","version":"0.1.0"}
```

### 2.3 Test MCP Tools Endpoint

```bash
curl https://forge-intent-api.arcfoundry.ai/api/mcp/tools | jq '.tools | length'
```

Expected output: `14`

### 2.4 Test Create Session

```bash
curl -X POST https://forge-intent-api.arcfoundry.ai/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "test-deployment",
    "respondentDescription": "DevOps Engineer",
    "domainActivity": "deployment verification"
  }'
```

Expected response includes `sessionId` field.

---

## Part 3: Portal Configuration

The portal is already deployed to GitHub Pages. Once the API is live:

1. Portal auto-detects API at `https://forge-intent-api.arcfoundry.ai/api`
2. No code changes needed - the URL is already configured in `public/index.html`

### Verify Portal

1. Visit: https://arcfoundry-ai.github.io/forge-intent-POC/
2. Start a new interview
3. Verify it connects to production API (check Network tab)

---

## Part 4: Updating Deployments

### Update Application Code

```bash
# 1. Build new image
cd forge-intent-POC
npm run build
docker build -t forge-intent-engine:latest .

# 2. Push to ECR
docker tag forge-intent-engine:latest \
  <ACCOUNT_ID>.dkr.ecr.us-west-2.amazonaws.com/forge-intent-engine:latest
docker push <ACCOUNT_ID>.dkr.ecr.us-west-2.amazonaws.com/forge-intent-engine:latest

# 3. Force new deployment
aws ecs update-service \
  --cluster arcfoundry-prod \
  --service forge-intent-engine \
  --force-new-deployment
```

### Monitor Deployment

```bash
# Watch tasks drain/start
aws ecs describe-services \
  --cluster arcfoundry-prod \
  --services forge-intent-engine \
  --query 'services[0].deployments'
```

---

## Part 5: Troubleshooting

### Check Container Logs

```bash
# Get task ARN
TASK_ARN=$(aws ecs list-tasks \
  --cluster arcfoundry-prod \
  --service-name forge-intent-engine \
  --query 'taskArns[0]' \
  --output text)

# Get container logs
aws logs get-log-events \
  --log-group-name /ecs/forge-intent-engine \
  --log-stream-name "ecs/forge-intent-engine/$(echo $TASK_ARN | cut -d'/' -f3)" \
  --limit 50
```

### Common Issues

| Issue | Solution |
|-------|----------|
| Tasks failing health check | Check `/health` endpoint, verify port 3001 |
| S3 access denied | Verify task role has `forge-intent/*` permissions |
| Cannot reach API | Check security group allows ALB traffic |
| DNS not resolving | Wait 5-10 min for Route53 propagation |

### Rollback

```bash
# Find previous task definition revision
aws ecs list-task-definitions \
  --family-prefix forge-intent-engine \
  --sort DESC

# Update service to previous revision
aws ecs update-service \
  --cluster arcfoundry-prod \
  --service forge-intent-engine \
  --task-definition forge-intent-engine:PREVIOUS_REVISION
```

---

## Appendix: Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | HTTP server port |
| `AWS_REGION` | No | `us-west-2` | AWS region |
| `CONTEXT_BUCKET` | No | `arcfoundry-context` | S3 bucket name |
| `GITHUB_OWNER` | No | `arcfoundry-ai` | GitHub org for audit |
| `GITHUB_REPO` | No | `arcfoundry-context-MCP` | Repo for audit trail |
| `GITHUB_TOKEN` | Yes* | - | PAT for GitHub commits |

*Required if GitHub audit trail is enabled

---

## Appendix: Security Checklist

- [ ] Task role follows least privilege (only forge-intent/* in S3)
- [ ] Secrets Manager used for GitHub token (not env vars)
- [ ] Security group only allows traffic from ALB
- [ ] HTTPS enforced on ALB listener
- [ ] No public IP on ECS tasks
- [ ] CloudWatch logs enabled

---

## Contact

For deployment issues, reach out to:
- **Slack**: #forge-platform
- **Email**: platform@arcfoundry.ai
