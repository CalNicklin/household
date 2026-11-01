# syntax=docker/dockerfile:1
# The household server (PLT-8): one image, run by docker compose next to Postgres, object storage,
# Hindsight and the sealed shopping helper. Node runs the TypeScript directly (type stripping).
FROM node:22-bookworm-slim
ENV NODE_ENV=production
# Only behind a TLS-intercepting proxy: `--secret id=npm_ca,src=<ca.pem>`. Nothing is needed otherwise.
RUN --mount=type=secret,id=npm_ca,required=false if [ -f /run/secrets/npm_ca ]; then cp /run/secrets/npm_ca /etc/npm-ca.pem && npm config set -g cafile /etc/npm-ca.pem; fi && npm install -g pnpm@10.28.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contracts/package.json contracts/package.json
RUN pnpm install --frozen-lockfile --prod=false
COPY . .
RUN pnpm build:web
RUN useradd --system --uid 10001 house && mkdir -p /app/.data && chown -R house /app/.data
USER house
EXPOSE 3001
CMD ["node", "server/main.ts"]
