VERSION := $(shell cat VERSION 2>/dev/null || echo dev)

# Every target here is phony — none of them names a file it produces. `test-e2e`
# was missing from this list, so a directory or file called `test-e2e` appearing
# in the tree would have made `make test` quietly do nothing.
.PHONY: dev dev-app build build-frontend test test-go test-e2e test-race lint docs-check docs-sync screenshots run

# UI-only dev (browser + demo data)
dev:
	npm run dev

# Go server proxying to the Vite dev server
dev-app:
	go run ./backend/cmd/flowstock

# Full single-binary build (frontend embedded)
build:
	npm run build:all

build-frontend:
	npm run build

# Tests
test: test-go test-e2e

test-go:
	go test ./backend/...

# The race detector, in both tag configurations. CI runs this too.
test-race:
	npm run test:race

# Browser end-to-end tests against the real binary (builds it if stale).
# Needs `npx playwright install chromium` once.
test-e2e:
	npx playwright test

lint:
	npm run lint

# site/docs/ must stay byte-identical to docs/ — see scripts/docs-mirror.mjs.
docs-check:
	npm run docs:check

docs-sync:
	npm run docs:sync

screenshots:
	npm run screenshots

run: build
	./flowstock
