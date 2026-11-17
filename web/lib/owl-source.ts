// Where a person gets more owls in this deployment, and how a page says so
// when their balance cannot cover something (#1095).
//
// On the public graph owls are bought, from the account page's "Buy owls"
// section. Where the deployment creates its own owls (OWLS=created;
// docs/accounts.md, "Owls a deployment creates for itself") nothing is sold
// and that section is not shown: an administrator creates owls into a
// person's balance, on Administration → Owls. And a deployment can sell
// none without creating any (payments off), where there is nowhere to send
// the person at all.
//
// Kept free of server-only imports so that client components (the
// Assistant's composer, the decomposition form) can say it in the same
// words; web/lib/load-owl-source.ts reads it for a signed-in person.

import { permissionPhrase } from "./admin-words";

export type OwlSource =
  /** Owls are bought here, from the account page. */
  | { kind: "sold" }
  /** Owls are created by administrators. `administers`: the viewer may create them. */
  | { kind: "created"; administers: boolean }
  /** Neither: nothing is sold here and nobody creates owls. */
  | { kind: "none" };

/** The permission an administrator needs to create owls (POST /owls/created). */
export const CREATES_OWLS = "administer";

/** Where on the account page owls are bought. */
export const BUY_OWLS_HREF = "/account#buy-owls";
/** Where owls are created, by a holder of CREATES_OWLS. */
export const CREATE_OWLS_HREF = "/admin/owls";
/** Who holds which permission: every member may read it. */
export const WHO_HOLDS_HREF = "/admin/people";

/**
 * Where owls come from, from what the account read says: the entitlement's
 * own flag, and whether owls can be bought (the account page's `canBuy`).
 */
export function owlSourceOf(
  entitlement: { owls_created_here?: boolean; credits_enabled: boolean },
  packs: readonly unknown[],
  administers: boolean
): OwlSource {
  if (entitlement.owls_created_here === true) return { kind: "created", administers };
  if (entitlement.credits_enabled && packs.length > 0) return { kind: "sold" };
  return { kind: "none" };
}

/**
 * One sentence on how to get more owls, for an error message that is plain
 * text. A page that can show links says it with <GettingOwls>.
 */
export function gettingOwlsSentence(source: OwlSource): string {
  switch (source.kind) {
    case "sold":
      return "You can buy owls from your account page.";
    case "created":
      return source.administers
        ? "Owls here are created by this deployment's administrators, and you are one: " +
            "create them into a balance under Administration → Owls."
        : "Owls here are created by this deployment's administrators: anyone who holds the " +
            `permission to ${permissionPhrase(CREATES_OWLS)} can create owls into your balance, ` +
            "under Administration → Owls. Ask one of them.";
    case "none":
      return "Owls are not sold on this deployment.";
  }
}
