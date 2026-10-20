# Panel tab order

These rules apply to `src/features/panel-tabs/`.

- Each member's tab order is persisted per Workspace membership through
  `WorkspaceMemberPreferences`. Panels resolve their default tab from it; do
  not add a per-panel store.
- Save through the Workspace-layout-level provider in `panel-tab-order-context.tsx`,
  which applies optimistic, serialized saves. Tab strips render through
  `components/ui/reorderable-tab-strip.tsx`.
- A strip with more tabs than room scrolls sideways inside an element its caller owns and passes
  as `scrollRef`, and keeps the selected tab in view there (`hooks/use-active-tab-in-view.ts`, as
  Raft's tab list does): on open, on a change of tab, when tabs arrive and on resize; it glides
  only without reduced motion. A vertical wheel over the strip scrolls it sideways only while it
  can still move that way; at either end the wheel scrolls the panel around it as usual. Do not
  wrap the strip or add an overflow menu.
