import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Whether this build was made for a members-only deployment (lib/members.ts),
  // fixed into the build so that instrumentation.ts can compare it with the
  // setting the app is started under. Nothing else reads it.
  env: {
    MINERVAL_BUILT_READS: process.env.READS === "members" ? "members" : "open",
  },
  // This app is the build root (it lives in a subdir of the backend repo).
  outputFileTracingRoot: __dirname,
  // Ensure the vendored verbatim content ships in the serverless bundle.
  outputFileTracingIncludes: {
    "/docs/**": ["./content/**/*"],
    // The fonts the link-preview cards are set in (lib/og/card.tsx).
    "/{claims,findings}/**": ["./lib/og/fonts/*.woff"],
  },
  // Embeds (/embed/*: the claim card page and its badge) exist to be shown on
  // other people's sites, so they alone may be framed from anywhere, and no
  // X-Frame-Options is sent for them. This sets no framing policy for the
  // rest of the site. The card page inlines its styles and one small script
  // and fetches nothing, and the policy holds it to that.
  async headers() {
    return [
      {
        source: "/embed/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
              "base-uri 'none'; form-action 'none'; frame-ancestors *",
          },
        ],
      },
    ];
  },
  // The explainer pages moved from /about/* to /docs/* (#112); old URLs live on.
  async redirects() {
    return [
      { source: "/about/constitution", destination: "/docs/constitution", permanent: true },
      { source: "/about/architecture", destination: "/docs/architecture", permanent: true },
      { source: "/about/agents", destination: "/docs/agents", permanent: true },
      { source: "/about/agents/:key", destination: "/docs/agents/:key", permanent: true },
      // The public evals page (#368) lives under /docs; the short URL points at it.
      { source: "/evals", destination: "/docs/evals", permanent: true },
      // The logo assets were renamed from their pre-rebrand directory (#311).
      { source: "/episteme-logo/:file", destination: "/minerval-logo/:file", permanent: true },
      // The blog is a Substack on its own subdomain; the short URL points at it.
      // Temporary, so the target can move without browsers caching it.
      { source: "/blog", destination: "https://blog.minerval.ai", permanent: false },
    ];
  },
};

export default nextConfig;
