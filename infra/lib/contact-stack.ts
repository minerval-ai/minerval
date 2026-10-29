import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ses from "aws-cdk-lib/aws-ses";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface ContactStackProps extends cdk.StackProps {
  // The domain the contact form sends from (CONTACT_FROM_EMAIL's domain).
  domain: string;
}

// Delivery for the minerval.ai /about contact form (issue #81). The Next.js
// app runs on Vercel, outside AWS, so it reaches SES with a dedicated IAM
// user that can only send from this domain's identity.
//
// The minerval.ai zone lives on Cloudflare, not Route 53, so CDK cannot
// publish the DKIM records itself: after deploy, add the three CNAMEs from
// the DkimRecord outputs in Cloudflare (DNS only, not proxied) and wait for
// the identity to verify. The access key is written to Secrets Manager, never
// to a stack output; copy it into Vercel from there. See
// docs/infrastructure.md.
export class ContactStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ContactStackProps) {
    super(scope, id, props);

    const identity = new ses.EmailIdentity(this, "DomainIdentity", {
      identity: ses.Identity.domain(props.domain),
    });

    const sender = new iam.User(this, "ContactSender", {
      userName: "minerval-contact-sender",
    });
    sender.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: [identity.emailIdentityArn],
      })
    );

    const accessKey = new iam.AccessKey(this, "ContactSenderKey", { user: sender });
    new secretsmanager.Secret(this, "ContactSenderCredentials", {
      secretName: "minerval/contact-sender",
      description:
        "AWS access key for the Vercel contact form (/api/contact): set as " +
        "CONTACT_AWS_ACCESS_KEY_ID / CONTACT_AWS_SECRET_ACCESS_KEY in Vercel.",
      secretObjectValue: {
        CONTACT_AWS_ACCESS_KEY_ID: cdk.SecretValue.unsafePlainText(accessKey.accessKeyId),
        CONTACT_AWS_SECRET_ACCESS_KEY: accessKey.secretAccessKey,
      },
    });

    const dkim = [
      [identity.dkimDnsTokenName1, identity.dkimDnsTokenValue1],
      [identity.dkimDnsTokenName2, identity.dkimDnsTokenValue2],
      [identity.dkimDnsTokenName3, identity.dkimDnsTokenValue3],
    ];
    dkim.forEach(([name, value], i) => {
      new cdk.CfnOutput(this, `DkimRecord${i + 1}`, {
        value: cdk.Fn.join("", [name, " CNAME ", value]),
      });
    });
  }
}
