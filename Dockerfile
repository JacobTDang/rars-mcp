# Bookworm has Tcl but no nvc package. Build the pinned release on the same
# suite as the runtime; static LLVM avoids shipping every LLVM target backend.
FROM node:22-bookworm-slim AS nvc-build
ARG NVC_VERSION=1.23.0
ARG NVC_SHA256=10dab7ea016d8a2f7c4ea74a438b6c999423007aa69c0568fedb59564440b3e2
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl build-essential flex pkg-config llvm-14-dev \
        libdw-dev libffi-dev libzstd-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/nvc
RUN curl -fsSL "https://github.com/nickg/nvc/releases/download/r${NVC_VERSION}/nvc-${NVC_VERSION}.tar.gz" -o nvc.tar.gz \
    && echo "$NVC_SHA256  nvc.tar.gz" | sha256sum -c - \
    && tar -xzf nvc.tar.gz --strip-components=1 \
    && mkdir build \
    && cd build \
    && ../configure --prefix=/usr/local --with-llvm=/usr/bin/llvm-config-14 \
        --enable-static-llvm --with-bash-completion=no \
    && make -j2 \
    && make DESTDIR=/opt/nvc-install install-strip

FROM node:22-bookworm-slim AS build
ARG RARS_URL=https://github.com/TheThirdOne/rars/releases/download/v1.6/rars1_6.jar
ARG RARS_SHA256=780f730eb457b1ba609e968accc2c8b77d8f92c3d9dbf30cc7fdb3cfb14e8c24
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/rars \
    && curl -fsSL "$RARS_URL" -o /opt/rars/rars.jar \
    && echo "$RARS_SHA256  /opt/rars/rars.jar" | sha256sum -c -
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY java ./java
RUN npm run build \
    && mkdir -p java/bridge/build/classes \
    && javac --release 11 -cp /opt/rars/rars.jar -d java/bridge/build/classes $(find java/bridge/src/main/java -name '*.java' -print) \
    && jar --create --file java/bridge/build/rars-mcp-bridge.jar -C java/bridge/build/classes . \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl openjdk-17-jre-headless \
        tcl libdw1 libffi8 libzstd1 zlib1g libtinfo6 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/rars /workspace \
    && chown -R node:node /workspace /opt/rars
WORKDIR /app
COPY --from=nvc-build /opt/nvc-install/usr/local/ /usr/local/
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /opt/rars/rars.jar /opt/rars/rars.jar
COPY --from=build --chown=node:node /app/java/bridge/build/rars-mcp-bridge.jar /opt/rars/rars-mcp-bridge.jar
USER node
ENV NODE_ENV=production RARS_WORKSPACE=/workspace RARS_JAR=/opt/rars/rars.jar RARS_BRIDGE_JAR=/opt/rars/rars-mcp-bridge.jar RARS_LIVE_DISCOVERY_DIR=/run/rars-mcp PORT=3000
EXPOSE 3000
CMD ["node", "dist/src/http.js"]
