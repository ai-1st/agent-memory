# syntax=docker/dockerfile:1
#
# The "simple" memory service. pglite is pure WASM (no native build toolchain),
# so the image is a plain Node 22 runtime — no python/make/g++ needed.

# --- deps: install production node_modules ---
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- runtime ---
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MEMORY_DATA_DIR=/data/pgdata \
    PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Persisted pglite data lives here; docker-compose mounts a named volume at /data.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=10 --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
