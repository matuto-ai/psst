# Exact official image digests resolved and tested by the recorded Docker CI run.
# Ubuntu rootless Podman is CI-tested; Fedora Quadlet/SELinux and LAN remain operator gates.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY reference ./reference
COPY scripts ./scripts
RUN node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; if(process.versions.node!=='24.19.0')process.exit(1); const d=new DatabaseSync(':memory:'); if(d.prepare('SELECT sqlite_version() AS v').get().v!=='3.53.3')process.exit(1); d.close()" \
    && mkdir -p /data && chown node:node /data && chmod 700 /data

FROM node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b AS test
WORKDIR /app
COPY --from=base /app /app
COPY test ./test
COPY fixtures ./fixtures
COPY openapi.json compose.yaml Containerfile README.md CHANGELOG.md ./
COPY docs/docker-release.md ./docs/docker-release.md
RUN openssl version && npm run check && npm test

FROM base AS runtime
# Deny-all connectivity bootstrap. Operator-mounted /run/broker overrides these files.
COPY --chown=node:node --chmod=0600 deploy/config.proxy-container.example.json /run/broker/config.json
COPY --chown=node:node --chmod=0600 deploy/credentials.empty.json /run/broker/credentials.json
LABEL org.opencontainers.image.title="AI Agent Message Broker" \
      org.opencontainers.image.description="Authenticated opaque message delivery to durable adapter inboxes" \
      org.opencontainers.image.source="https://github.com/matuto-ai/psst" \
      org.opencontainers.image.licenses="MIT"
USER node
ENV NODE_ENV=production
ENV BROKER_CONFIG_FILE=/run/broker/config.json
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "scripts/container-health.mjs"]
STOPSIGNAL SIGTERM
CMD ["node", "src/main.mjs"]
