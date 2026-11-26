import page from "@vmbridge/web/index.html";
import watchPage from "@vmbridge/web/watch.html";
import { withSecurityHeaders } from "../security-headers.ts";

const pages = { "/dashboard": page, "/dashboard/onboarding": page };

const notFound = (method?: string) => withSecurityHeaders(new Response(method === "HEAD" ? null : "Not found", { status: 404 }));

/** Resolves a request path against the internal asset server without letting protocol-relative paths escape its origin. */
export function assetUrl(requestUrl: string, base: URL): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  const { pathname, search } = parsed;
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return null;
  const target = new URL(base);
  target.pathname = pathname;
  target.search = search;
  return target.origin === base.origin ? target : null;
}

/**
 * Bun.serve cannot add headers to an HTML import's routes, so the dashboard is bundled and served by a server only
 * this process talks to, and every listener passes its responses on with the security headers. Its bundled files
 * (script, styles, icons) are then there on every listener from the start, the tunnel's included. The watch page
 * (see watch/watch.ts) is bundled there too, at a path only this process asks for: the bridge serves it under each
 * link's own address, with its own headers.
 *
 * In development each listener serves the pages itself, without the headers: Bun's hot reloading needs its own socket
 * and an inline script, which would not get through. The watch page is then at `/watch/<anything>`, token or not.
 */
export async function openDashboard(development: boolean) {
  if (development) {
    return {
      routes: { ...pages, "/watch/:token": watchPage },
      fetch: null,
      watchPage: async () => new Response("The watch page is served by the dev routes.", { status: 503 }),
      stop: async () => {},
    };
  }
  const files = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    routes: { ...pages, "/watch-page": watchPage },
    fetch: () => new Response("Not found", { status: 404 }),
  });
  const base = new URL(files.url);
  // Bun adds the bundled files' routes only once the page was served.
  await Promise.all(["/dashboard", "/watch-page"].map((path) => fetch(new URL(path, base)).then((response) => response.arrayBuffer(), () => {})));
  return {
    routes: {},
    fetch: async (request: Request) => {
      const target = assetUrl(request.url, base);
      if (!target) return notFound(request.method);
      const etag = request.headers.get("if-none-match");
      const response = await fetch(target, {
        method: request.method,
        headers: etag ? { "if-none-match": etag } : {},
        redirect: "manual",
      });
      return withSecurityHeaders(response);
    },
    watchPage: () => fetch(new URL("/watch-page", base)),
    stop: () => files.stop(true),
  };
}
