.PHONY: deps tidy migrate-up migrate-down migrate-version server build fmt vet

deps:
	go mod tidy

tidy: deps

migrate-up:
	go run ./cmd/migrate up

migrate-down:
	go run ./cmd/migrate down 1

migrate-version:
	go run ./cmd/migrate version

server:
	go run ./cmd/server

build:
	go build -o bin/server ./cmd/server
	go build -o bin/migrate ./cmd/migrate

fmt:
	go fmt ./...

vet:
	go vet ./...
