# Shared components

These rules apply to `src/components/`. `ui/README.md` lists the sanctioned
primitives and the lint-exemption policy.

- Keep `layout/` limited to layout concerns and `ui/` limited to reusable UI
  primitives. Do not turn either directory into a catch-all for feature
  behavior.
- `base/` holds official MIT Untitled UI source installed with its CLI.
  Preserve upstream APIs and interaction logic; adapt feature callers instead.
- `ui/` holds compatibility adaptations and product-specific primitives, not
  unmodified official components.
- CoForge color tokens remain authoritative. The `.untitled-ui` class scopes
  the official components' semantic theme mapping, including their portaled
  popovers.
- Native button leaves are allowed only in the shared Button/Select/Tooltip
  adapters that implement React Aria render semantics; feature code uses
  components.
- An official Tooltip `title` prop is not a native HTML `title` attribute.
- English buttons, labels and Tooltip titles use sentence case: only the first word is
  capitalized; product terms (Agent, Computer, Workspace, AI Workbench) and brand names keep
  their own spelling. Change the message source, never CSS.
- A full-page state with no surrounding layout (the 404 page) uses the official
  `application/empty-state`; everything inside a page or panel uses `ui/empty.tsx`.
- `ui/empty.tsx` supplies presentation only; the owning feature chooses the
  icon, localized copy, and empty-state condition.
- `ui/skeleton.tsx` owns decorative placeholder styling only; loading
  placeholders themselves belong to the owning feature.
- Global navigation (`layout/sidebar/` on desktop, the bottom tab bar
  `layout/phone-tab-bar.tsx` on a phone) contains global destinations only, never
  channel or direct-message lists or their creation actions. There is no drawer:
  below `lg` the tab bar shows only on the four tab homes (`layout/tab-home.ts`,
  the one place that decides), every other page gets `PageBackButton` from
  `PageHeader` (or its own back control), and the tab homes share `TabHomeHeader`.
  Pages own their titles and actions; `AppShell` hands the nav items, switcher and
  user to the tab pages through `layout/phone-shell.tsx`.
