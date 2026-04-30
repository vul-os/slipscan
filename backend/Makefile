.PHONY: deps tidy migrate migrate-status migrate-reset server build fmt vet tests test test-list

deps:
	go mod tidy

tidy: deps

migrate:
	go run ./cmd/migrate

migrate-status:
	go run ./cmd/migrate --status

migrate-reset:
	go run ./cmd/migrate --reset

server:
	go run ./cmd/server

build:
	go build -o bin/server ./cmd/server
	go build -o bin/migrate ./cmd/migrate
	go build -o bin/tests ./cmd/tests

fmt:
	go fmt ./...

vet:
	go vet ./...

# Operational test suite (cmd/tests) — runs all registered tests by default.
tests:
	go run ./cmd/tests

# Run a single test by name: `make test NAME=insights`
test:
	@test -n "$(NAME)" || (echo "usage: make test NAME=<test-name>"; exit 1)
	go run ./cmd/tests $(NAME)

test-list:
	go run ./cmd/tests --list
