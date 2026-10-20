# ── build stage ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime stage ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# fixed uid/gid so a bind-mounted data folder can be chowned predictably (see docker-compose.yml)
RUN groupadd -r -g 10001 shadowgate && useradd -r -u 10001 -g shadowgate -s /usr/sbin/nologin shadowgate
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY web ./web
RUN mkdir -p /app/data && chown -R shadowgate:shadowgate /app
USER shadowgate
EXPOSE 4315
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:4315/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
