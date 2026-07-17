# Working the roadmap (conventions for agents)

This directory turns the [ROADMAP](./ROADMAP.md) into discrete tickets that a
single Sonnet agent can pick up, build, and finish independently. Read this
once before starting any task.

## Layout

```
roadmap/
  ROADMAP.md              vision + phases + dependency graph
  README.md               this file
  tasks/phase-N/PN-MM-*.md  one self-contained ticket each
```

## Task file anatomy

Every ticket has YAML front-matter and a fixed set of sections:

```yaml
---
id: P1-02
title: Transaction classification engine
phase: 1
status: todo            # todo | in_progress | review | done | blocked
depends_on: [P1-01]     # task ids that must be done first
owner: unassigned       # agent/person who picked it up
---
```

Sections: **Goal · Context · Existing assets · Scope (in/out) · Implementation ·
Acceptance criteria · Tests · Notes.** "Existing assets" lists the real tables,
packages, and files already in the repo — start there, don't rebuild what exists.

## Rules of engagement

1. **One task = one agent = one PR/branch.** Branch name `task/PN-MM-slug`.
2. **Honour `depends_on`.** If a dependency isn't `done`, don't start; pick
   another ready task or mark yourself `blocked` with a note.
3. **Set `status` as you go** — `in_progress` when you start, `review` when
   you open the PR, `done` when merged. Keep `owner` current.
4. **Don't change the schema unless the task says so.** Most tables already
   exist (migrations `20260430000001`–`000004`). New tables go in a new
   timestamped migration in `backend/migrations/`, never by editing an applied one.
5. **Match the surrounding code.** Go: stdlib `net/http` mux + `database/sql`,
   store/handler split per package (see `internal/org`, `internal/document`).
   Frontend: React + Tanstack Query (`src/lib/queries.js`), zustand stores,
   Tailwind, Radix UI primitives in `src/components/ui`.
6. **Wire new HTTP routes in `backend/cmd/server/main.go`** following the
   existing `authed` / `authedMember` / `authedAdmin` middleware pattern.
7. **Acceptance criteria are the contract.** A task is `done` only when every
   box is checked and `go build ./...` + `npm run build` pass.
8. **Leave the codebase releasable.** Behind a flag if half-done.

## Definition of done (applies to every task)

- [ ] All acceptance-criteria boxes checked
- [ ] `cd backend && go build ./... && go vet ./...` clean
- [ ] `npm run build` clean (if frontend touched)
- [ ] Tests added/updated and passing
- [ ] No edits to already-applied migrations; new migration if schema changed
- [ ] `status: done`, `owner` set, short summary appended under **Notes**

## Picking up work

Ready tasks are those whose `depends_on` are all `done`. Phase 0 is the
critical path — `P0-03` unblocks the rest of Phase 0. Within a phase, the
dependency graph in the ROADMAP shows what can run in parallel.
