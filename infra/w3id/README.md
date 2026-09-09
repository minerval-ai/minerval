# w3id.org namespace: `minerval` (registered)

The two files in this directory are the registration submitted for the
`https://w3id.org/minerval/` permanent-identifier namespace. The
[perma-id/w3id.org](https://github.com/perma-id/w3id.org) PR merged on
2026-08-03, the redirects are live, and the API mints citation and nanopub IRIs
under the namespace (#322). They are kept here as the record of what was
submitted, and as the source to edit from if the redirect rules ever need to
change. See "Persistent citation URLs" in `docs/infrastructure.md` for why.

`namespace-README.md` below is the file that goes INTO the w3id PR (w3id
requires each namespace directory to carry a README naming its maintainers);
this file is only the local instructions and stays here.

---

## Contents to submit

- `namespace-README.md` → submit as `minerval/README.md`
- `.htaccess` → submit as `minerval/.htaccess`

## Submission steps (completed 2026-08-03)

1. Fork `perma-id/w3id.org` on GitHub (as the account that will maintain the
   namespace — jacksonqueenking).
2. Create the directory `minerval/` at the repo root containing the two files.
3. Open a PR titled "Add minerval namespace". Reviews usually land within a
   few days; the maintainers may ask the listed contact to confirm.
4. After merge, verify: `curl -sI https://w3id.org/minerval/claim/test` should
   302 to `https://minerval.ai/claims/test`.
5. Set `CITATION_URL_BASE=https://w3id.org/minerval/claim` on the API
   (`infra/lib/api-stack.ts` and `infra/lib/solver-stack.ts` env) so citations
   mint the permanent form.
