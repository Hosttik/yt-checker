# syntax=docker/dockerfile:1.7

FROM node:22.23.3-bookworm-slim AS deps

WORKDIR /app

ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN npm install --global npm@11.21.0 --no-audit --no-fund \
    && chown node:node /app

COPY --chown=node:node package.json package-lock.json ./

USER node

RUN npm ci --no-audit --no-fund

FROM deps AS source

COPY --chown=node:node . .

FROM source AS dev

ENV NODE_ENV=development

EXPOSE 3000

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM source AS verify

RUN npm run check

FROM source AS build

RUN npm run build

FROM node:22.23.3-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000

WORKDIR /app

COPY --from=build --chown=node:node /app/.output ./.output

USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", ".output/server/index.mjs"]
