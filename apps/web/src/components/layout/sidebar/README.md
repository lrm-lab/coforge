# `src/components/layout/sidebar/` — the one sanctioned copy-and-adapt exception

The official `application/app-navigation/sidebar-navigation/sidebar-simple.tsx`
and `sidebar-slim.tsx` are demo templates, not parameterized components: they
hardcode Untitled's own logo, a search box, and a fake "Olivia Rhye" account
card, and have no props for CoForge's actual requirements (brand logo, no
search, real account menu, resizable width). They were copied into
`src/components/layout/sidebar/` and adapted there, then removed from this
repository; `npx untitledui@latest add` fetches them again for a future copy.
Once copied, they're CoForge's own code, no longer bound by "official source
unmodified". Everything they call into stays untouched: `components/base/**`.
