# What an artifact page can call

Part of `coforge manual get artifacts`, which covers writing the page itself.

When CoForge shows the page, `window.coforge.use(name)` resolves to a frozen object for one
capability, or to `null` when the host does not answer within about 3 seconds (the page opened in
a tab of its own, or not by CoForge) or does not offer it. Check for `null` and keep working.

```js
const user = await window.coforge.use("user");
const who = user && (await user.get()); // { displayName, kind: "person" }
```

- `user.get()` returns the viewer's display name and kind.
- `artifact.get()` returns `{ id, title, version, entryPath }`.
- `clipboard.copy(text)` copies text; call it from a click, a call outside one is refused. CoForge
  writes the clipboard and tells the reader.
- `downloads.save(file, name)` saves a `Blob` (or text `string`, up to 25 MiB) to the reader's
  downloads folder; call it from a click, a call outside one is refused.
- `links.open(url)` asks to open an `http` or `https` address in a new tab. CoForge shows the
  address and the reader decides; a page whose requests are declined three times is muted.
- `comments.open(anchor, { draft })` suggests a comment to the reader and resolves `true` when a
  comment box opened, `false` when none did (outside a click in the page, or while the reader is
  writing, sending a review, or answering another request of the page). `anchor` is a name
  (`A-Z a-z 0-9 . _ ~ : / # -`, up to 256 characters) or `{ name, label?, quote? }` (`label` up to
  200 characters, `quote` up to 2000: the excerpt the comment is about). `draft` (up to 2000
  characters, no invisible or direction-control characters) fills the box as text the reader edits;
  CoForge says the page suggested it, and nothing is posted unless the reader sends it. Call it
  from a click; up to 30 calls a minute. It reads no comments back.
- People comment on an element or a text selection of the page without any call from it: CoForge
  drives that itself, over the same channel, while the reader has comment mode on. The page cannot
  start the picker, read the comments, or send a comment for the reader. It does choose what it
  reports as picked or selected, so the reader always sees the element's label or the quoted text in
  the comment box before sending, and nothing is posted unless the reader sends it. A page
  sees the count of comments and the page's own text each one anchors to, never who wrote them or
  what they say. Keep elements findable across versions: give the ones people will comment on a
  stable `id` or `data-testid`.

- `db` is a store of JSON documents everyone who sees the page shares: `get(collection, id)`,
  `query(collection, { where, orderBy, limit, after })`, `watch(collection, query, onChange)`,
  `set`, `update` (merges top-level fields), `delete` and `batch(ops)`. Reading and watching are
  open to every viewer; writing is for signed-in Workspace members, and CoForge asks the reader
  once per page view before the first write. `set`, `update` and `delete` take `{ ifVersion }`
  and reject with `artifact-data-version` when the document moved on.
- `assets` is the page's file library, apart from its pushed files: `list()`, `url(name)`,
  `upload(file, name)` and `delete(name)`. Listing and loading are open to every viewer; an
  upload needs the reader's yes each time, and a delete is for who manages the page's sharing.

```js
const db = await window.coforge.use("db");
const stop = await db.watch("votes", { orderBy: { field: "at" } }, (result, error) => {
  if (!error) render(result.documents.map((doc) => doc.data));
});
await db.set("votes", `${who.displayName}`, { choice: "b", at: Date.now() });
```

`query` and `watch` return `{ documents: [{ id, data, version, updatedAt }], next }`; `where`
matches top-level fields by equality, `limit` is at most 200, and `next` goes back as `after`.
`watch` calls `onChange` at once and again after every change, with the whole result; the
function it returns stops it (20 at most). A collection or document id is up to 64 or 128 of
letters, digits and `._-` (ids also `:`); a document is at most 64 KiB, a page keeps at most 5 MiB
and 10,000 documents, and a batch at most 50 writes. An asset is an image, audio, video, PDF,
JSON, CSV or text file of at most 10 MiB (200 per page); its type comes from its bytes, and
HTML, scripts and SVG are refused. `assets.url(name)` loads from `<img>`, `<audio>`, `<video>` and
`fetch` on the page's own origin.

Every call can fail: it rejects when refused, declined or sent too often (30 a minute per
method; 600 for `db`). The page's own errors are reported to the reader with a button that asks you to fix them.
CoForge sets `data-theme="light"` or `"dark"` on `<html>` and fires a `coforge:theme` event on
`window` when the theme changes.
