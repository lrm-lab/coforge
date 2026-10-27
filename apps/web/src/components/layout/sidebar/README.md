# `src/components/layout/sidebar/` — the one sanctioned copy-and-adapt exception

`application/app-navigation/sidebar-navigation/sidebar-simple.tsx` and
`sidebar-slim.tsx` are official but are demo templates, not parameterized
components: they hardcode Untitled's own logo, a search box, and a fake
"Olivia Rhye" account card, and have no props for CoForge's actual
requirements (brand logo, no search, real account menu, resizable width).
They are copied into `src/components/layout/sidebar/` and adapted there —
once copied, they're CoForge's own code, no longer bound by "official source
unmodified". Everything they call into stays untouched: `app-navigation/
base-components/**` (`NavItemBase`, `NavButton`, `NavList`,
`MobileNavigationHeader`, `NavAccountCard`) and `components/base/**`.
