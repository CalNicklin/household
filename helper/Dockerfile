# syntax=docker/dockerfile:1
# The sealed shopping helper (AUT-2): its own container, its own supermarket login.
# Build from the repo root:  docker build -f helper/Dockerfile -t household-helper .
# The login is a Docker secret mounted at /run/secrets/supermarket (JSON {url, username, password}),
# readable only by the helper's user. The household server never sees it; it holds HELPER_TOKEN only.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    PORT=3003 \
    HELPER_DATA_DIR=/data \
    SUPERMARKET_CREDENTIALS_FILE=/run/secrets/supermarket \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Only behind a TLS-intercepting proxy: `--secret id=npm_ca,src=<ca.pem>`. Nothing is needed otherwise.
RUN --mount=type=secret,id=npm_ca,required=false if [ -f /run/secrets/npm_ca ]; then cp /run/secrets/npm_ca /etc/npm-ca.pem && npm config set -g cafile /etc/npm-ca.pem; fi && npm install -g pnpm@10.28.0 && mkdir -p /app /data && chown -R pwuser:pwuser /data
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contracts/package.json contracts/package.json
RUN pnpm install --frozen-lockfile --prod

COPY contracts contracts
COPY practice/data.ts practice/data.ts
COPY helper helper

USER pwuser
VOLUME ["/data"]
EXPOSE 3003
CMD ["node", "helper/main.ts"]
