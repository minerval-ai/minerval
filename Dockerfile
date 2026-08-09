# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production stage
FROM node:22-alpine
RUN apk add --no-cache curl
RUN addgroup -S episteme && adduser -S episteme -G episteme
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY admin_constitution.md* ./
# The operational scripts (seeds, backfills) and the TypeScript they import.
# They run under tsx and import `../src/...`, not the compiled dist, so src/
# has to be here for scripts/ to be anything other than dead weight in the
# image — and the image is the only place a script can reach a private RDS.
# The server itself still runs dist; this is for one-off tasks.
COPY scripts/ ./scripts/
COPY tsconfig.json ./
COPY src/ ./src/
COPY rds-ca-bundle.pem ./
COPY src/db/migrations/ ./drizzle-migrations/
USER episteme
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "dist/index.js"]
