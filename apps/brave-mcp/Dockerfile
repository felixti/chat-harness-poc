# Brave Search MCP server (upstream @brave/brave-search-mcp-server, MIT) over HTTP for chat-api.
# Build context: repository root. Runtime is distroless (no shell); the server never spawns.
FROM node:24-slim AS deps
WORKDIR /app
COPY apps/brave-mcp/package.json apps/brave-mcp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
ENV BRAVE_MCP_TRANSPORT=http \
    BRAVE_MCP_HOST=0.0.0.0 \
    BRAVE_MCP_PORT=8080 \
    BRAVE_MCP_STATELESS=true \
    BRAVE_MCP_ENABLED_TOOLS="brave_web_search brave_news_search brave_llm_context" \
    BRAVE_API_KEY_FILE=/var/run/secrets/brave/api-key
USER 65532
EXPOSE 8080
CMD ["node_modules/@brave/brave-search-mcp-server/dist/index.js"]
