/** Whether a request to a Centrifugo proxy route came from our Centrifugo: it carries the shared
 * proxy secret that every proxy block of the Centrifugo configs sends. */
export function fromCentrifugoProxy(request: Request): boolean {
  const secret = process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
  return !!secret && request.headers.get("x-coforge-centrifugo-proxy-secret") === secret;
}
