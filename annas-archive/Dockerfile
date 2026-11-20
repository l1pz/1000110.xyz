# Built from a pinned commit of https://github.com/bitesized/annas-archive-api.
#
# The upstream source is deliberately NOT vendored into this repository: that
# project has no license file, so we build its tagged tarball instead. Bump
# UPSTREAM_SHA in compose.yaml on purpose (check the upstream commits first,
# especially security fixes), deploy, and test a search from the e-reader.
FROM node:24.22.1-alpine

# The upstream pin is also the Node fix for CVE-2026-111497 (Brotli decoder
# RCE); never drop below 24.22.1.
ARG UPSTREAM_SHA
RUN test -n "$UPSTREAM_SHA"

WORKDIR /app

RUN wget -qO- "https://github.com/bitesized/annas-archive-api/archive/${UPSTREAM_SHA}.tar.gz" \
      | tar -xz --strip-components=1 -C /app \
 && npm ci --omit=dev \
 && npm cache clean --force

# The forwardAuth key gate (see README.md), run by the second service in compose.yaml.
COPY gate.mjs /app/gate.mjs

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node

CMD ["node", "dev.mjs"]