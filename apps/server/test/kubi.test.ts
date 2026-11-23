import { describe, expect, test } from "bun:test";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import { agentKeyProblem, kubi } from "../src/providers/kubi.ts";

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
}

type Answer = { status?: number; json?: unknown; bytes?: Uint8Array };

/** A fake Kubi API: `route` answers each call, and every call is recorded. */
function fakeKubi(route: (call: Call) => Answer) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const body = init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body ?? "");
    const call = { method: init.method ?? "GET", path: url.pathname.replace(/^\/v1/, ""), query: url.searchParams, headers: new Headers(init.headers), body };
    calls.push(call);
    const answer = route(call);
    const payload = answer.bytes ?? JSON.stringify(answer.json ?? {});
    return new Response(payload, { status: answer.status ?? 200, headers: { "content-type": answer.bytes ? "application/octet-stream" : "application/json" } });
  };
  return { calls, provider: kubi({ apiKey: "kubi_secret", kind: "disposable", fetch }) };
}

const screen = (state: string, labels: Record<string, string> = {}, operation: string | null = null) => ({
  id: "scr_1",
  state,
  labels,
  operation_id: operation,
  created_at: "2026-11-23T10:00:00Z",
});
const done = (id: string) => ({ id, status: "succeeded", screen_id: "scr_1", error: null });
const exited = (stdout = "", exitCode = 0) => ({ id: "ex_1", status: "exited", exit_code: exitCode, stdout, stderr: "" });
const kubiError = (status: number, code: string, details: Record<string, unknown> = {}) => ({
  status,
  json: { error: { code, message: "Kubi's own words.", request_id: "req_1", retryable: false, outcome: "not_applied", details } },
});

describe("Kubi screens", () => {
  test("a new screen carries VM Bridge's labels and the SDK key, waits for its create, and gets /workspace", async () => {
    const { calls, provider } = fakeKubi((call) => {
      if (call.method === "POST" && call.path === "/screens") return { status: 202, json: { id: "op_1", status: "queued", screen_id: "scr_1", error: null } };
      if (call.path === "/operations/op_1") return { json: done("op_1") };
      if (call.path === "/screens/scr_1/exec") return { json: exited() };
      return { json: screen("running", { vmbridge: "b1", "sandbox-sdk": "1", "sandbox-sdk-key": "vm-1" }) };
    });
    const info = await provider.create({ key: "vm-1", labels: { vmbridge: "b1", "sandbox-sdk": "1" } });

    expect(calls[0]!.headers.get("authorization")).toBe("Bearer kubi_secret");
    expect(JSON.parse(calls[0]!.body)).toEqual({ kind: "disposable", labels: { vmbridge: "b1", "sandbox-sdk": "1", "sandbox-sdk-key": "vm-1" } });
    expect(calls[1]!.query.get("wait_s")).toBe("25");
    expect(JSON.parse(calls[2]!.body).command).toContain("sudo -n install -d");
    expect(info).toEqual({ id: "scr_1", key: "vm-1", labels: { vmbridge: "b1", "sandbox-sdk": "1" }, state: "running", createdAt: Date.parse("2026-11-23T10:00:00Z") });
  });

  test("a create that fails after Kubi made the screen deletes it", async () => {
    const { calls, provider } = fakeKubi((call) => {
      if (call.method === "POST" && call.path === "/screens") return { status: 202, json: { id: "op_1", status: "queued", screen_id: "scr_1", error: null } };
      if (call.path === "/operations/op_1") return { json: { ...done("op_1"), status: "failed", error: { message: "no machine" } } };
      return { status: 202, json: { id: "op_2", status: "queued", screen_id: "scr_1", error: null } };
    });
    await expect(provider.create({ labels: {} })).rejects.toThrow("no machine");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/screens/scr_1" });
  });

  test("listing filters on one label at Kubi and the rest here, and leaves out deleted screens and ones without a key", async () => {
    const { calls, provider } = fakeKubi(() => ({
      json: {
        data: [
          { ...screen("stopped", { vmbridge: "b1", "sandbox-sdk": "1", "sandbox-sdk-key": "vm-1" }), id: "scr_1" },
          { ...screen("running", { vmbridge: "b1", "sandbox-sdk": "1", "sandbox-sdk-key": "vm-2" }), id: "scr_2" },
          { ...screen("deleting", { vmbridge: "b1", "sandbox-sdk": "1", "sandbox-sdk-key": "vm-3" }), id: "scr_3" },
          { ...screen("running", { vmbridge: "b1", "sandbox-sdk": "1" }), id: "scr_4" },
          { ...screen("running", { vmbridge: "b1", "sandbox-sdk": "2", "sandbox-sdk-key": "vm-5" }), id: "scr_5" },
        ],
        next: null,
      },
    }));
    const listed = await provider.list({ vmbridge: "b1", "sandbox-sdk": "1" });
    expect(calls[0]!.query.get("label")).toBe("vmbridge:b1");
    expect(listed.map(({ id, key, state }) => ({ id, key, state }))).toEqual([
      { id: "scr_1", key: "vm-1", state: "paused" },
      { id: "scr_2", key: "vm-2", state: "running" },
    ]);
  });

  test("sleep stops the screen and waits for it; wake waits out a stop still running, then starts it", async () => {
    let state = "running";
    const { calls, provider } = fakeKubi((call) => {
      if (call.path === "/screens/scr_1/stop") return { status: 202, json: { id: "op_stop", status: "queued", screen_id: "scr_1", error: null } };
      if (call.path === "/screens/scr_1/start") return { status: 202, json: { id: "op_start", status: "queued", screen_id: "scr_1", error: null } };
      if (call.path.startsWith("/operations/")) {
        state = call.path.endsWith("op_start") ? "running" : "stopped";
        return { json: done(call.path.split("/").pop()!) };
      }
      return { json: screen(state, {}, state === "stopping" ? "op_stop" : null) };
    });
    await provider.pause!("scr_1");
    expect(state).toBe("stopped");

    state = "stopping";
    await provider.resume!("scr_1");
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/screens/scr_1/stop", "/screens/scr_1/start"]);
    expect(state).toBe("running");
  });

  test("T3's port is a token port, and the token goes with every request as a header", async () => {
    const { calls, provider } = fakeKubi(() => ({ json: { port: 3773, access: "token", url: "https://3773-abc.trykubi.dev", token: "kpt_token" } }));
    expect(await provider.previewUrl("scr_1", 3773)).toEqual({ url: "https://3773-abc.trykubi.dev", headers: { "Kubi-Port-Token": "kpt_token" } });
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/screens/scr_1/ports/3773" });
    expect(JSON.parse(calls[0]!.body)).toEqual({ access: "token" });
  });
});

