/**
 * Minerval's release key (docs/releases.md, "Releases are signed").
 *
 * Every entry in the list of releases is signed with this key's private
 * half, which Minerval's release workflow holds and no deployment does. The
 * public halves are written here, in the code, so a deployment checks each
 * release it is shown against a key it already has: neither a mirror of the
 * list nor an uploaded file can invent a release, withdraw one or change
 * its facts.
 *
 * A key is the 32 raw bytes of an Ed25519 public key in base64, as the
 * mirror feed states its key (services/mirror-batch.ts). More than one may
 * be listed while a key is being replaced: the new one is added in a
 * release before anything is signed with it, and the old one is taken out
 * in a later release.
 *
 * The list is empty until Minerval makes its key (`npm run release:sign --
 * keygen`) and writes the public half here. Until then no entry verifies:
 * the public graph accepts none, and a deployment says that it knows of
 * releases only from the notes in its own image.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [];
