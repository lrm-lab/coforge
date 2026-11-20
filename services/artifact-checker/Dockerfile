FROM oven/bun:1.4.4-slim

ENV NODE_ENV=production \
    PORT=3100 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
    && bunx --bun playwright-core install chromium --with-deps \
    && rm -rf /var/lib/apt/lists/* /root/.bun/install/cache

COPY browser.mjs evaluate.mjs server.mjs ssrf.mjs ./

RUN chown -R bun:bun /app /ms-playwright

USER bun

EXPOSE 3100

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3100/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "server.mjs"]
