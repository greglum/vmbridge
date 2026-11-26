import { describe, expect, test } from "bun:test";
import { ViewOnlyFilter } from "../src/watch/rfb.ts";

const enc = new TextEncoder();
const handshake38 = new Uint8Array([...enc.encode("RFB 003.008\n"), 1, 1]);
const frameRequest = new Uint8Array([3, 1, 0, 0, 0, 0, 4, 0, 3, 0]);
const setPixelFormat = new Uint8Array([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);

describe("ViewOnlyFilter", () => {
  test("rejects RFB 3.3 downgrade framing desync that smuggles a KeyEvent inside allowed messages", () => {
    // Under RFC 6143 §7.1.1, RFB 3.3 omits the client's 1-byte security-type selection, so byte 12 is
    // ClientInit (shared=1, which happens to equal securityNone=1) and byte 13 is the first client message
    // type (0x04 = KeyEvent). Without validating the 12-byte RFB 3.8 version, the filter shifts by 1 byte
    // and forwards the smuggled KeyEvent inside a SetPixelFormat payload.
    const smuggled = new Uint8Array([
      ...enc.encode("RFB 003.003\n"),
      1, // Server: ClientInit(shared=1); buggy filter: securityNone(1)
      4, // Server: KeyEvent opcode; buggy filter: ClientInit
      ...setPixelFormat, // Buggy filter: SetPixelFormat (20 bytes); Server: KeyEvent payload + more input
    ]);
    expect(new ViewOnlyFilter().push(smuggled)).toBeNull();
  });

  test("rejects RFB 3.3 and other non-3.8 versions even when split across chunks", () => {
    for (const version of ["RFB 003.003\n", "RFB 003.007\n", "RFB 004.000\n", "NOT 003.008\n"]) {
      const filter = new ViewOnlyFilter();
      const raw = new Uint8Array([...enc.encode(version), 1, 1]);
      let rejected = false;
      for (let i = 0; i < raw.length; i += 3) {
        if (filter.push(raw.subarray(i, i + 3)) === null) {
          rejected = true;
          break;
        }
      }
      expect(rejected).toBe(true);
    }
  });

  test("streams valid RFB 3.8 handshake incrementally byte-by-byte without stalling turn-taking", () => {
    const filter = new ViewOnlyFilter();
    const out: number[] = [];
    for (let i = 0; i < handshake38.length; i++) {
      const part = filter.push(handshake38.subarray(i, i + 1));
      expect(part).not.toBeNull();
      expect(part!.length).toBe(1);
      out.push(...part!);
    }
    expect(out).toEqual([...handshake38]);
    expect([...filter.push(frameRequest)!]).toEqual([...frameRequest]);
  });

  test("rejects ClientFence messages whose payload exceeds the 64-byte protocol maximum", () => {
    const okFilter = new ViewOnlyFilter();
    expect(okFilter.push(handshake38)).not.toBeNull();
    const validFence = new Uint8Array([248, 0, 0, 0, 0, 0, 0, 1, 64, ...new Uint8Array(64).fill(0x41)]);
    expect([...okFilter.push(validFence)!]).toEqual([...validFence]);

    const badFilter = new ViewOnlyFilter();
    expect(badFilter.push(handshake38)).not.toBeNull();
    const oversizedFence = new Uint8Array([248, 0, 0, 0, 0, 0, 0, 1, 65, ...new Uint8Array(65).fill(0x41)]);
    expect(badFilter.push(oversizedFence)).toBeNull();
  });

  test("latches rejection so subsequent chunks can never pass after a rejected frame", () => {
    const filter = new ViewOnlyFilter();
    const badSecurity = new Uint8Array([...enc.encode("RFB 003.008\n"), 2, 1]);
    expect(filter.push(badSecurity)).toBeNull();
    expect(filter.push(handshake38)).toBeNull();
    expect(filter.push(frameRequest)).toBeNull();
  });
});
