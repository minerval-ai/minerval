#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { NetworkStack } from "../lib/network-stack";
import { DatabaseStack } from "../lib/database-stack";
import { QueueStack } from "../lib/queue-stack";
import { SecretsStack } from "../lib/secrets-stack";
import { ApiStack } from "../lib/api-stack";

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

const network = new NetworkStack(app, "EpistemeNetwork", { env });

const database = new DatabaseStack(app, "EpistemeDatabase", {
  env,
  vpc: network.vpc,
  dbSg: network.dbSg,
});

const queues = new QueueStack(app, "EpistemeQueues", { env });

const secrets = new SecretsStack(app, "EpistemeSecrets", { env });

new ApiStack(app, "EpistemeApi", {
  env,
  vpc: network.vpc,
  albSg: network.albSg,
  apiSg: network.apiSg,
  dbInstance: database.dbInstance,
  dbSecret: database.dbSecret,
  urlExtractionQueue: queues.urlExtractionQueue,
  claimPipelineQueue: queues.claimPipelineQueue,
  openaiApiKeySecret: secrets.openaiApiKeySecret,
  anthropicApiKeySecret: secrets.anthropicApiKeySecret,
  apiKeysSecret: secrets.apiKeysSecret,
  elicitApiKeySecret: secrets.elicitApiKeySecret,
  stripeSecretKeySecret: secrets.stripeSecretKeySecret,
  stripeWebhookSecretSecret: secrets.stripeWebhookSecretSecret,
});
