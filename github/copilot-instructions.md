# Repository AI Instructions

## General Rules

- Never push directly to main.
- Always create a branch and Pull Request.
- Keep changes as small as possible.
- Prefer fixing root causes over workarounds.
- Do not disable CI checks.
- Do not bypass TypeScript using broad `any`.
- Do not remove tests to make builds pass.

## Required Checks

All PRs must pass:

- repo-audit
- typecheck
- build
- test

## Coding Standards

### TypeScript

- Prefer strict typing.
- Avoid `any`.
- Reuse existing interfaces.
- Do not introduce duplicate types.

### React

- Prefer existing UI patterns.
- Keep components focused.
- Avoid unnecessary re-renders.

### API

- Preserve backward compatibility.
- Maintain existing endpoint contracts.
- Add tests when changing API behavior.

## Pull Requests

Every PR must include:

### Summary

What changed.

### Reason

Why the change was needed.

### Test Plan

Commands executed:

```bash
pnpm typecheck
pnpm build
pnpm test
