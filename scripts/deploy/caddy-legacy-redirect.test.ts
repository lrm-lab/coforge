import { describe, expect, test } from "bun:test";

describe("legacy usercontent Caddy redirects", () => {
  test.each([
    ["staging", "staging-usercontent.coforge.cn", "https://staging.coforgeusercontent.com{path}"],
    ["production", "usercontent.coforge.cn", "https://coforgeusercontent.com{path}"],
  ] as const)(
    "%s Caddyfile redirects only GET/HEAD 43-char /p/<token> links and redacts token logs",
    async (environment, legacyHost, targetUri) => {
      const caddyfile = await Bun.file(
        new URL(`../../infra/${environment}/caddy/Caddyfile`, import.meta.url),
      ).text();
      const siteStart = /^(?=[^\s#{][^\n]* \{$)/m;
      const blocks = caddyfile.split(siteStart);

      const legacyBlock = blocks.find((block) => block.startsWith(`${legacyHost} {`));
      expect(legacyBlock).toBeDefined();
      expect(legacyBlock).toContain("method GET HEAD");
      expect(legacyBlock).toContain("path_regexp ^/p/[A-Za-z0-9_-]{43}$");
      expect(legacyBlock).toContain(`redir @legacy_public ${targetUri} permanent`);
      expect(legacyBlock).toContain("respond 404");
      expect(legacyBlock).not.toContain("dns alidns");

      const defaultSection = blocks[0]!;
      expect(defaultSection).toContain(
        'request>uri regexp "(?i)(?:/|%2f)+(?:p|%70)(?:/|%2f)+[^?#[:space:]]*" "/p/REDACTED"',
      );
      expect(defaultSection).toContain(
        'request>headers>Referer regexp "(?i)(?:/|%2f)+(?:p|%70)(?:/|%2f)+[^?#[:space:]]*" "/p/REDACTED"',
      );
      expect(defaultSection).toContain(
        'resp_headers>Location regexp "(?i)(?:/|%2f)+(?:p|%70)(?:/|%2f)+[^?#[:space:]]*" "/p/REDACTED"',
      );

      const snippet = blocks.find((block) => block.startsWith("(usercontent) {"));
      for (const section of [snippet!, legacyBlock!]) {
        expect(section).toContain("request>uri delete");
        expect(section).toContain("request>headers>Referer delete");
        expect(section).toContain("resp_headers>Location delete");
      }
    },
  );
});
