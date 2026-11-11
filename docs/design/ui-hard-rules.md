# UI hard rules for apps/web

- Hard rules for every UI change (details in `docs/design/`):
  - Mockups: a provided mockup wins over the defaults in `docs/design/`; implement it with the components and units below and update the conflicting rule in the same change. Ask before inventing data or concepts the mockup shows but the product lacks (§1).
  - Components (product UI; `features/landing` keeps its Spell / Magic UI motion components): only official Untitled UI components, unmodified, and the primitives listed in `components/ui/README.md`, per §7 including its exceptions. Icons only from `@untitledui/icons`; a file's type glyph from `@untitledui/file-icons`, reached only through `features/files/file-type-icon.tsx`; vendor logos from `@lobehub/icons-static-svg`, or the vendor's own vector mark kept beside its user with its source noted in the file.
  - Sizes: anything affecting layout or reading uses rem — the Tailwind scale or a rem arbitrary value such as `w-[18rem]`; never `w-[280px]`, `text-[10px]`, or numeric inline `style` sizes. px only for hairlines, stroke widths, shadows/blur, and positions and sizes measured from the DOM (§12).
  - Colors: semantic tokens only, no hex or `dark:` color overrides (§11).
  - People: show a person by `humanLabel` (`src/lib/human-label.ts`), never as `@username`, and do not search by username; an Agent keeps its `@handle`.
  - Feedback: a toast only confirms an action; anything the user must see, handle, or come back to stays inline (§13). Toasts go through `AppToastProvider`; do not add a second notification system.
