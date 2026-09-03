#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { NetworkStack } from "../lib/network-stack";
import { DatabaseStack } from "../lib/database-stack";
import { QueueStack } from "../lib/queue-stack";
import { SecretsStack } from "../lib/secrets-stack";
import { ApiStack } from "../lib/api-stack";
import { LeanCheckerStack } from "../lib/lean-checker-stack";

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

// The Lean checker (docs/mathematics.md 5.3, 5.8, 13.1): the image tag is
// the pin id from lean-checker/pin.json unless overridden, and the pushed
// image's digest is passed once it exists so verdicts can name it:
//   cdk deploy -c leanCheckerImageDigest=sha256:... [-c leanCheckerImageTag=...] [-c loogleUrl=http://...]
const leanChecker = new LeanCheckerStack(app, "EpistemeLeanChecker", {
  env,
  vpc: network.vpc,
  apiSg: network.apiSg,
  albSg: network.albSg,
  imageTag: app.node.tryGetContext("leanCheckerImageTag"),
  imageDigest: app.node.tryGetContext("leanCheckerImageDigest"),
  loogleUrl: app.node.tryGetContext("loogleUrl"),
});

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
  openrouterApiKeySecret: secrets.openrouterApiKeySecret,
  anthropicApiKeySecret: secrets.anthropicApiKeySecret,
  apiKeysSecret: secrets.apiKeysSecret,
  elicitApiKeySecret: secrets.elicitApiKeySecret,
  stripeSecretKeySecret: secrets.stripeSecretKeySecret,
  stripeWebhookSecretSecret: secrets.stripeWebhookSecretSecret,
  leanChecker: {
    url: leanChecker.serviceUrl,
    tokenSecret: leanChecker.tokenSecret,
    cluster: leanChecker.cluster,
    coldTaskDefinition: leanChecker.coldTaskDefinition,
    securityGroup: leanChecker.checkerSg,
    subnetIds: leanChecker.coldSubnetIds,
  },
});
