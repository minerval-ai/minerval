import * as cdk from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export class SecretsStack extends cdk.Stack {
  public readonly openaiApiKeySecret: secretsmanager.Secret;
  public readonly openrouterApiKeySecret: secretsmanager.Secret;
  public readonly anthropicApiKeySecret: secretsmanager.Secret;
  public readonly apiKeysSecret: secretsmanager.Secret;
  public readonly elicitApiKeySecret: secretsmanager.Secret;
  public readonly stripeSecretKeySecret: secretsmanager.Secret;
  public readonly stripeWebhookSecretSecret: secretsmanager.Secret;
  public readonly githubTokenSecret: secretsmanager.Secret;
  public readonly githubAppPrivateKeySecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.openaiApiKeySecret = new secretsmanager.Secret(
      this,
      "OpenaiApiKeySecret",
      {
        secretName: "episteme/openai-api-key",
        description:
          "OpenAI API key for Episteme embeddings. Must be manually populated after deploy.",
      }
    );

    // OpenRouter (#257): the "vendor/model" provider. Until the real key is
    // populated this holds a CDK-generated placeholder; nothing routes to
    // OpenRouter unless an agent's *_MODEL env var is pointed at a
    // vendor/model ID, so the placeholder is inert.
    this.openrouterApiKeySecret = new secretsmanager.Secret(
      this,
      "OpenrouterApiKeySecret",
      {
        secretName: "episteme/openrouter-api-key",
        description:
          "OpenRouter API key for LLM inference (#257). Must be manually populated after deploy.",
      }
    );

    this.anthropicApiKeySecret = new secretsmanager.Secret(
      this,
      "AnthropicApiKeySecret",
      {
        secretName: "episteme/anthropic-api-key",
        description:
          "Anthropic API key for LLM inference. Must be manually populated after deploy.",
      }
    );

    // Operator API keys for the Episteme API itself (#70): comma-separated
    // "key" or "key:contributor_external_id" entries. These are the service-
    // trusted keys (e.g. the web frontend's BFF key, which must match
    // EPISTEME_API_KEY in Vercel) — end-user keys are DB-backed and minted
    // from the dashboard. The API fails closed in production without this.
    // Elicit connector for the Claim Steward (#299). Until the real key is
    // populated this holds a CDK-generated placeholder, which fails Elicit
    // tool discovery — the Steward's toolset then omits the elicit_* tools,
    // so the connector stays effectively off until opted in.
    this.elicitApiKeySecret = new secretsmanager.Secret(
      this,
      "ElicitApiKeySecret",
      {
        secretName: "episteme/elicit-api-key",
        description:
          "Elicit API key for Steward scholarly search (#299). Must be manually populated after deploy.",
      }
    );

    // Stripe (#309). Like the Elicit key, these hold CDK-generated
    // placeholders until populated — and a placeholder deliberately keeps
    // payments OFF: the billing provider only activates when the secret key
    // looks like a real "sk_…" value (see stripeConfigured() in
    // src/services/billing-service.ts). Populate with the live secret key and
    // the webhook-endpoint signing secret ("whsec_…") from the Stripe
    // dashboard, then force a new service deployment.
    this.stripeSecretKeySecret = new secretsmanager.Secret(
      this,
      "StripeSecretKeySecret",
      {
        secretName: "episteme/stripe-secret-key",
        description:
          "Stripe API secret key (sk_…) for credit purchases (#309). " +
          "Placeholder = payments disabled. Must be manually populated.",
      }
    );

    this.stripeWebhookSecretSecret = new secretsmanager.Secret(
      this,
      "StripeWebhookSecretSecret",
      {
        secretName: "episteme/stripe-webhook-secret",
        description:
          "Stripe webhook signing secret (whsec_…) for POST /billing/webhook " +
          "(#309). Must be manually populated after creating the webhook " +
          "endpoint in the Stripe dashboard.",
      }
    );

    // GitHub issue filing for agent reports (#366): the raise_issue channel's
    // far end. Production writes as the minerval-agents GitHub App (below);
    // this plain-token slot is the alternative, a fine-grained PAT with
    // Issues: read/write on GITHUB_ISSUES_REPO, and is ignored while the App
    // is configured. It holds a CDK-generated placeholder.
    this.githubTokenSecret = new secretsmanager.Secret(
      this,
      "GithubTokenSecret",
      {
        secretName: "episteme/github-token",
        description:
          "GitHub token with Issues read/write on the agent-reports repo " +
          "(#366). Must be manually populated after deploy.",
      }
    );

    // The minerval-agents GitHub App's private key (src/services/
    // github-app-auth.ts exchanges it for hourly installation tokens). Unlike
    // the placeholders above this secret is imported, not created: it was
    // populated by hand on 2026-09-11 before the stack knew of it, and
    // CloudFormation must not try to create the name. The app id and the
    // installation id are not secrets and sit in the API task's environment.
    this.githubAppPrivateKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "GithubAppPrivateKeySecret",
      "episteme/github-app-private-key"
    );

    this.apiKeysSecret = new secretsmanager.Secret(this, "ApiKeysSecret", {
      secretName: "episteme/api-keys",
      description:
        "Comma-separated operator keys for the Episteme API (API_KEYS env). " +
        "Must be manually populated after deploy.",
    });
  }
}
