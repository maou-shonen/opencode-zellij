# AGENTS.md

## Development

Use Bun for this project.

```bash
bun install
bun run build
```

Useful checks:

```bash
bun run typecheck
bun run test
bun run build
```

Real Zellij integration tests are opt-in because they create and close live panes:

```bash
bun run test:integration
```

They require running inside Zellij or setting `ZELLIJ_SESSION_NAME` to a live Zellij session.
