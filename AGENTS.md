# caxio

Online multiplayer Lexio (렉시오, a tile-shedding board game): an authoritative realtime
server and a web client that share one rules engine.

## Rules spec: read it first

`docs/lexio-rules.md` (Korean) is the single source of truth for game logic: tile ranks,
hand detection and comparison, the turn state machine, settlement, elimination and game
end. Implement it exactly.

- Two policies in it are decisions the owner has already made. Do not reinterpret them:
  bankruptcy uses the official elimination rule (pay what you have, then you are out and
  collect nothing further), and a turn timeout auto-plays the lowest single when leading
  and auto-passes when following.
- Where the spec is silent or ambiguous, choose the smallest reasonable behaviour, cover
  it with a test, and state the assumption in your final summary.
- Never edit the spec to match the code. Spec changes go through the owner.

## Layout

| Path | Package | Role |
| --- | --- | --- |
| `packages/engine` | `@caxio/engine` | Pure rules engine. No I/O, timers, DOM, Node or Bun APIs, and no hidden randomness (the caller supplies it). Runs unchanged in the server and the browser. |
| `apps/server` | `@caxio/server` | Authoritative game server on Bun (`Bun.serve`, WebSocket). Owns rooms, turn timers and hidden information. |
| `apps/web` | `@caxio/web` | React + Vite client. Renders what the server sends and is never trusted. |

Apps import the engine as `@caxio/engine`. It is a workspace link to the TypeScript source
(`packages/engine/src/index.ts`), so there is no build step between packages, and each
app's typecheck also checks the engine files it imports. That is what keeps the engine
portable: a Bun API in the engine fails the web typecheck, a DOM API fails the server one.

Toolchain: Bun 1.3 (package manager, runtime, test runner), TypeScript 7, Biome 2, Vite 8,
React 19. These are newer than most training data: check the installed version's docs
before relying on an API or option you are unsure of.

## Commands

```sh
bun install          # once per checkout or worktree
bun run check        # the gate: lint, typecheck, test, build
bun run lint         # Biome lint + format check
bun run format       # apply Biome fixes and formatting
bun run typecheck    # tsc --noEmit in every package (there is no root tsconfig.json)
bun test             # every *.test.ts(x), using bun:test
bun run build        # production build of apps/web
bun run dev          # server (watch mode) + Vite dev server
```

`bun run check` must exit 0 before you hand work off. Report its real output; if a step
fails or was not run, say so.

## Conventions

- TypeScript is strict with `noUncheckedIndexedAccess`. Fix the type, do not silence it.
- Tests sit next to the code as `*.test.ts` and import from `bun:test`. Each spec rule the
  engine implements gets a test, including the edge cases the spec lists.
- The server re-validates every client action (whose turn, tile ownership, legal hand,
  beats the table) and sends each client only its own hand.
- Never hardcode a port. The server reads `$PORT`; tests bind port `0`.
- Markdown is not auto-formatted. Everything else is formatted by Biome: run
  `bun run format` instead of formatting by hand.
- Commits follow Conventional Commits, scoped by package: `feat(engine): ...`,
  `fix(server): ...`, `chore: ...`.

## Working in parallel worktrees

Work is split across git worktrees, one agent per worktree, and an orchestrator merges
the branches. To keep merges clean:

- Stay inside the files your brief assigns. Do not edit files fenced to another worktree.
- Root files (`package.json`, `biome.json`, `tsconfig.base.json`, `AGENTS.md`,
  `docs/lexio-rules.md`) belong to the orchestrator. Ask in your summary instead of
  editing them.
- Avoid new dependencies. If one is truly needed, add it to your own package (not the
  root), commit the `bun.lock` change with it, and call it out in your final summary.
- Commit to your own branch in logical steps and leave the tree clean. Do not push, merge
  or rebase onto another feature branch.
- End with a summary: commits, gate output, assumptions you made, and the manual checks
  the orchestrator should run.
