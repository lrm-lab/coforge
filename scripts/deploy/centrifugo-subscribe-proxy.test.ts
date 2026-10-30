import { expect, test } from "bun:test";

type Proxy = {
  endpoint: string;
  include_connection_meta?: boolean;
  http?: { static_headers?: Record<string, string> };
};
type Config = {
  client: { proxy: { connect: { endpoint: string } } };
  channel: {
    proxy: Record<string, Proxy>;
    namespaces: {
      name: string;
      subscribe_proxy_enabled?: boolean;
      sub_refresh_proxy_enabled?: boolean;
    }[];
  };
};

// A browser page subscribes to these without a token: each must ask the Web, or Centrifugo refuses
// the tokenless subscription outright. A daemon's channels are subscribed server side and are not.
const BROWSER_NAMESPACES = ["agent", "agentstatus", "chat", "presence", "runtimeauth"];

test("every Centrifugo asks the Web it connects through before a page holds a channel", async () => {
  for (const path of [
    "../../infra/centrifugo/config.yaml",
    "../../infra/staging/centrifugo/config.yaml",
    "../../infra/production/centrifugo/config.yaml",
  ]) {
    const config = Bun.YAML.parse(await Bun.file(new URL(path, import.meta.url)).text()) as Config;
    const web = config.client.proxy.connect.endpoint.replace(/\/api\/internal\/.*$/, "");
    for (const [proxy, route] of [
      ["subscribe", "centrifugo-subscribe"],
      ["sub_refresh", "centrifugo-sub-refresh"],
    ] as const)
      expect({ path, proxy, ...config.channel.proxy[proxy] }).toMatchObject({
        path,
        proxy,
        endpoint: `${web}/api/internal/${route}`,
        // The Web refuses a daemon's connection by its meta.
        include_connection_meta: true,
        http: {
          static_headers: {
            "X-CoForge-Centrifugo-Proxy-Secret": "${CENTRIFUGO_VAR_RPC_PROXY_SECRET}",
          },
        },
      });
    const proxied = config.channel.namespaces
      .filter((namespace) => namespace.subscribe_proxy_enabled)
      .map((namespace) => namespace.name);
    const refreshed = config.channel.namespaces
      .filter((namespace) => namespace.sub_refresh_proxy_enabled)
      .map((namespace) => namespace.name);
    expect({ path, proxied: proxied.sort(), refreshed: refreshed.sort() }).toEqual({
      path,
      proxied: BROWSER_NAMESPACES,
      refreshed: BROWSER_NAMESPACES,
    });
  }
});
