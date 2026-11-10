# Artifacts and web pages (`coforge artifact`)

A conversation (a channel or a DM) or the Workspace keeps two kinds of page, each with every
version it had. Whoever can read the conversation reads them. The Workspace must have artifacts
switched on (Settings > Experiments); until then every command fails with `ARTIFACTS_DISABLED`.

## Which one to make

- **An artifact** (`coforge artifact create`, Markdown text) is text people write and edit together:
  a plan, a report, notes, a spec. People and Agents both save it.
- **A web page** (`coforge artifact create --kind html`) is something to look at: a dashboard,
  several options side by side, an annotated diff, a timeline, a small interactive explainer.
  Only Agents save it, and each save replaces it whole. People view it, read its source and
  history, and go back to an older version; to change it they ask an Agent.

When in doubt, make an artifact: anything people will want to edit, or that is mostly prose, is an
artifact.

Web pages are not open in every Workspace yet. Where they are not, `create --kind html` fails
with `artifact-web-pages-off`: make an artifact instead.

## Writing a web page

- One self-contained `index.html`, at most 2 MiB. Put styles in `<style>`, scripts in inline
  `<script>`, and images as `data:` URLs. Nothing outside loads: no CDN script or stylesheet, no
  web font, no remote image.
- Its own inline scripts run (tabs, toggles, sorting, drawing a chart on a `<canvas>`), but the
  page cannot reach the network at all: no `fetch`, no form submission, no WebSocket, no WebRTC,
  no navigating away, no pop-ups, no cookies or storage. Put the data in the page.
- It is shown as it is written in light and dark mode alike; give it its own background and text
  colours. `prefers-color-scheme` in your CSS is fine.
- `--description` is required: one line saying what the page shows. It is the line on the page's
  card in the conversation.

```sh
coforge artifact create --kind html --title 'Signup funnel, week 44' \
  --description 'Signups and activation by day, with a toggle per channel' \
  --target '#growth' --file index.html
```

## Reading and saving

- `coforge artifact read <id> [--output index.html]` prints the version line, then the text (a
  artifact's Markdown, a page's HTML).
- `coforge artifact push <id> --base <n> --file <path>` saves over version `n`, which must be the
  newest version — the one your latest `read` showed. When someone saved since `n`, the push is
  refused (`artifact-agent-base-moved`): read the newest version, redo your change on it, and
  push over that. Nothing is merged for you; a save never writes over a newer version.
- `coforge artifact history <id>` and `coforge artifact revert <id> --to <n> --base <current>` work
  the same for both.

A push or revert that failed on the network may still have landed: read before trying again.
