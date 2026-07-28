# Minerval browser extension

Read the web with the [Minerval](https://minerval.ai) claim graph switched
on. The extension recognises claims on the page you're reading, underlines
each by what the graph knows about it, and answers questions in a popup chat
grounded in the graph, with claim citations.

## Install

There's no web-store listing yet, so the extension is built from source and
loaded unpacked. You'll need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/minerval-ai/minerval.git
cd minerval/extension
npm install
npm run build
```

Then load it into Chrome (or any Chromium browser such as Edge, Brave, or
Arc):

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select `extension/build/chrome-mv3-prod`.

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
- **Moderate**: also marks contested claims (calmer, dotted).
- **Aggressive**: also oversimplified and noteworthy claims.
- **Hover**: compact card with the canonical claim, graph status, and a
  one-line why.
- **Click**: full panel with the decomposition into subclaims, evidence and
  arguments for/against, and a link to the claim's page on minerval.ai.

Markup is non-destructive: highlights are overlay elements anchored to the
rendered text, re-anchored when the page mutates. The page's DOM text is
never rewritten.

## Privacy

Analyzing a page sends its readable text to the Minerval API for claim
extraction. Because of that, **nothing is sent automatically by default**:
you trigger analysis from the popup, or opt a site (or everything) into
automatic analysis in settings. Any site can be disabled entirely.

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

```bash
cd extension
npm install
npm run dev      # loads a dev build; point chrome://extensions at build/chrome-mv3-dev
npm run build    # production build in build/chrome-mv3-prod
```

Built with [Plasmo](https://www.plasmo.com/) (cross-browser MV3). Point the
extension at a local API by setting the API base URL in settings
(`http://localhost:3000`, the default — no API key needed against a keyless
dev server).
