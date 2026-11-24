# Brave Search MCP server (upstream @brave/brave-search-mcp-server, MIT) over HTTP for chat-api.
# Build context: repository root. Runtime: Wolfi packages in scratch, no shell (H63); the server never spawns.
FROM node:24-slim AS deps
WORKDIR /app
COPY apps/brave-mcp/package.json apps/brave-mcp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM cgr.dev/chainguard/wolfi-base AS runtime
RUN apk add --no-cache nodejs-24 ca-certificates-bundle && mkdir -p /tmp-empty
RUN ["/usr/bin/node", "-e", "const fs=require('fs'),path=require('path');for(const d of ['/bin','/sbin','/usr/bin','/usr/sbin'])for(const n of fs.readdirSync(d)){const f=path.join(d,n);let l='';try{l=fs.readlinkSync(f)}catch{}if(n!=='node'&&(l.includes('busybox')||['busybox','sh','apk','ash'].includes(n)))fs.rmSync(f,{force:true})}"]

FROM scratch
COPY --from=runtime / /
COPY --from=runtime --chown=65532:65532 /tmp-empty /tmp
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
ENTRYPOINT ["/usr/bin/node"]
CMD ["node_modules/@brave/brave-search-mcp-server/dist/index.js"]
