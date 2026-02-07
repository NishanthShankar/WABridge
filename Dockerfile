# Stage 1: Build
FROM node:22-slim AS builder
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm turbo build --filter=@openwa/server

# Stage 2: Production
FROM node:22-slim AS production
RUN corepack enable && corepack prepare pnpm@9 --activate

# Install only production dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod

# Copy built application
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Create data directory with correct permissions
RUN mkdir -p /app/data && chown -R node:node /app/data

# Default config
COPY apps/server/config.default.yaml /app/config.default.yaml

USER node
EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "apps/server/dist/index.js"]
