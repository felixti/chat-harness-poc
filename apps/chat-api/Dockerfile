# Build context: repository root (the image bakes skills/ in; Blob-published skills come in phase 2).
# Runtime: no shell, no package manager, nothing to exec (company policy: no CLI).
FROM node:24-slim AS deps
WORKDIR /app
COPY apps/chat-api/package.json apps/chat-api/package-lock.json ./
# --ignore-scripts: no install-time code runs (protobufjs postinstall is not needed).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Portal (React + Vite) built here and served by chat-api: no CDN at runtime.
FROM node:24-slim AS web
WORKDIR /app/apps/chat-web
COPY apps/chat-web/package.json apps/chat-web/package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY apps/chat-web/ ./
RUN npx vite build

# Runtime: Wolfi (Chainguard, Apache-2.0) packages, which get CVE fixes within days (Debian 13's
# libssl3t64 carried unfixed HIGHs in 2026-11, see docs/design.md H63), copied into scratch with
# the shell, busybox applets and apk removed. The apk database stays so scanners see every package.
FROM cgr.dev/chainguard/wolfi-base AS runtime
RUN apk add --no-cache nodejs-24 ca-certificates-bundle && mkdir -p /tmp-empty
RUN ["/usr/bin/node", "-e", "const fs=require('fs'),path=require('path');for(const d of ['/bin','/sbin','/usr/bin','/usr/sbin'])for(const n of fs.readdirSync(d)){const f=path.join(d,n);let l='';try{l=fs.readlinkSync(f)}catch{}if(n!=='node'&&(l.includes('busybox')||['busybox','sh','apk','ash'].includes(n)))fs.rmSync(f,{force:true})}"]

FROM scratch
COPY --from=runtime / /
COPY --from=runtime --chown=65532:65532 /tmp-empty /tmp
WORKDIR /app/apps/chat-api
COPY --from=deps /app/node_modules ./node_modules
COPY apps/chat-api/package.json ./
COPY apps/chat-api/src ./src
COPY --from=web /app/apps/chat-api/public ./public
COPY apps/chat-api/assets ./assets
COPY skills /app/skills
ENV NODE_ENV=production \
    SKILLS_DIR=/app/skills \
    TMP_ROOT=/tmp/chat \
    HOME=/tmp/home \
    PORT=8080
EXPOSE 8080
USER 65532:65532
# The memory-curator CronJob passes only args: node stays the entrypoint (as in distroless).
ENTRYPOINT ["/usr/bin/node"]
CMD ["--experimental-strip-types", "src/server.ts"]
