.PHONY: deps tidy \
	migrate migrate-status migrate-reset migrate-dev migrate-main migrate-dev-status migrate-main-status \
	server server-dev server-main run-server \
	mailrx mailrx-dev mailrx-main \
	build build-server build-migrate build-mailrx build-tests \
	docker-build \
	fmt vet \
	tests test test-list

# ---------- deps ----------
deps:
	go mod tidy

tidy: deps

# ---------- migrate (local) ----------
migrate:
	go run ./cmd/migrate

migrate-status:
	go run ./cmd/migrate --status

migrate-reset:
	go run ./cmd/migrate --reset

# ---------- migrate (dev / main) ----------
migrate-dev:
	go run ./cmd/migrate --env=dev

migrate-dev-status:
	go run ./cmd/migrate --env=dev --status

migrate-main:
	go run ./cmd/migrate --env=main

migrate-main-status:
	go run ./cmd/migrate --env=main --status

# ---------- server ----------
server: run-server

run-server:
	go run ./cmd/server

server-dev:
	APP_ENV=dev go run ./cmd/server

server-main:
	APP_ENV=main go run ./cmd/server

# ---------- mailrx ----------
mailrx:
	go run ./cmd/mailrx

mailrx-dev:
	APP_ENV=dev go run ./cmd/mailrx

mailrx-main:
	APP_ENV=main go run ./cmd/mailrx

# ---------- build ----------
build: build-server build-migrate build-mailrx build-tests

build-server:
	go build -o bin/server ./cmd/server

build-migrate:
	go build -o bin/migrate ./cmd/migrate

build-mailrx:
	go build -o bin/mailrx ./cmd/mailrx

build-tests:
	go build -o bin/tests ./cmd/tests

# ---------- Docker ----------
# Builds the production image for cmd/server.
# All configuration is injected at runtime via environment variables.
# Usage:  make docker-build [IMAGE=my-registry/slipscan-backend:latest]
IMAGE ?= slipscan-backend:latest
docker-build:
	docker build -t $(IMAGE) .

# ---------- code health ----------
fmt:
	go fmt ./...

vet:
	go vet ./...

# ---------- operational test suite (cmd/tests) ----------
tests:
	go run ./cmd/tests

# Run a single test by name: `make test NAME=insights`
test:
	@test -n "$(NAME)" || (echo "usage: make test NAME=<test-name>"; exit 1)
	go run ./cmd/tests $(NAME)

test-list:
	go run ./cmd/tests --list
