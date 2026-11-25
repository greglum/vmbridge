import { expect, test } from "bun:test";
import { serviceAddresses } from "../src/service.ts";

test("the addresses come from the service's last start, without the notes after them", () => {
  const start = (tunnel: string) => `VM Bridge 1.1.7 is running.

  This machine         http://127.0.0.1:3774/dashboard
${tunnel}
  Devices on your local network can't connect. Turn it on in Settings > Addresses, or start with --host 0.0.0.0.

Open the dashboard to set up providers and pair devices. Press Ctrl+C to stop.
[cloudflared] 2026-11-25T19:16:26Z INF Registered tunnel connection
`;
  const log = start("") + start("  Cloudflare Tunnel    https://bridge.example.com/dashboard\n");
  expect(serviceAddresses(log)).toEqual(["  This machine         http://127.0.0.1:3774/dashboard", "  Cloudflare Tunnel    https://bridge.example.com/dashboard"]);
  expect(serviceAddresses("")).toEqual([]);
});
