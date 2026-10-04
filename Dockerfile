FROM oven/bun:1.3.14

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git nodejs npm ripgrep tini \
  && npm install -g @anthropic-ai/claude-code \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/kafu
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .

RUN mkdir -p /workspace && chown bun:bun /workspace
USER bun
WORKDIR /workspace
EXPOSE 4632

ENTRYPOINT ["tini", "--", "bun", "run", "/opt/kafu/src/index.ts"]
CMD ["start", "--web"]
