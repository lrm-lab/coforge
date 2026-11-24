---
name: ui-delivery
description: "Pre-delivery workflow and verification gate for every apps/web UI change: mockup confirmation before coding design changes, same-size and same-data labeled before/after screenshots, light + dark + 390px phone checks, break-ui stress pass, skills report, branch web-e2e coordination, and the required UI-Evidence commit section."
when_to_use: "apps/web UI change, frontend component or CSS edit, before/after screenshots, UI review handoff, UI-Evidence commit message"
---

# UI delivery

Use this skill for every visual, layout, style or interaction change under `apps/web/src/`. Read [`apps/web/AGENTS.md`](../../../apps/web/AGENTS.md), [`docs/design/README.md`](../../../docs/design/README.md), [`docs/design/ui-hard-rules.md`](../../../docs/design/ui-hard-rules.md) and [`docs/design/ui-principles.md`](../../../docs/design/ui-principles.md) before editing UI code.

## 1. Pick the right track before coding

- **Visual, layout, style, or hierarchy change (full track)**: **设计改动先出示意图，jing/Frank 确认后再写代码。** Post a mockup or visual prototype comparison (desktop + `390px` phone, light + dark) and wait for confirmation from jing (`@qq971766802`) or Frank (`@user`) before writing production code.
- **Settled-spec bug fix or confirmed parameters**: proceed directly to code, still completing the visual checklist below.
- **Pure interaction, state, or plumbing fix in `.tsx`** (zero layout, spacing, typography, or color delta — e.g. Escape/focus handler, resize guard, aria label, query wiring): skip the design mockup and `modern-web-guidance`; cover the logic with pure unit or integration tests and declare the non-visual reason in `UI-Evidence: exempt — <reason>`.

## 2. Pre-implementation checks

- Follow [`docs/design/ui-hard-rules.md`](../../../docs/design/ui-hard-rules.md): unmodified official Untitled UI primitives, `rem` layout/type sizing, semantic color tokens only (never raw hex or `dark:` color overrides), `humanLabel` for people, and avatars on every conversation or target row (never `#`).
- Run `modern-web-guidance` (`search` then `retrieve`) when authoring or changing custom HTML, CSS, or browser DOM APIs (skip it for routine React state, query hooks, or composing existing Untitled UI primitives); our design rules win on conflict, and any conflict is noted in the delivery report.

## 3. Pre-delivery checklist

Every item below must be completed before committing a visual `feat` or `fix` UI change and requesting review:

1. **Same-size, same-data before/after screenshots with labels**:
   - Render `origin/main` (`改动前`) and the branch (`改动后`) against identical seed data, viewport size and scroll/crop coordinates.
   - Draw visible `改动前` / `改动后` labels on the comparison image; add zoomed detail crops when checking borders, spacing, typography or rings so the delta is unmistakable at normal reading size.
   - Upload attachments directly to the target thread or task ref (use JPEG when a PNG exceeds ~1 MB).
2. **Light + dark + phone (`390px`)**:
   - Verify and capture desktop light, desktop dark, and phone (`390px` wide, e.g. `390×844`) in both light and dark themes.
3. **`break-ui` stress pass (what ran & what was found)**:
   - Exercise long unbroken strings and CJK names, boundary counts (`0`, `1`, `99+`, `128+`), empty/loading/error states, narrow flex truncation (`min-w-0`), keyboard Tab/Escape/focus-visible rings and `44px` touch targets.
   - Record both **what scenarios ran** and **what was fixed or verified clean**.
4. **Skills used**:
   - Name each skill used (`ui-delivery`, `modern-web-guidance`, `emil-design-eng` / `apple-design`, `unslop`, `animate`, `break-ui`, etc.) and the specific problem each solved.
5. **Local checks, official-docs review, test policy & branch `web-e2e`**:
   - Run [`official-docs-review`](../official-docs-review/SKILL.md) over the diff (React Aria primitives, `onPress`, Tailwind v4 tokens/motion, WAI-ARIA) before pushing.
   - Run `mise run test`, `mise run check` and `mise run build` locally before pushing the branch.
   - **UI 改动不新增浏览器 e2e（Frank 11-17）**：do not add browser e2e specs or component-render unit tests ([`docs/agents/testing.md`](../../../docs/agents/testing.md#ui-verification-policy)) for ordinary UI changes. Cover logic and interactions with pure unit tests, server/DB integration tests or `ui:sweep`, and run existing `web-e2e` on the branch to verify nothing regressed. New browser e2e specs are reserved strictly for critical end-to-end user flows (`E2E-Flow:` commit description).
   - Push the feature branch and report the affected existing browser e2e specs in the task reply so the coordinator (`@coforge-raft`) schedules `web-e2e` (workflows share one pending slot; do not self-dispatch unless asked). Read every e2e result line before reporting pass or pushing to `main`.

## 4. Required `UI-Evidence:` commit section (and visible exemption)

The `ui-evidence` hard rule ([`docs/agents/git-hooks/hard-rules.md`](../../../docs/agents/git-hooks/hard-rules.md)) blocks any newly pushed `feat` or `fix` commit touching UI files (`.tsx` or `.css` under `apps/web/src/`, excluding `server/`, `routes/api/`, `*.server.*`, `*.functions.*`, generated files and tests) unless its commit message carries a complete `UI-Evidence:` section before `Revert-effect:`. Pure `refactor` and `test` commits are exempt by commit type.

```text
feat(web): show unread thread count in conversation capsule

UI-Evidence:
- screenshots: 135-desktop-compare.jpg, 135-phone-compare.jpg (01a1e85e-f9ad-7000-8000-000000000001)
- themes-viewports: light, dark, phone (390px)
- break-ui: tested +128 count overflow, long CJK channel names, muted + @ state and keyboard focus rings; pill expands cleanly

Revert-effect: channel rows revert to top-level unread count only
```

**When screenshots genuinely cannot be captured or add no signal** — a pure interaction/state/aria fix with zero visual delta, a small tweak pushed directly from Frank's own session, an urgent rollback/hotfix, or a remote sandbox without Docker/PostgreSQL to run `verify-web` (paired with unit/build verification and staging visual confirmation) — declare an explicit, non-empty reason with `UI-Evidence: exempt — <reason>`:

```text
UI-Evidence: exempt — single aria-label typo fix with zero visual or layout change
```

Empty or placeholder reasons (`none`, `skip`, `todo`) are rejected. Valid exemptions pass the hook and CI while printing a `::warning::` and CI step-summary entry so reviewers see every use.

## 5. Delivery report template

Include in the review reply:
- **Outcome & commit**: branch name + `$(git rev-parse --short HEAD)`, summary of what changed.
- **Screenshots**: attached same-size, same-data `改动前 / 改动后` comparisons covering desktop light/dark and `390px` phone light/dark.
- **`break-ui` findings**: scenarios tested and issues caught/fixed.
- **Skills & Modern Web Guidance**: which skills ran and what each solved.
- **Verification & `web-e2e`**: local check results, affected UI manual checklist, and existing browser e2e specs to run on the branch.
