import { useMediaQuery } from "#src/hooks/use-media-query";

/**
 * The browser-tab icon, one fixed-colour file per browser colour scheme, swapped when the scheme
 * changes. Not a single SVG with a `prefers-color-scheme` rule: Chrome rasterizes a favicon once
 * per URL and kept showing the dark-scheme bitmap, white ring and all, on a light tab strip. Not two
 * links with `media` either: Firefox ignores `media` on icons
 * (https://bugzilla.mozilla.org/show_bug.cgi?id=1603885). Safari follows neither the rule
 * (https://bugs.webkit.org/show_bug.cgi?id=309949) nor a scripted swap, so it keeps the icon it
 * loaded with. The scheme is the browser's, not the app's theme: the tab strip follows the browser.
 */
export function Favicon() {
  const dark = useMediaQuery("(prefers-color-scheme: dark)", false);
  return (
    <link
      rel="icon"
      type="image/svg+xml"
      href={dark ? "/favicon-dark.svg" : "/favicon-light.svg"}
    />
  );
}
