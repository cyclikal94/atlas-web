# syntax=docker/dockerfile:1
#
# The atlas-web image: the static frontend behind an unprivileged nginx. It packages an ALREADY BUILT dist/ (with its
# provenance and notices, see docs/packaging.md), so the archive, this image and the chart carry the same bytes. There is
# deliberately no build stage: rebuilding per artefact would make them different builds.
#
#   pnpm install --frozen-lockfile && pnpm build && pnpm package:prepare
#   docker buildx build --platform linux/amd64,linux/arm64 --build-arg NGINX_IMAGE=... -t <repository>:<tag> .
#
# NGINX_IMAGE is pinned by digest (deploy/base-images.env records the tested digest and how it was resolved).
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
FROM ${NGINX_IMAGE}

ARG ATLAS_WEB_VERSION=0.0.0
ARG ATLAS_WEB_REVISION=unknown
LABEL org.opencontainers.image.title="atlas-web" \
      org.opencontainers.image.description="The Atlas web client (static frontend)" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${ATLAS_WEB_VERSION}" \
      org.opencontainers.image.revision="${ATLAS_WEB_REVISION}"

# The image serves exactly dist/, from its own root (/srv/atlas-web). The base image's default site under
# /usr/share/nginx/html is never served, and its default server block is replaced below. There is deliberately no RUN
# step: it keeps the build identical on every platform and needs no root.
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/atlas-security-headers.conf
COPY deploy/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY dist/ /srv/atlas-web/
COPY dist/_web/provenance.json /usr/share/atlas-web/provenance.json
COPY LICENSE /usr/share/atlas-web/LICENSE


# nginx-unprivileged already runs as UID 101 and listens on 8080. It runs with a read-only root filesystem and a
# writable /tmp only.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/_web/health || exit 1
