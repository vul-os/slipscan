# Build the single embedded binary, then ship it on a minimal base.
#
# THIS IMAGE IS THE CLOUD-NODE ARTIFACT, so it is built with the shared DMTAP
# sync engine (`-tags dmtap`) rather than FlowStock's built-in CRDT. A node on a
# cloud instance is exposed on the open internet, and only the substrate build
# gives every replicated op its own COSE_Sign1 signature — verified on its own
# rather than trusted for having arrived over an authenticated connection
# (kotva substrate/SOVEREIGNTY.md R-SOV-3.2, and docs/CLOUD-NODE.md). It also
# means two nodes converge because they run the same compiled algebra (R-SOV-5).
#
# THE CONSEQUENCE, AND IT IS NOT SUBTLE: the merge engine is a workspace-wide
# choice. This container REFUSES to sync with a node running the built-in engine,
# naming both engines in the error — see docs/CONFIGURATION.md. Either put the
# whole workspace on the substrate (`-tags dmtap` binaries, or
# FLOWSTOCK_SUBSTRATE_SYNC=1), or build this image the other way on purpose:
#
#   docker build --build-arg BUILD_TAGS=embed_frontend .
#
# which produces the same binary the release archives ship, and gives up per-op
# authenticity along with it. Do not do that for an internet-exposed node.
FROM node:20-bookworm AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM golang:1.25-bookworm AS backend
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /app/dist ./backend/cmd/flowstock/dist
ARG VERSION=docker
ARG BUILD_TAGS="embed_frontend dmtap"
RUN CGO_ENABLED=0 go build -tags "${BUILD_TAGS}" \
    -ldflags "-s -w -X main.Version=${VERSION}" \
    -o /flowstock ./backend/cmd/flowstock

FROM gcr.io/distroless/static-debian12
COPY --from=backend /flowstock /flowstock
# 0.0.0.0 here is the container's own network namespace, not the host's: what is
# actually reachable is decided by the published port and by the reverse proxy in
# front of it (docs/CLOUD-NODE.md). /data is a volume because the node's
# identity, its peers' enrolled keys and its whole oplog live there — lose it and
# the node is a stranger to every branch it had.
ENV FLOWSTOCK_HOST=0.0.0.0 \
    FLOWSTOCK_PORT=8787 \
    FLOWSTOCK_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/flowstock"]
