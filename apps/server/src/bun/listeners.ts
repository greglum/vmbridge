import type { Server } from "bun";

interface DrainingServer {
  timer: ReturnType<typeof setTimeout> | null;
  closing?: Promise<void>;
}

/**
 * VM Bridge's listeners on its main port, one per address it serves, since Bun.serve binds one address. Addresses come
 * and go (Tailscale comes up after VM Bridge, the local network switch flips, Wi-Fi changes), so `apply` opens and
 * closes listeners to match `wanted`.
 */
export class Listeners<T> {
  private readonly servers = new Map<string, Server<T>>();
  private readonly draining = new Map<Server<T>, DrainingServer>();
  private readonly opening = new Set<Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly open: (hostname: string, port: number) => Promise<Server<T>>,
    private readonly wanted: () => Promise<string[]>,
    public port: number,
  ) {}

  /** Opens the first wanted address, loopback or the --host address. Unlike the others it must work, so this throws. */
  async start() {
    if (this.stopped) return;
    const run = this.queue.catch(() => {}).then(() => this.startFirst());
    this.queue = run;
    await run;
    if (this.stopped) return;
    await this.apply();
  }

  hosts() {
    return [...this.servers.keys()];
  }

  /** One at a time, so a switch flipped during a scheduled run cannot open the same address twice. */
  apply(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const run = this.queue.catch(() => {}).then(() => this.sync());
    this.queue = run;
    return run;
  }

  private async startFirst() {
    if (this.stopped) return;
    const [first] = await this.wanted();
    if (this.stopped) return;
    if (!first) throw new Error("No address to listen on.");
    await this.trackOpen(async () => {
      const server = await this.open(first, this.port);
      if (this.stopped) {
        await Promise.resolve(server.stop(true)).catch(() => {});
        return;
      }
      this.port = server.port ?? this.port;
      this.servers.set(first, server);
    });
  }

  private async sync() {
    if (this.stopped) return;
    const wanted = new Set(await this.wanted());
    if (this.stopped) return;
    for (const [host, server] of this.servers) {
      if (wanted.has(host)) continue;
      this.servers.delete(host);
      this.drain(server);
    }
    for (const host of wanted) {
      if (this.stopped) return;
      if (this.servers.has(host)) continue;
      await this.trackOpen(async () => {
        let server: Server<T>;
        try {
          server = await this.open(host, this.port);
        } catch {
          // The address went away or another app holds the port there. The next run tries again.
          return;
        }
        if (this.stopped) {
          await Promise.resolve(server.stop(true)).catch(() => {});
          return;
        }
        this.servers.set(host, server);
      });
    }
  }

  private async trackOpen(run: () => Promise<void>) {
    const pending = run();
    const settled = pending.catch(() => {});
    this.opening.add(settled);
    try {
      await pending;
    } finally {
      this.opening.delete(settled);
    }
  }

  private drain(server: Server<T>) {
    const entry: DrainingServer = {
      timer: setTimeout(() => {
        if (this.draining.get(server) !== entry) return;
        entry.timer = null;
        entry.closing = Promise.resolve(server.stop(true))
          .catch(() => {})
          .finally(() => {
            if (this.draining.get(server) === entry) this.draining.delete(server);
          });
      }, 1_000),
    };
    entry.timer?.unref?.();
    this.draining.set(server, entry);
    // Stops taking connections now. A second later it also ends the ones still open, since turning the local network
    // off should cut off devices on it; the wait lets the request that turned it off get its answer.
    void Promise.resolve(server.stop()).then(
      () => {
        if (this.draining.get(server) !== entry || entry.timer === null) return;
        clearTimeout(entry.timer);
        entry.timer = null;
        this.draining.delete(server);
      },
      () => {},
    );
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = this.shutdown();
    return this.stopping;
  }

  private async shutdown() {
    const stops: Promise<unknown>[] = [...this.opening];
    for (const server of this.servers.values()) {
      stops.push(Promise.resolve(server.stop(true)).catch(() => {}));
    }
    this.servers.clear();
    for (const [server, entry] of this.draining) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      stops.push(entry.closing ?? Promise.resolve(server.stop(true)).catch(() => {}));
    }
    this.draining.clear();
    await Promise.all(stops);
  }
}
