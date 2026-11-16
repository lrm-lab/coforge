import type { Site } from "./artifact-sandbox-site";

export const dataPage = (): Site => ({
  entry: "index.html",
  files: {
    "index.html": `<!doctype html><html><head><title>data</title></head><body><p>data page</p><script>
const post = (data) => top.postMessage({ page: "data", role: window.name, ...data }, "*");
const settle = (promise) => promise.then((value) => ({ ok: value }), (error) => ({ error: error.message }));
(async () => {
  const db = await coforge.use("db");
  const assets = await coforge.use("assets");
  post({ ready: true, db: Object.keys(db).sort(), assets: Object.keys(assets).sort(), frozen: Object.isFrozen(db) });
  await db.watch("notes", { orderBy: { field: "n" } }, (result, error) =>
    post({ watch: result ? result.documents.map((doc) => doc.data.text) : null, error: error && error.message }),
  );
  addEventListener("message", async (event) => {
    const m = event.data;
    if (!m || !m.cmd) return;
    if (m.cmd === "set") post({ set: await settle(db.set("notes", m.id, m.data)) });
    if (m.cmd === "batch") post({ batch: await settle(db.batch(m.ops)) });
    if (m.cmd === "get") post({ get: await settle(db.get("notes", m.id)) });
    if (m.cmd === "upload") post({ upload: await settle(assets.upload(new Blob([m.text]), m.name)) });
    if (m.cmd === "list") post({ list: await settle(assets.list()) });
    if (m.cmd === "delete") post({ delete: await settle(assets.delete(m.name)) });
    if (m.cmd === "fetchAsset") {
      const url = assets.url(m.name);
      post({ fetchAsset: await settle(fetch(url).then((r) => r.text().then((text) => ({ status: r.status, text, type: r.headers.get("content-type"), url })))) });
    }
    if (m.cmd === "fetchOther") post({ fetchOther: await settle(fetch(assets.url("../index.html")).then((r) => r.status)) });
  });
})();
</script></body></html>`,
    "asset-source.txt": "from the library",
  },
});
