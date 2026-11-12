# Public homepage

These rules apply to `src/features/landing/`.

- `landing-page.tsx` is the designer's v8 (jing, #designers:#4): her artwork in `public/landing/`,
  the layout and motion in `landing-page.css`, the pointer light and click sparks in
  `use-landing-pointer-effects.ts`. Change it only from her designs; product UI changes must not
  alter it.
- On a desktop the page is one 1440 x 900 screen scaled to the window by the `--u` unit; size
  anything new in `--u` so it scales with the rest. The sign-in page's logo is placed by the same
  formula (`features/auth/login-art.css`): move one and the other must follow.
- The page is light in every theme, so it uses the design's hexes, not the app's semantic tokens.
- The headline and copy are text, so every language reads; a new language needs its copy checked
  at 1440 x 900 (the headline's two lines must not wrap) and 390 wide.
- `landing-brand-panel.tsx` is the old dark hero other public pages still reuse (invite links,
  through `features/auth/auth-split-layout.tsx`, and account settings); it keeps its Spell / Magic
  UI motion components inside this directory.
