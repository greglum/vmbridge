import type { ClientInfo, TrafficEvent } from "@vmbridge/contracts";

/** A failed request this recent, with none from the device working since, shows on the device. */
export const failingMs = 10 * 60_000;
/**
 * Why the device's requests are failing, from its latest HTTP request or refused credential in the log. Only what
 * VM Bridge can tie to the device counts: its bearer token, a WebSocket ticket, or an upload link it was given.
 */
export function failingReason(clientId: string, traffic: TrafficEvent[], now: number): string | null {
  for (let i = traffic.length - 1; i >= 0; i--) {
    const event = traffic[i]!;
    if (event.clientId !== clientId || event.kind !== "http") continue;
    if (event.status !== "error" || now - event.at > failingMs) return null;
    return event.reason ?? event.operation;
  }
  return null;
}

/** Paired devices whose requests are failing now, with why. */
export function failingDevices(clients: ClientInfo[], traffic: TrafficEvent[], now: number) {
  return clients.flatMap((client) => {
    const reason = failingReason(client.id, traffic, now);
    return reason ? [{ id: client.id, name: client.name, reason }] : [];
  });
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** A wall-clock time, with the day when it is not today, such as "15:50" or "24 Nov, 15:50". */
export function sinceText(at: number, now: number) {
  const today = new Date(now).toDateString() === new Date(at).toDateString();
  return today ? timeFormat.format(at) : `${dayFormat.format(at)}, ${timeFormat.format(at)}`;
}
