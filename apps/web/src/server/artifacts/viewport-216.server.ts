import page from "./viewport-216.html.txt?raw";

export function viewportDiagnostic(
  request: Request,
  sandboxOrigin: string | null,
): Response | null {
  const url = new URL(request.url);
  if (
    sandboxOrigin !== "https://staging.coforgeusercontent.com" ||
    url.host !== "qa-216.staging.coforgeusercontent.com" ||
    url.pathname !== "/viewport/index.html" ||
    url.search
  )
    return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  return new Response(request.method === "HEAD" ? null : page, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'sha256-0jky19+2u4sgdbU5b/3wNnX3Hye6t2oItGgCdAPooYs='; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
