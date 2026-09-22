# ---- Builder: install all deps and compile TypeScript ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies against the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

# Compile src/ -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runner: production-only deps + compiled output ----
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/index.js"]
