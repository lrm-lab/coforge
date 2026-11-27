---
name: lenovo-intranet
description: Lenovo intranet entry points available on this CoForge cloud computer (portal, model factories, CA/proxy). Use when opening Lenovo internal sites, when a Lenovo URL is unclear, or before diagnosing intranet reachability.
---

# Lenovo intranet directory

This cloud computer trusts the Lenovo CA and reaches Lenovo intranet hosts through the host proxy. Use this skill for entry URLs and connectivity checks. For login, registration, or form fill, follow `browser-login`.

## Do not store secrets

- Never write passwords, tokens, or MFA codes into this skill, the image, or world-readable files.
- Ask the user for credentials when a page requires them; prefer CoForge `page:fill` / `desktop:takeover` over chatting passwords in plaintext.

## Connectivity

- Lenovo CA is installed in the image.
- Outbound traffic uses the host proxy (`SANDBOX_PROXY_URL` / `LENOVO_PROXY`), rendered into Chromium policy at start.
- Inspect proxy policy: `/etc/chromium/policies/managed/lenovo-intranet.json`
- Inspect env: `echo "$HTTPS_PROXY" "$HTTP_PROXY" "$SANDBOX_PROXY_URL" "$LENOVO_PROXY"`

Quick reachability check:

```bash
curl -sI -o /dev/null -w '%{http_code}\n' --connect-timeout 5 https://home.lenovo.com/home
```

If that fails, confirm the proxy env and Chromium `ProxyServer` policy are non-empty before retrying in the browser.

## Entry points

| Name | URL | Notes |
|---|---|---|
| Lenovo intranet portal | `https://home.lenovo.com/home` | Primary internal home |
| China Model Factory | `https://modelfactory.lenovo.com/` | Domestic LLM / model factory |
| Brazil Model Factory (Aimaster) | `https://braimaster.lenovo.com/` | Brazil Aimaster / muse-spark |

Open these with `coforge-chromium` / Playwright CDP on this Agent's `DISPLAY` (see `browser-login`). Do not invent alternate hosts unless the user supplies them.

## When to load this skill

- User asks for a Lenovo intranet URL or which portal to open
- Task needs Model Factory / Aimaster / home.lenovo.com
- A Lenovo page fails to load and you need the known endpoints plus proxy/CA checks
