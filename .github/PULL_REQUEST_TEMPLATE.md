<!-- Conventional Commits subject: feat|fix|chore|docs|test|ci: ... -->

## Summary

<!-- What changes and why. Link the ticket (e.g. UP-N) if one exists. -->

## Checklist

- [ ] Tests added/updated for the behavior change
- [ ] `pnpm test` (and `pnpm --filter @uptime/web typecheck` when `apps/web` changed) green locally
- [ ] Docs updated (README / SPEC / `CHANGELOG.md` under *Unreleased* / in-app `/docs`) in the same change
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm coverage`, `.agentic/bin/validate`, `.agentic/bin/docs-check` green
- [ ] No real secrets, `.env` files or instance data committed
