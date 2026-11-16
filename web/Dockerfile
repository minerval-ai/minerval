# The web app, as a container. Build context: this directory (web/).
#
#   docker build -t minerval-web web/                        # members-only
#   docker build -t minerval-web --build-arg READS=open web/ # anyone may read
#
# A members-only deployment has to be BUILT as one (instrumentation.ts,
# next.config.mjs): a build made for the public graph prepares pages ahead
# of time and would serve them without a sign-in. So READS is a build
# argument, it starts as `members`, and the image runs with the value it
# was built with unless the container is told otherwise.
#
# The build calls no API and needs no secret. Everything the app is told
# about its deployment (the API's address and key, the identity provider,
# the session secret) is given when the container starts.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG READS=members
ENV READS=$READS NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine
RUN addgroup -S minerval && adduser -S minerval -G minerval
WORKDIR /app
ARG READS=members
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 READS=$READS PORT=3000 HOSTNAME=0.0.0.0
# The whole built app: the pages read their vendored content (content/) and
# the card fonts (lib/og/fonts) from disk as well as from .next. Owned by
# the user it runs as, because Next writes its cache under .next.
COPY --from=builder --chown=minerval:minerval /app ./
USER minerval
RUN npm prune --omit=dev
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/signin').then((r) => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
