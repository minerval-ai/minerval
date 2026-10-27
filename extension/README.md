# Minerval browser extension

Read the web with the [Minerval](https://minerval.ai) claim graph switched
on. The extension recognises claims on the page you're reading, underlines
each by what the graph knows about it, and answers questions in a popup chat
grounded in the graph, with claim citations.

## Install

[**Install from the Chrome Web Store**](https://chromewebstore.google.com/detail/minerval/ojpdkgmlbffliefddfendfakpiiopkci)
— one click, with automatic updates. Works in Chrome and other Chromium
browsers (Edge, Brave, Arc).

To run a local build instead, see [Development](#development).

## Set it up

Analysis and chat run against your Minerval account:

1. Sign in at [minerval.ai](https://minerval.ai) and create an API key
   under [Account · API keys](https://minerval.ai/account). Keys look like
   `epk_…`.
2. Click the extension icon and open its **Settings** tab.
3. Set the API base URL to `https://api.claimgraph.io` and paste your key.

Now open an article and click **Analyze page** in the popup. Big pages can
take a few minutes the first time; results are cached by page content, so
re-analyzing an unchanged page is instant.

## What the markup means

Conservative by default, progressively disclosing:

- **Conservative (default)**: only claims the agent judges *egregiously
  misleading or wrong as written* get a red underline.
- **Moderate**: also marks unsettled claims stated as settled (calmer, dotted).
- **Aggressive**: also oversimplified and noteworthy claims.
- **Hover**: compact card with the canonical claim, graph status, and a
  one-line why.
- **Click**: full panel with the decomposition into subclaims, evidence and
  arguments for/against, and a link to the claim's page on minerval.ai.
- **Not in the graph yet**: claims the analysis found but the graph doesn't
  hold get a faint grey dashed underline (turn it off in settings). Nothing
  has checked them: the graph has nothing to judge them against.

The popup's **Page** tab says where the page stands: not analyzed (and
nothing sent), analyzing, or what was found, e.g. "14 claims found · 3 in the
graph · 11 new". It lists both groups.

## Adding claims to the graph

Early on, most claims on most pages aren't in the graph, so the extension
lets you add them. In the Page tab, tick the new claims worth checking and
press **Propose**, or click a faint underline and use **Propose this claim**
in its panel (where you can add a note on why it's worth checking).

A proposal goes through the same governed intake as proposing a claim on
minerval.ai (`POST /claims/propose`): the Contribution Reviewer checks it's a
well-formed, public claim, then the Matcher lands it on an existing claim or
creates a new one, and it is assessed. Each proposal is charged the
claim-proposal price, which also buys its first assessment, and refunded if
the review declines it. The popup shows the price and your owl balance.

What's sent is only the claim, in the neutral wording the pipeline proposes
for it, plus your note if you write one. Nothing else from the page is kept:
not its address, title or text. Claims are meant to be canonical and public,
not tied to the page they were read on.

Markup is non-destructive: highlights are overlay elements anchored to the
rendered text, re-anchored when the page mutates. The page's DOM text is
never rewritten.

## Privacy

Analyzing a page sends its readable text to the Minerval API for claim
extraction. Because of that, **page text is never sent automatically by
default**: you trigger analysis from the popup, or opt a site (or everything)
into automatic analysis in settings. Any site can be disabled entirely.

What is sent is transient. Page text and chat questions are analyzed and
discarded: they are never written to Minerval's database or to its agent
transcripts, and no claim enters the graph from them unless you propose it
(see [Adding claims to the graph](#adding-claims-to-the-graph); only the
claim's wording is kept). Results are cached in
server memory for about an hour so re-opening a page is instant; only a
metering record (agent, model, token counts, cost) is kept. The one exception
is [sharing](#shared-checks), for public pages only. The site's
[privacy policy](https://minerval.ai/privacy) states this in full.

## Shared checks

When one reader analyzes a public page, the next reader of that page sees the
results straight away, with no click and no charge. The popup says "Checked by
another reader on <date>", and **Re-analyze** runs a fresh check.

- **Which pages are shared.** After an analysis, the server fetches the page
  itself, signed out, and keeps the result only if most of the claims'
  phrases are on that copy. News, Substack and LessWrong posts and comments,
  and blogs qualify. Inboxes, logged-in views and paywalled pages can't, so
  they never are. The extension also never offers a draft: a page whose text
  is mostly in an editor or text box. You can switch sharing off for a page
  in the Page tab, or entirely in settings.
- **What is kept.** The normalized address, and per claim the short phrase it
  was found in, the verdict and the matched claim's id. Not the page's text,
  its title, or who analyzed it. Claim statuses aren't stored: they are read
  from the graph when the check is served, so they are always current.
- **Lookups.** On each page the extension sends only the first four
  characters of a hash of the address, shared by thousands of addresses, with
  no API key. It fetches results only if the page's full hash is in the
  answer, which happens only for public pages someone already analyzed. Turn
  this off with **Show checks other readers already ran**.

## Metering

All analysis and chat calls authenticate with your API key and are metered
per token against your account's monthly allowance (#70). Reading claim
details is free and unmetered.

## How it works

Capture the page's readable text → extract claims (Extractor) → match each
against the graph (Matcher) → a dedicated **extension agent** judges how each
on-page phrasing relates to what the graph knows and decides the markup
(issue #72). The same agent powers the popup chat.

Analysis is asynchronous (#93): the API answers 202 + a content hash once its
grace window passes and the extension polls until the result is ready.
Results are cached server-side by url + content hash.

## Development

You'll need [Node.js](https://nodejs.org) 22 or newer.

```bash
cd extension
npm install
npm run dev      # dev build in build/chrome-mv3-dev, opened in a fresh Chrome with live reload
npm run build    # production build in build/chrome-mv3
npm run package  # zips the production build to build/chrome-mv3-prod.zip
```

To load a local build: open `chrome://extensions`, turn on **Developer
mode** (top right), click **Load unpacked**, and select the build directory
above. A loaded local build runs alongside or instead of the store version —
disable one of the two to avoid double annotations.

Built with [WXT](https://wxt.dev/) (Vite, MV3). The manifest lives in
`wxt.config.ts`; `entrypoints/` holds the three thin entries (background,
content script, popup) that call into `background.ts`,
`contents/overlay.ts`, and `popup.tsx`. The toolbar icons in `public/icon/`
are fixed PNGs resized from `assets/icon.png`; regenerate them by hand if
the master icon changes. Point the
extension at a local API by setting the API base URL in settings
(`http://localhost:3000`, the default — no API key needed against a keyless
dev server).
