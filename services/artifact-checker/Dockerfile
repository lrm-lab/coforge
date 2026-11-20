FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d

ENV NODE_ENV=production \
    CHECKER_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
    XDG_CONFIG_HOME=/tmp/chromium-config \
    XDG_CACHE_HOME=/tmp/chromium-cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-noto-core ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o bun -g bun -m 0750 /run/artifact-renderer

RUN apt-get update \
    && apt-get install -y --no-install-recommends squid fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && rmdir /run/artifact-renderer \
    && install -d -o bun -g bun -m 0750 /run/artifact-checker

WORKDIR /app

COPY services/artifact-checker/package.json services/artifact-checker/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY services/artifact-checker/browser.mjs services/artifact-checker/evaluate.mjs services/artifact-checker/server.mjs services/artifact-checker/ssrf.mjs ./
COPY services/artifact-checker/squid.conf /etc/squid/artifact-checker.conf
COPY apps/web/src/server/artifacts/artifact-sandbox-cdns.server.ts /app/cdn.ts
RUN bun -e 'import { SANDBOX_CDN_HOSTS } from "./cdn.ts"; process.stdout.write(SANDBOX_CDN_HOSTS.join("\n") + "\n")' > /app/cdn-hosts.txt

USER bun

RUN chromium --version && squid -v >/dev/null

CMD ["bun", "server.mjs"]
