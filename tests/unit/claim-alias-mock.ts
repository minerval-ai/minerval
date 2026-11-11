/**
 * A stand-in for services/claim-alias-service.ts in unit tests whose graph is
 * a handful of mocked queries (#884). The real module follows `merged_into`
 * with queries of its own, which a test that scripts `rawQuery` call by call
 * would have to script too. Here no node is a merged alias: every id resolves
 * to itself and no write is refused. `claimExists`, when given, decides
 * whether an id names a node at all (a test that mocks getClaimById passes
 * it), so "not found" still means what the test set up.
 *
 * Alias resolution itself is tested against a real database in
 * tests/db/claim-alias.test.ts.
 */
export async function passthroughClaimAlias(
  importOriginal: () => Promise<unknown>,
  claimExists?: (id: string) => Promise<boolean>
): Promise<Record<string, unknown>> {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveClaimId: async (id: string) =>
      !claimExists || (await claimExists(id)) ? { id, resolvedFrom: null } : null,
    mergedAliasRefusal: async () => null,
    mergedAliasRefusals: async () => new Map(),
    mergedInputRefusal: async () => null,
  };
}
