import page from "@vmbridge/web/index.html";

// The bundle adds <style> tags at runtime (toasts, the canvas) and embeds its fonts as data: URLs. GitHub serves
// account avatars.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = {
  "content-security-policy": contentSecurityPolicy,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** For the dashboard and its API: keeps other pages, such as one on another port of this host, from framing them. */
export function withSecurityHeaders(response: Response): Response {
  // Copied as Headers, which keep every Set-Cookie, such as logout's two.
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const pages = { "/dashboard": page, "/dashboard/onboarding": page };

/**
 * Bun.serve cannot add headers to an HTML import's routes, so the dashboard is bundled and served by a server only
 * this process talks to, and every listener passes its responses on with the security headers. Its bundled files
 * (script, styles, icons) are then there on every listener from the start, the tunnel's included.
 *
 * In development each listener serves the page itself, without the headers: Bun's hot reloading needs its own socket
 * and an inline script, which would not get through.
 */
export async function openDashboard(development: boolean) {
  if (development) return { routes: pages, fetch: null, stop: async () => {} };
  const files = Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, routes: pages, fetch: () => new Response("Not found", { status: 404 }) });
  // Bun adds the bundled files' routes only once the page was served.
  await fetch(new URL("/dashboard", files.url)).then((response) => response.arrayBuffer(), () => {});
  return {
    routes: {},
    fetch: async (request: Request) => {
      const { pathname, search } = new URL(request.url);
      const etag = request.headers.get("if-none-match");
      const response = await fetch(new URL(`${pathname}${search}`, files.url), {
        method: request.method,
        headers: etag ? { "if-none-match": etag } : {},
        redirect: "manual",
      });
      return withSecurityHeaders(response);
    },
    stop: () => files.stop(true),
  };
}
