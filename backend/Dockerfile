# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — builder
#   Compiles a fully-static cmd/server binary.  CGO is disabled so the binary
#   runs in a scratch/distroless image without glibc.
# ---------------------------------------------------------------------------
FROM golang:1.25-bookworm AS builder

WORKDIR /src

# Cache dependency downloads separately from source so rebuilds are fast.
COPY go.mod go.sum ./
RUN go mod download

# Copy full source and build.
COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# ---------------------------------------------------------------------------
# Stage 2 — runtime
#   Minimal image: no shell, no package manager, no writable filesystem.
#   The binary runs as UID 65532 (nonroot) which is the distroless convention.
#
#   All configuration is injected via environment variables at runtime.
#   Do NOT bake a .env file into this image.
#
#   Required env vars (see .env.example for full reference):
#     DATABASE_URL, JWT_SECRET,
#     B2_KEY_ID (or STORAGE_KEY_ID), B2_APPLICATION_KEY (or STORAGE_SECRET),
#     B2_BUCKET (or STORAGE_BUCKET), B2_REGION (or STORAGE_REGION),
#     B2_ENDPOINT (or STORAGE_ENDPOINT),
#     GEMINI_API_KEY
#
#   Optional:
#     PORT (default 8080)
#     INBOUND_INGEST_SECRET  — enables POST /internal/inbound-email
#     STORAGE_*              — override B2_* for Cloudflare R2 or any S3-compat
#     AWS_REGION + EMAIL_FROM — enables SES email delivery
#     EMAIL_WORKER_ENABLED=true — run the outbox delivery worker on this instance
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

# Copy the compiled binary from the builder stage.
COPY --from=builder /out/server /server

# The platform injects PORT; default to 8080 when not set.
ENV PORT=8080

EXPOSE 8080

# Run as the distroless nonroot user (UID 65532).
USER nonroot:nonroot

ENTRYPOINT ["/server"]
