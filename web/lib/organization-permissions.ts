// What an organization grants its members and its deployments, and what
// each permission means, in the words every page uses (docs/organizations.md,
// "What an organization grants"; the API's list is src/db/schema.ts).

export const MEMBER_PERMISSIONS = ["spend", "buy", "speak", "propose", "take_up", "claim_prizes"] as const;
export type MemberPermission = (typeof MEMBER_PERMISSIONS)[number];

export const DEPLOYMENT_GRANTS = ["read_feed", "report_usage", "publish", "spend", "speak", "propose", "take_up"] as const;
export type DeploymentGrant = (typeof DEPLOYMENT_GRANTS)[number];

export type OrganizationPermission = MemberPermission | DeploymentGrant;

export const PERMISSION_WORDS: Record<OrganizationPermission, string> = {
  spend: "Spend or escrow the organization's owls: open and fund mandates, pay for assessments and requests' work.",
  buy: "Buy owls for the organization, paid by the person.",
  speak: "Put words on the public record in the organization's name: contributions, stated views, appeals, issues raised.",
  propose: "Propose claims and lists, and submit sources, as the organization.",
  take_up: "Take up a request, committing the organization to its work, and decline one taken up.",
  claim_prizes: "File a prize claim as the organization; the prize is paid to the organization's owls. Not yet in force: the prize rules name natural persons until a new version allows organizations.",
  publish: "Register the deployment's signing key, and send pages and mandates released at its gate, under the organization.",
  read_feed: "Pull the whole mirror feed. It shows only that the deployment exists and when it pulls.",
  report_usage: "Send one day's total of owls spent, privately to Minerval, for the metered price.",
};
