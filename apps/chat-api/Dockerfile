# Build context: repository root (the image bakes skills/ in; Blob-published skills come in phase 2).
# Runtime is distroless: no shell, no package manager, nothing to exec (company policy: no CLI).
FROM node:24-slim AS deps
WORKDIR /app
COPY apps/chat-api/package.json apps/chat-api/package-lock.json ./
# --ignore-scripts: no install-time code runs (protobufjs postinstall is not needed).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app/apps/chat-api
COPY --from=deps /app/node_modules ./node_modules
COPY apps/chat-api/package.json ./
COPY apps/chat-api/src ./src
COPY apps/chat-api/public ./public
COPY skills /app/skills
ENV NODE_ENV=production \
    SKILLS_DIR=/app/skills \
    TMP_ROOT=/tmp/chat \
    HOME=/tmp/home \
    PORT=8080
EXPOSE 8080
USER 65532:65532
CMD ["--experimental-strip-types", "src/server.ts"]
