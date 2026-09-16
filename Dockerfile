FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ARG RARS_URL=https://github.com/TheThirdOne/rars/releases/download/v1.6/rars1_6.jar
ARG RARS_SHA256=780f730eb457b1ba609e968accc2c8b77d8f92c3d9dbf30cc7fdb3cfb14e8c24
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/rars /workspace \
    && curl -fsSL "$RARS_URL" -o /opt/rars/rars.jar \
    && echo "$RARS_SHA256  /opt/rars/rars.jar" | sha256sum -c - \
    && chown -R node:node /workspace /opt/rars
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
ENV NODE_ENV=production RARS_WORKSPACE=/workspace RARS_JAR=/opt/rars/rars.jar PORT=3000
EXPOSE 3000
CMD ["node", "dist/src/http.js"]
