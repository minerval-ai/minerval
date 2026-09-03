/**
 * Synth-level assertions on LeanCheckerStack. Run with `npm test` in infra/
 * (ts-node over node:test; no extra dependencies).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { NetworkStack } from "../lib/network-stack";
import { LeanCheckerStack } from "../lib/lean-checker-stack";

function synth(): { template: Template; stack: LeanCheckerStack; network: NetworkStack } {
  const app = new cdk.App();
  const env = { account: "111111111111", region: "us-east-1" };
  const network = new NetworkStack(app, "Net", { env });
  const stack = new LeanCheckerStack(app, "Checker", {
    env,
    vpc: network.vpc,
    apiSg: network.apiSg,
    albSg: network.albSg,
    imageDigest: "sha256:deadbeef",
  });
  return { template: Template.fromStack(stack), stack, network };
}

test("the ECR repository expires only untagged images and keeps every pin", () => {
  const { template } = synth();
  template.resourceCountIs("AWS::ECR::Repository", 1);
  template.hasResourceProperties("AWS::ECR::Repository", {
    RepositoryName: "minerval/lean-checker",
    ImageTagMutability: "IMMUTABLE",
  });
  const repo = Object.values(template.findResources("AWS::ECR::Repository"))[0]!;
  const policy = JSON.parse(repo.Properties.LifecyclePolicy.LifecyclePolicyText);
  assert.equal(policy.rules.length, 1);
  assert.equal(policy.rules[0].selection.tagStatus, "untagged");
  assert.equal(repo.DeletionPolicy, "Retain");
});

test("the bearer token is a generated secret injected as LEAN_CHECKER_TOKEN, never plain environment", () => {
  const { template } = synth();
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    Name: "episteme/lean-checker-token",
    GenerateSecretString: Match.objectLike({ PasswordLength: 48 }),
  });
  const taskDefs = Object.values(template.findResources("AWS::ECS::TaskDefinition"));
  assert.equal(taskDefs.length, 2);
  for (const td of taskDefs) {
    const container = td.Properties.ContainerDefinitions[0];
    const envNames = (container.Environment as Array<{ Name: string }>).map((e) => e.Name);
    assert.ok(!envNames.includes("LEAN_CHECKER_TOKEN"));
    const secretNames = (container.Secrets as Array<{ Name: string }>).map((s) => s.Name);
    assert.deepEqual(secretNames, ["LEAN_CHECKER_TOKEN"]);
    assert.equal(container.ReadonlyRootFilesystem, true);
    assert.deepEqual(container.LinuxParameters.Capabilities.Drop, ["ALL"]);
    assert.equal(container.LinuxParameters.InitProcessEnabled, true);
    assert.equal(td.Properties.EphemeralStorage.SizeInGiB, 60);
    assert.ok(envNames.includes("LEAN_CHECKER_IMAGE_DIGEST"));
  }
});

test("the warm lane is 2 vCPU / 16 GB in the isolated subnets; the cold lane is 4 vCPU / 16 GB", () => {
  const { template } = synth();
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    Cpu: "2048",
    Memory: "16384",
    ContainerDefinitions: [
      Match.objectLike({
        Environment: Match.arrayWith([{ Name: "LEAN_CHECKER_LANE", Value: "warm" }]),
      }),
    ],
  });
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    Cpu: "4096",
    Memory: "16384",
    ContainerDefinitions: [
      Match.objectLike({
        Environment: Match.arrayWith([{ Name: "LEAN_CHECKER_LANE", Value: "cold" }]),
      }),
    ],
  });
  template.resourceCountIs("AWS::ECS::Service", 1);
  template.hasResourceProperties("AWS::ECS::Service", {
    DesiredCount: 1,
    LaunchType: "FARGATE",
    NetworkConfiguration: {
      AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "DISABLED" }),
    },
    ServiceRegistries: Match.anyValue(),
  });
  template.hasResourceProperties("AWS::ServiceDiscovery::PrivateDnsNamespace", { Name: "minerval.internal" });
});

test("the checker reaches only the VPC endpoints and S3: no egress to the ALB or API groups, none to any CIDR", () => {
  const { template, stack } = synth();
  const checkerSgLogicalId = stack.getLogicalId(stack.checkerSg.node.defaultChild as cdk.CfnElement);
  const egress = Object.values(template.findResources("AWS::EC2::SecurityGroupEgress")).filter(
    (r) => r.Properties.GroupId?.["Fn::GetAtt"]?.[0] === checkerSgLogicalId
  );
  assert.equal(egress.length, 2, "exactly two egress rules: the endpoints and the S3 prefix list");
  for (const rule of egress) {
    assert.equal(rule.Properties.CidrIp, undefined, "no CIDR egress");
    assert.equal(rule.Properties.CidrIpv6, undefined, "no CIDR egress");
    const dest = rule.Properties.DestinationSecurityGroupId;
    if (dest) {
      // The only security-group destination is the endpoints' own group,
      // which lives in this stack; the ALB and API groups are imports from
      // the network stack and would appear as Fn::ImportValue.
      assert.equal(typeof dest["Fn::GetAtt"]?.[0], "string");
      assert.ok(dest["Fn::GetAtt"][0].includes("LeanCheckerEndpointSg"));
    } else {
      assert.equal(rule.Properties.DestinationPrefixListId, "pl-63a5400a");
    }
    assert.equal(rule.Properties.FromPort, 443);
  }
  // The inline egress on the group itself is only CDK's "disallow all" marker.
  const sg = Object.values(template.findResources("AWS::EC2::SecurityGroup")).find(
    (r) => r.Properties.GroupDescription?.startsWith("Lean checker:")
  )!;
  for (const e of sg.Properties.SecurityGroupEgress ?? []) {
    assert.equal(e.CidrIp, "255.255.255.255/32");
  }
  // Ingress: the API's group only, on the checker port.
  const ingress = Object.values(template.findResources("AWS::EC2::SecurityGroupIngress")).filter(
    (r) => r.Properties.GroupId?.["Fn::GetAtt"]?.[0] === checkerSgLogicalId
  );
  assert.equal(ingress.length, 1);
  assert.equal(ingress[0]!.Properties.FromPort, 8080);
  assert.ok(ingress[0]!.Properties.SourceSecurityGroupId["Fn::ImportValue"]);
});

test("four interface endpoints and one S3 gateway endpoint", () => {
  const { template } = synth();
  const endpoints = Object.values(template.findResources("AWS::EC2::VPCEndpoint"));
  const interfaces = endpoints.filter((e) => e.Properties.VpcEndpointType === "Interface");
  const gateways = endpoints.filter((e) => e.Properties.VpcEndpointType === "Gateway");
  assert.equal(interfaces.length, 4);
  assert.equal(gateways.length, 1);
  const names = interfaces.map((e) => JSON.stringify(e.Properties.ServiceName));
  for (const svc of ["ecr.api", "ecr.dkr", "logs", "secretsmanager"]) {
    assert.ok(names.some((n) => n.includes(svc)), `endpoint for ${svc}`);
  }
  for (const e of interfaces) assert.equal(e.Properties.PrivateDnsEnabled, true);
});

test("exports what the API needs", () => {
  const { stack } = synth();
  assert.equal(stack.serviceUrl, "http://lean-checker.minerval.internal:8080");
  assert.match(stack.pinId, /^mathlib-v4\.\d+\.\d+$/);
  assert.equal(stack.coldSubnetIds.length, 2);
});
