# syntax=docker/dockerfile:1

# --- deps: install production node_modules ---
# pglite + the AI SDK are pure JS/WASM — no native build toolchain required.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# --- runtime ---
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MEMORY_DATA_DIR=/data/pg \
    MEMORY_LLM=live \
    PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Persisted pglite data dir; docker-compose mounts a named volume at /data.
RUN mkdir -p /data/pg
VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=15 --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
