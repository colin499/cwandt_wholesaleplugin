FROM node:20-alpine AS base

# Prisma's query/migration engines need OpenSSL, which node:alpine lacks
RUN apk add --no-cache openssl

WORKDIR /app

# Full install — the Remix/Vite build needs devDependencies
COPY package*.json ./
RUN npm ci

# Generate Prisma client from the PRODUCTION (PostgreSQL) schema —
# prisma/schema.prisma is the SQLite dev schema and must not be used here.
COPY prisma ./prisma/
RUN npx prisma generate --schema prisma/production/schema.prisma

# Copy source and build
COPY . .
RUN npm run build

# Strip devDependencies for the runtime image. `prisma` (the CLI, needed at
# boot for `migrate deploy`) is a regular dependency, so it survives. The
# generated client is re-created afterwards in case prune touched it.
RUN npm prune --omit=dev && npx prisma generate --schema prisma/production/schema.prisma

# Production image
FROM node:20-alpine AS production

RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/build ./build
COPY --from=base /app/prisma ./prisma
COPY --from=base /app/package.json ./

# Run PostgreSQL migrations then start server
CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/production/schema.prisma && npm start"]

EXPOSE 3000
