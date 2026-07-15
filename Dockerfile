FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Generate Prisma client from the PRODUCTION (PostgreSQL) schema —
# prisma/schema.prisma is the SQLite dev schema and must not be used here.
COPY prisma ./prisma/
RUN npx prisma generate --schema prisma/production/schema.prisma

# Copy source and build
COPY . .
RUN npm run build

# Production image
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/build ./build
COPY --from=base /app/public ./public
COPY --from=base /app/prisma ./prisma
COPY --from=base /app/package.json ./

# Run PostgreSQL migrations then start server
CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/production/schema.prisma && npm start"]

EXPOSE 3000
