# Chrome Web Store listing (issue #135)

Everything the developer dashboard asks for, in the order it asks. Upload
`extension/build/chrome-mv3-prod.zip` (built with `npm run build && npm run
package`). Register and publish signed in as `jackson@minerval.ai` — listings
are effectively pinned to the account that creates them.

## Store listing tab

- **Title**: `Minerval` (from the manifest)
- **Summary** (from the manifest, 132 chars):
  > Reads the page against the Minerval claim graph: flags misleading claims,
  > explains contested ones, answers questions with citations.
- **Category**: Productivity → Tools (alternative: Education)
- **Language**: English
- **Description**:

  ```
  Read the web with the claim graph switched on.

  Minerval maintains an open repository of the world's claims: what is
  asserted, what each assertion rests on, and how much the evidence supports
  it. This extension reads the page you're reading against that graph.

  WHAT IT DOES

  — Recognises the claims on a page and underlines each by what the graph
    knows: egregiously misleading claims in red, contested ones dotted,
    oversimplified and noteworthy ones more quietly. You choose how much
    markup you want; the default is conservative (only the worst).
  — Hover for the canonical claim, its graph status, and a one-line why.
  — Click for the full picture: how the claim decomposes into subclaims,
    the evidence and arguments on each side, and a link to the claim's
    public page, where you can challenge it or add evidence.
  — Ask questions in the popup chat and get answers grounded in the graph,
    with numbered citations to the claims they rest on — not vibes.

  Markup is non-destructive: annotations are drawn as an overlay and the
  page's text is never rewritten.

  PRIVACY, BY DESIGN

  Nothing is sent anywhere until you ask. Analyzing a page sends its
  readable text to the Minerval API, so analysis only runs when you press
  "Analyze page" — or on sites you explicitly opt into automatic analysis.
  Any site can be disabled entirely. No ads, no trackers, no analytics.

  SETUP

  Analysis runs against your Minerval account: sign in at minerval.ai,
  create an API key, and paste it into the extension's settings. Analysis
  and chat are metered against your account's monthly allowance; reading
  claim details is free.

  The graph is maintained by LLM administrators under a public constitution;
  every judgment carries a reasoning trace and is open to challenge. The
  project is open source: github.com/minerval-ai/minerval
  ```

- **Graphic assets** (in this directory; real captures of the extension
  running, regenerate freely):
  - Screenshots (1280×800): `screenshot-1-hover.png` (annotated article +
    hover card), `screenshot-2-panel.png` (evidence & decomposition panel),
    `screenshot-3-chat.png` (popup chat with citations)
  - Small promo tile (440×280): `promo-tile-small.png`
  - Marquee promo tile (1400×560, optional): `promo-marquee.png`
  - Store icon: 128×128 PNG — export from `assets/icon.png` (512×512)
- **Official URL**: `minerval.ai` (verify the domain property in Google
  Search Console first — DNS TXT record in the Cloudflare zone)
- **Homepage URL**: `https://minerval.ai`
- **Support URL**: `https://github.com/minerval-ai/minerval/issues`

## Privacy tab

- **Single purpose description**:
  > Annotates the page the user is reading with fact-check verdicts from the
  > Minerval claim graph, and answers the user's questions about that page
  > grounded in the graph.
- **Permission justifications**:
  - `storage` — Stores the user's settings: API key, markup level, and
    per-site analysis preferences.
  - **Host permissions** (`http://*/*`, `https://*/*`) — The content script
    draws claim annotations as an overlay on whatever article the user is
    reading, so it must be able to run on any site. It sends nothing until
    the user requests analysis of the page.
  - **Remote code**: No, I am not using remote code.
- **Data usage** (check exactly these):
  - ☑ **Authentication information** — the user's Minerval API key,
    sent with analysis/chat requests to authenticate them.
  - ☑ **Website content** — text, title, and URL of a page, sent to the
    Minerval API only when the user requests analysis of that page.
  - Leave everything else unchecked (no location, history, activity,
    personal communications, financial, or health data).
  - Certify all three attestations: data is not sold; not used or
    transferred for purposes unrelated to the item's core functionality;
    not used or transferred to determine creditworthiness or for lending.
- **Privacy policy URL**: `https://minerval.ai/privacy`

## Distribution tab

- Visibility: Public · Free · All regions.

## After the first publish

1. The upload assigns the permanent extension ID — the listing URL is
   `https://chromewebstore.google.com/detail/<id>`.
2. Point the home-page CTA (`web/components/home/Surfaces.tsx`) at that URL
   and rewrite the install section of `extension/README.md` around it
   (build-from-source moves under Development). That closes #135.
3. Set up a **group publisher** (free Google Group, e.g.
   `cws-publishers@minerval.ai`) so the listing isn't tied to one person's
   login.
4. Expect a longer first review: broad host permissions put the extension in
   the in-depth review queue, typically days rather than hours.

## Regenerating the screenshots

The screenshots are real captures: the production build loaded into
Chromium via Playwright, pointed at a local demo article and a mock API
serving graph verdicts (the extension's default API base URL is localhost,
so no key is involved). Re-shoot after UI changes so the listing never
drifts from the product.