describe("Kubi commands", () => {
  test("stdin goes up as a private file, and a long command is followed from where its output left off", async () => {
    const { calls, provider } = fakeKubi((call) => {
      if (call.method === "PUT") return { json: { path: call.query.get("path"), size_bytes: 5, sha256: "x" } };
      if (call.method === "POST") return { status: 202, json: { id: "ex_1", status: "running", exit_code: null, stdout: "héllo\n", stderr: "" } };
      return { json: { id: "ex_1", status: "exited", exit_code: 3, stdout: "done\n", stderr: "oops" } };
    });
    const chunks: string[] = [];
    const result = await provider.exec("scr_1", {
      command: "cat",
      cwd: "/workspace",
      env: {},
      stdin: "input",
      timeoutMs: 60_000,
      onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`),
    });

    expect(result).toEqual({ exitCode: 3, timedOut: false });
    expect(chunks).toEqual(["stdout:héllo\n", "stdout:done\n", "stderr:oops"]);
    const [upload, start, follow] = calls;
    expect(upload).toMatchObject({ method: "PUT", path: "/screens/scr_1/files", body: "input" });
    expect(upload!.query.get("mode")).toBe("0600");
    expect(upload!.query.get("path")).toStartWith("/tmp/.sandbox-sdk/input/");
    // The command reads the uploaded file, and Kubi's own limit sits behind the guest's.
    expect(JSON.parse(start!.body)).toMatchObject({ timeout_s: 75, wait_s: 25 });
    expect(JSON.parse(start!.body).command).toContain(upload!.query.get("path")!);
    // Offsets are bytes: "héllo\n" is 7.
    expect(follow!.query.get("stdout_from")).toBe("7");
    expect(follow!.query.get("stderr_from")).toBe("0");
  });

  test("a command line over Kubi's 10000 characters runs from a private script that removes itself", async () => {
    const { calls, provider } = fakeKubi((call) => (call.method === "PUT" ? { json: {} } : { json: exited("ok") }));
    const command = `echo ${"x".repeat(12_000)}`;
    await provider.exec("scr_1", { command, cwd: "/workspace", env: {}, timeoutMs: 10_000, onChunk: () => {} });

    const [upload, start] = calls;
    const path = upload!.query.get("path")!;
    expect(upload!.query.get("mode")).toBe("0600");
    expect(upload!.body).toStartWith(`rm -f -- '${path}'\n`);
    expect(upload!.body).toContain(command);
    expect(JSON.parse(start!.body).command).toBe(`exec sh '${path}'`);
  });

  test("a live view ticket is a view-only one, taken from the link's fragment", async () => {
    const { calls, provider } = fakeKubi(() => ({ json: { url: "https://trykubi.com/view/scr_1#t=vt_abc-123" } }));
    expect(await provider.viewerTicket("scr_1")).toBe("vt_abc-123");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/screens/scr_1/viewer");
    expect(JSON.parse(calls[0]!.body)).toEqual({ mode: "view" });
  });

  test("a screen that is not running has no ticket, and is not started for one", async () => {
    const { calls, provider } = fakeKubi(() => kubiError(409, "SCREEN_NOT_RUNNING"));
    expect(await provider.viewerTicket("scr_1")).toBeNull();
    expect(calls.map((call) => call.path)).toEqual(["/screens/scr_1/viewer"]);
  });

  test("a link without a ticket fails without quoting it", async () => {
    const { provider } = fakeKubi(() => ({ json: { url: "https://trykubi.com/view/scr_1#t=<script>" } }));
    const error = await provider.viewerTicket("scr_1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as Error).message).not.toContain("script");
  });

  test("a missing file is file_not_found", async () => {
    const { provider } = fakeKubi(() => kubiError(404, "FILE_NOT_FOUND"));
    const error = await provider.files.read("scr_1", "/nope").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).code).toBe("file_not_found");
  });
});

describe("Kubi errors and key checks", () => {
  const failure = async (answer: Answer) => {
    const { provider } = fakeKubi(() => answer);
    return (await provider.create({ labels: {} }).catch((caught: unknown) => caught)) as SandboxError;
  };

  test("a full account says to delete a screen or ask Kubi, and stays a quota error", async () => {
    const error = await failure(kubiError(402, "QUOTA_EXCEEDED", { screens: 1, screen_cap: 1 }));
    expect(error.code).toBe("quota");
    expect(error.message).toBe("Your Kubi account's machine limit (1) is reached. Delete a screen, or ask Kubi to raise the limit.");
  });

  test("a refused permission names the one missing", async () => {
    const error = await failure(kubiError(403, "PERMISSION_DENIED", { needed: "power", has: ["read", "exec"] }));
    expect(error.code).toBe("auth");
    expect(error.message).toStartWith("The Kubi API key is missing the power permission.");
  });

  test("other answers keep the SDK's wording and never carry the key", async () => {
    const error = await failure(kubiError(400, "INVALID_ARGUMENT"));
    expect(error.code).toBe("invalid_argument");
    expect(error.message).not.toContain("kubi_secret");
  });

  test("checking a key names every permission it lacks", async () => {
    const me = (permissions: string[]) => ({ json: { credential: { type: "api_key", permissions }, screens: { count: 0, cap: 1 } } });
    await expect(fakeKubi(() => me(["read", "exec", "power", "network"])).provider.verify()).resolves.toBeUndefined();
    await expect(fakeKubi(() => me(["read", "control", "exec", "power"])).provider.verify()).rejects.toThrow(
      "The Kubi API key is missing the network permission. Create a key in the Kubi dashboard with read, exec, power and network ticked.",
    );
    await expect(fakeKubi(() => me(["read"])).provider.verify()).rejects.toThrow("missing the exec and power and network permissions");
  });
});

describe("the key for agents", () => {
  const me = (permissions: string[], status = 200) => {
    const seen: string[] = [];
    const fetch = async (input: string, init: RequestInit) => {
      seen.push(`${input} ${new Headers(init.headers).get("authorization")}`);
      return Response.json(status === 200 ? { credential: { permissions }, screens: { count: 1, cap: 1 } } : { error: { code: "UNAUTHENTICATED" } }, { status });
    };
    return { seen, fetch };
  };

  test("is taken with read and control only, as Kubi reports them for that key", async () => {
    const { seen, fetch } = me(["read", "control"]);
    expect(await agentKeyProblem("kubi_agents", fetch)).toBeNull();
    expect(seen).toEqual(["https://api.trykubi.com/v1/me Bearer kubi_agents"]);
  });

  test("is refused when it can run commands, power screens or open ports, naming what to untick", async () => {
    expect(await agentKeyProblem("kubi_agents", me(["read", "control", "exec"]).fetch)).toBe(
      "The key for agents has exec ticked. Untick it: create a key with only read and control ticked.",
    );
    expect(await agentKeyProblem("kubi_agents", me(["read", "control", "exec", "power", "network"]).fetch)).toBe(
      "The key for agents has exec, power and network ticked. Untick them: create a key with only read and control ticked.",
    );
  });

  test("is refused without control, or when Kubi refuses it", async () => {
    expect(await agentKeyProblem("kubi_agents", me(["read"]).fetch)).toBe("The key for agents is missing control. Create a key with only read and control ticked.");
    expect(await agentKeyProblem("kubi_agents", me([], 401).fetch)).toBe("Kubi refused the key for agents. Check it, or create a new one in the Kubi dashboard.");
  });
});
