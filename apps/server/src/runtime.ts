// What the server core needs from the runtime it runs on, beyond web standards. Bun's side is in bun/.

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Opens an outbound WebSocket that sends `headers` with its upgrade request, asking for `protocols` if any, and
 * resolves once it is open. Rejections never include the URL, which can hold preview credentials, or the protocols,
 * which can hold a ticket. Bun passes headers to `new WebSocket` (bun/socket.ts); Workers cannot, and upgrade a
 * `fetch` instead.
 */
export type OpenSocket = (url: URL, headers: Record<string, string>, timeoutMs: number, protocols?: string[]) => Promise<WebSocket>;
