FROM node:24.22.2-bookworm-slim
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.33.4
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @attuner/api build && pnpm --filter @attuner/web build
RUN mkdir -p /app/.runtime && chown -R node:node /app
USER node
CMD ["pnpm", "--filter", "@attuner/web", "start"]
