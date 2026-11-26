---
name: official-docs-review
description: "Pre-push official-documentation best-practices review for a CoForge diff: verifies touched React Aria, Untitled UI, Tailwind CSS v4, TanStack, Prisma, Bun, and Web/ARIA code against current official docs and installed version-pinned skills before pushing."
when_to_use: "pre-push review, check official docs best practices, audit diff against framework docs, React Aria Tailwind TanStack Prisma Bun review"
---

# Official docs review

Run this pass on every change before pushing, alongside `perf-scan` ([`REVIEW.md`](../../../REVIEW.md), [`docs/agents/delivery.md`](../../../docs/agents/delivery.md)). It checks only the changed code against current official documentation and installed version-pinned skills—never stale memory.

## Procedure

1. **Identify touched surfaces.** Read `git diff <base>...HEAD` and list each framework, library, or platform surface the changed lines use (React Aria, Untitled UI, Tailwind CSS v4, TanStack, Prisma, Bun, Web/WAI-ARIA). Skip untouched stacks.
2. **Consult primary official sources.** Prefer installed version-pinned sources first (`bunx @tanstack/intent@latest load <pkg>#<skill>`, `.agents/skills/prisma-*`, `.agents/skills/using-bun-runtime/SKILL.md`, `apps/web/src/components/base/` upstream source), then current official docs for React Aria Components, Tailwind CSS v4, Untitled UI, Motion, and WAI-ARIA APG / MDN.
3. **Audit changed lines only.** Check the diff against the stack table below. Re-read the exact line and upstream component types before reporting—a deliberate constraint in an unmodified upstream component (such as `ButtonUtility` typing `onClick` only) is not a finding.
4. **Split findings.** Fix every **must-fix** item before pushing; leave non-blocking observations for the task thread.

## Stack routing table

| Surface | Primary source | What to verify |
| --- | --- | --- |
| React Aria & Untitled UI (`apps/web/src/components/`, `features/`) | React Aria Components docs, installed `src/components/base/` source, [`components/ui/README.md`](../../../apps/web/src/components/ui/README.md) | Use official React Aria primitives (`Toolbar`, `Separator`, `Dialog`, `Tabs`, `Menu`, `Popover`) instead of hand-rolling ARIA widget roles (`role="toolbar"`, etc.) or keyboard navigation; use `onPress` (not `onClick`) on React Aria / Untitled `Button` wrappers; do not duplicate `aria-label` when `ButtonUtility` already derives it from `tooltip`; keep `base/` and `application/` unmodified. |
| Tailwind CSS v4 & CSS motion (`apps/web/src/styles/`, `*.css`, JSX) | Tailwind CSS v4 docs, [`docs/design-tokens.md`](../../../docs/design-tokens.md) | Define semantic tokens in `@theme` with `.dark-mode` pairs (no raw hex or `dark:` color overrides in JSX); nest `@media (prefers-reduced-motion: reduce)` inside custom `@utility` animations; use `backwards` (not `both`) on entrance animations so no idle `transform` compositor layer lingers; animate composite-only properties (`transform`, `opacity`). |
| TanStack Start / Router / DB / Hotkeys (`routes/`, `*.functions.ts`, `*-collection.ts`) | `bunx @tanstack/intent@latest list` & `load` | Use typed `Link` / `router.buildLocation`, preserve Router inference without casts, enforce `createServerFn` server boundaries, never materialize TanStack DB collections during SSR, and use `useHotkey` instead of manual `keydown` listeners. |
| Prisma (`apps/web/prisma/`, `src/server/db/`) | `.agents/skills/prisma-*` | Keep Prisma server-only, use UUIDv7 defaults without client-minted IDs, keep PostgreSQL semantics, and include migration safety annotations and `lock_timeout` when required. |
| Bun runtime (`apps/`, `packages/`, `scripts/`) | `.agents/skills/using-bun-runtime/SKILL.md` | Prefer Bun-native APIs (`Bun.spawn`, `Bun.serve`, `fetch`) over restricted `node:*` modules, avoid Node-only assumptions, and run tests via `isolated-test-run.ts`. |
| Web platform & WAI-ARIA | WAI-ARIA APG, MDN | Pair `aria-live="polite"` with `aria-atomic="true"` on dynamic phrases, ensure `>= 44px` (`min-h-11 min-w-11`) coarse-pointer hit targets, preserve focus rings and Escape layering, and avoid native `<button>` / `<select>` / `title`. |

## What counts as must-fix before pushing

- **Hand-rolled primitive:** recreating an ARIA widget role or keyboard interaction (`role="toolbar"`, manual roving tabindex, manual Escape/focus traps) when an installed React Aria or Untitled UI component already implements it.
- **Deprecated or discouraged API:** using a discouraged handler or legacy pattern when the official API is directly supported by the installed version (e.g. `onClick` on React Aria `Button`, legacy TanStack Router/Start/DB patterns, restricted `node:*` imports).
- **Contract violation:** breaking an official SSR, hydration, accessibility, semantic-token, or `prefers-reduced-motion` contract documented by the primary source.

## What does not block pushing

- Pre-existing code outside the diff unless the change makes it newly wrong.
- Upstream limitations in unmodified `src/components/base/` or `src/components/application/` files (such as `ButtonUtility` exposing only `onClick`).
- Purely stylistic preferences that carry no official recommendation.

## Report format

List only verified findings (`path:line`, official source checked, concrete mismatch, and minimal fix), followed by a one-line list of the official sources/skills checked for the diff.
