import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { signInOptions } from "../../components/sign-in-options";
import { isSafeRelativePath } from "../../lib/safe-redirect";
import { PageHead } from "../../components/PageHead";
import { loadFeatures } from "../../lib/data";
import { featureOn } from "../../lib/features";

export const metadata: Metadata = { title: "Sign in · Minerval" };

// One account for everything: consuming the API and contributing to the
// graph. Sessions are cookie-based; OAuth providers hold the credentials.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;
  // Same-site relative paths only — never an open redirect.
  const redirectTo = isSafeRelativePath(callbackUrl) ? callbackUrl : "/account";

  const session = await auth();
  if (session?.externalId) redirect(redirectTo);

  // The extension is named among what an account is for only where this
  // deployment has it.
  const extensionOn = featureOn(await loadFeatures(), "extension");

  return (
    <div className="col">
      <PageHead
        title="Sign in"
        lede={
          <>
            One account serves both roles: <em>consumer</em> (API keys, usage
            {extensionOn && <>, the coming browser extension</>}) and <em>contributor</em> (challenges,
            evidence, reputation). Reading the graph never requires an account.
          </>
        }
      />

      {signInOptions({ redirectTo })}
    </div>
  );
}
