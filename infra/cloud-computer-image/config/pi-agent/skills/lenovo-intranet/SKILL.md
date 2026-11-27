---
name: lenovo-intranet
description: Lenovo intranet entry points, CA/proxy checks, and Forms-first login on this CoForge cloud computer. Use when opening Lenovo internal sites, when a Lenovo URL is unclear, when a browser-native auth dialog blocks intranet access, or before diagnosing intranet reachability.
---

# Lenovo intranet directory

This cloud computer trusts the Lenovo CA and reaches Lenovo intranet hosts through the host proxy. Use this skill for entry URLs, connectivity checks, and **when to prefer Forms login**. For browser mechanics and `page:fill`, follow `browser-login`.

## Do not store secrets

- Never write passwords, tokens, or MFA codes into this skill, the image, or world-readable files.
- Prefer CoForge `page:fill` / `desktop:takeover` over chatting passwords in plaintext.

## Why Forms-first on this machine

Lenovo intranet SSO often offers both:

1. **Browser-native HTTP auth** (Negotiate / NTLM / Basic) — Windows domain tickets; Linux cloud computers have none, so the dialog loops or fails. **`page:fill` cannot drive this dialog.**
2. **Embedded HTML Forms login** — username/password (+ OTP) in the page; works here with `page:fill`.

On this cloud computer, **always prefer Forms**. Auth may appear on first load, after a click, during an SSO redirect, or mid-task when a cookie expires—treat it as a gate that can show up more than once.

## Why Chromium never “just opens” the Forms page

Lenovo ADFS (`stscn.lenovo.com`) **routes by User-Agent**:

| Client User-Agent | What ADFS returns |
|---|---|
| Normal browser (`Mozilla/…`, Chrome, etc.) | `302` → `/adfs/ls/wia` → Chromium native Sign in dialog (Negotiate/NTLM). **No HTML form.** |
| Non-browser (`curl/…`, `Wget/…`, `python-requests/…`) | `200` HTML Sign In with `userNameInput` / `passwordInput` (Forms + OTP). |

So with stock Chromium you **cannot** bookmark a Forms URL and land on the form: the IdP deliberately sends browsers to WIA. Canceling the native dialog also often does **not** fall through to Forms (retrying `/adfs/ls/` still 302s to `/wia`). Refreshing makes it worse.

## Login playbook (intranet) — Forms pre-login is mandatory

Do **not** open the business URL first under a normal browser UA. Warm SSO **before** other intranet work:

1. **Remember the business URL**; do not navigate there yet under Chrome’s default UA.
2. **Force the Forms HTML response** (required when no usable session):
   - On this Agent’s Chromium/Playwright CDP session, set User-Agent to a non-browser value for the login navigation only, e.g. `curl/8.0` (Playwright: `browser.new_context(user_agent="curl/8.0")`, or CDP `Network.setUserAgentOverride`).
   - Then open a warm entry: `https://home.lenovo.com/home` (or POST/follow the same SSO the portal uses). You should get an **HTML** Sign In page (`page-fill.py --inspect` sees `userNameInput` / `passwordInput`), **not** the native dialog.
   - Complete login with `page:fill` (ITCode / password / OTP as shown).
   - After SSO succeeds, **restore a normal Chrome UA** (or use a fresh context with default UA) for business pages; cookies from Forms login should still apply.
3. **Then** open the business URL and continue.
4. If a native `/wia` dialog appears anyway: **do not refresh**. Either switch UA as above and redo warm login, or `desktop:takeover`. Do not Sign in on the native dialog.
5. If Forms HTML still never appears, `desktop:takeover` and ask the user for a known Forms path. **Do not invent hosts.**

### When a native dialog or `/adfs/ls/wia` appears mid-task

That means the request used a browser UA. Stop refreshing. Re-run step 2 (non-browser UA → Forms → `page:fill` → restore UA → return to business URL), or `desktop:takeover`.

## Connectivity

- Lenovo CA is installed in the image.
- Outbound traffic uses the host proxy (`SANDBOX_PROXY_URL` / `LENOVO_PROXY`), rendered into Chromium policy at start.
- Inspect proxy policy: `/etc/chromium/policies/managed/lenovo-intranet.json`
- Inspect env: `echo "$HTTPS_PROXY" "$HTTP_PROXY" "$SANDBOX_PROXY_URL" "$LENOVO_PROXY"`

Quick reachability check:

```bash
curl -sI -o /dev/null -w '%{http_code}\n' --connect-timeout 5 https://home.lenovo.com/home
```

If that fails, confirm the proxy env and Chromium `ProxyServer` policy are non-empty before retrying in the browser. A `401` with Negotiate/NTLM is often “auth required”, not “network down”—switch to Forms rather than treating it as a proxy failure.

## Entry points

| Name | URL | Notes |
|---|---|---|
| Lenovo intranet portal | `https://home.lenovo.com/home` | Primary internal home; expect auth at variable times—Forms-first |
| China Model Factory | `https://modelfactory.lenovo.com/` | Domestic LLM / model factory; same auth pattern |
| Brazil Model Factory (Aimaster) | `https://braimaster.lenovo.com/` | Brazil Aimaster / muse-spark; same auth pattern |

Open these with `coforge-chromium` / Playwright CDP on this Agent's `DISPLAY` (see `browser-login`). Do not invent alternate hosts unless the user supplies them.

Verified warm entries (Forms only if User-Agent is non-browser — see playbook):

| Site | Entry | Notes |
|---|---|---|
| Lenovo intranet (SSO warm) | `https://home.lenovo.com/home` | With `curl/8.0` UA → HTML Forms; with Chrome UA → `/wia` native dialog |
| ADFS IdP sign-on | `https://stscn.lenovo.com/adfs/ls/idpinitiatedsignon.aspx` | Same UA split; browser Sign in still goes to `/wia` |

There is no separate Forms-only host URL for this IdP. The Forms **page** is the same SSO endpoint returning different HTML when UA is non-browser.

## When to load this skill

- User asks for a Lenovo intranet URL or which portal to open
- Task needs Model Factory / Aimaster / home.lenovo.com
- A Lenovo page fails to load, shows a native auth dialog, or needs Forms vs Negotiate guidance
- Connectivity / CA / proxy checks for Lenovo hosts
