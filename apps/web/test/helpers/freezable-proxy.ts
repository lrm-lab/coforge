type Link = {
  frozen: boolean;
  client: Bun.Socket<Link>;
  upstream?: Bun.Socket;
  early: Uint8Array[];
};

/**
 * A TCP proxy to `target` for tests of a connection that stops answering without closing — what a
 * NAT or proxy silently dropping an idle connection leaves behind (task #348). `freeze()` makes
 * every connection open so far swallow traffic both ways; connections opened later pass. `cut()`
 * closes every connection and refuses new ones until `restore()`: Redis or PostgreSQL down.
 */
export function freezableProxy(target: URL) {
  if (!target.port) throw new Error("freezableProxy needs a target URL with a port");
  const links = new Set<Link>();
  let opened = 0;
  let refusing = false;
  const server = Bun.listen<Link>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        if (refusing) {
          client.end();
          return;
        }
        opened += 1;
        const link: Link = { frozen: false, client, early: [] };
        client.data = link;
        links.add(link);
        void Bun.connect({
          hostname: target.hostname,
          port: Number(target.port),
          socket: {
            open(upstream) {
              link.upstream = upstream;
              for (const chunk of link.early.splice(0)) upstream.write(chunk);
            },
            data(_upstream, chunk) {
              if (!link.frozen) client.write(chunk);
            },
            close() {
              client.end();
            },
          },
        });
      },
      data(client, chunk) {
        const link = client.data;
        if (!link || link.frozen) return;
        if (link.upstream) link.upstream.write(chunk);
        else link.early.push(new Uint8Array(chunk));
      },
      close(client) {
        if (!client.data) return;
        client.data.upstream?.end();
        links.delete(client.data);
      },
    },
  });
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(server.port);
  return {
    url: url.toString(),
    opened: () => opened,
    freeze() {
      for (const link of links) link.frozen = true;
    },
    cut() {
      refusing = true;
      for (const link of links) link.client.end();
    },
    restore() {
      refusing = false;
    },
    stop: () => server.stop(true),
  };
}
