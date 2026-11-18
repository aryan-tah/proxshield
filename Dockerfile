# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# Bake the default models into the image so containers start without network access.
ENV PROXSHIELD_CACHE_DIR=/models
RUN node dist/bin.js download \
 && node -e "fetch('https://huggingface.co/gravitee-io/Llama-Prompt-Guard-2-22M-onnx/resolve/main/LICENSE').then(r=>r.text()).then(t=>require('fs').writeFileSync('/models/LICENSE-llama4.txt',t))"

FROM node:26-bookworm-slim
LABEL org.opencontainers.image.title="proxshield" \
      org.opencontainers.image.description="Self-hosted firewall for LLM apps: PII redaction and prompt-injection blocking" \
      org.opencontainers.image.source="https://github.com/aryan-tah/proxshield" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
RUN useradd --system --uid 10001 --home /app proxshield
COPY --from=build --chown=10001 /app/package.json ./
COPY --from=build --chown=10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001 /app/dist ./dist
COPY --from=build --chown=10001 /models /models
COPY LICENSE NOTICE ./
ENV NODE_ENV=production \
    PROXSHIELD_CACHE_DIR=/models \
    PROXSHIELD_OFFLINE=1 \
    PROXSHIELD_HOST=0.0.0.0 \
    PORT=8080
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/bin.js", "serve"]
