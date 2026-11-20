import { describe, expect, setSystemTime, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Settings } from "../src/settings.ts";
import { DashboardAuth, TooManyAttempts } from "../src/auth/dashboard.ts";
import { Clients, pairingLinkMs } from "../src/auth/clients.ts";

const request = (cookie: string) => new Request("http://x/", { headers: { cookie } });

describe("dashboard key", () => {
  test("logs in with the key and rejects others", async () => {
    const db = openDatabase(":memory:");
    const auth = new DashboardAuth(db, new Settings(db));
    await auth.setKey("correct horse");
    expect(await auth.login("wrong key!", "1.1.1.1", false)).toBeNull();
    const cookie = await auth.login("correct horse", "1.1.1.1", false);
    expect(cookie).toContain("HttpOnly");
    expect(auth.authenticated(request(cookie!.split(";")[0]!))).toBe(true);
    expect(auth.authenticated(request("vmbridge_session=forged"))).toBe(false);
  });

  test("throttles repeated failures per address", async () => {
    const db = openDatabase(":memory:");
    const auth = new DashboardAuth(db, new Settings(db));
    await auth.setKey("correct horse");
    for (let i = 0; i < 5; i++) await auth.login("nope nope", "2.2.2.2", false);
    expect(auth.login("correct horse", "2.2.2.2", false)).rejects.toBeInstanceOf(TooManyAttempts);
    expect(await auth.login("correct horse", "3.3.3.3", false)).not.toBeNull();
  });

  test("changing the key ends existing sessions", async () => {
    const db = openDatabase(":memory:");
    const auth = new DashboardAuth(db, new Settings(db));
    await auth.setKey("first key!");
    const cookie = (await auth.login("first key!", "a", false))!.split(";")[0]!;
    await auth.setKey("second key");
    expect(auth.authenticated(request(cookie))).toBe(false);
  });
});

describe("T3 pairing", () => {
  test("a pairing link works once and names the device", () => {
    const clients = new Clients(openDatabase(":memory:"));
    const { token } = clients.createLink("Vaibhav's iPhone");
    const access = clients.exchange(token);
    expect(access).toBeString();
    expect(clients.exchange(token)).toBeNull();
    expect(clients.authenticate(access!)?.name).toBe("Vaibhav's iPhone");
  });

  test("expired links cannot be redeemed", () => {
    const clients = new Clients(openDatabase(":memory:"));
    const { token } = clients.createLink("Laptop");
    setSystemTime(new Date(Date.now() + pairingLinkMs + 1));
    try {
      expect(clients.exchange(token)).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test("WebSocket tickets are single use and die with the session", () => {
    const clients = new Clients(openDatabase(":memory:"));
    const access = clients.exchange(clients.createLink("Desk").token)!;
    const client = clients.authenticate(access)!;
    const { ticket } = clients.ticket(client.id);
    expect(clients.redeemTicket(ticket)).toBe(client.id);
    expect(clients.redeemTicket(ticket)).toBeNull();
    const second = clients.ticket(client.id).ticket;
    clients.revoke(client.id);
    expect(clients.redeemTicket(second)).toBeNull();
    expect(clients.authenticate(access)).toBeNull();
  });
});
