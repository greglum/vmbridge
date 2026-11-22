import { deflateRawSync } from "node:zlib";
import { connectSandbox } from "@opencoredev/sandbox-sdk";
import { boat } from "@opencoredev/sandbox-sdk/boat";
import type { SelectOption } from "@vmbridge/contracts";
import { notFound, sdkDriver } from "./sdk.ts";
import { required, type Box, type ProviderDefinition, type ProviderState } from "./types.ts";

interface BoatEnvironment {
  id: string;
  name: string;
  isDefault: boolean;
}

interface BoatSandbox {
  id: string;
  name?: string | null;
  state: string;
}

const machines = { small: "small", medium: "default", large: "large" } as const;
const running = new Set(["ready", "idle", "running"]);
const settling = new Set(["stopping", "archiving", "securing", "provisioning", "starting", "resuming", "queued"]);
const failed = new Set(["error", "failed", "deleted"]);

/** Boat stops a VM this long after it starts. VM Bridge sleeps idle VMs much sooner; this caps cost if it is down. */
const ttlSeconds = 12 * 60 * 60;

/**
 * The SDK keeps Boat metadata in the VM name. Writing the same encoding lets `connectSandbox`
 * attach to VMs VM Bridge creates through Boat's API directly.
 */
function sdkName(key: string, labels: Record<string, string>) {
  const name = "sandbox-sdk:1:" + deflateRawSync(JSON.stringify([key, labels])).toString("base64url");
  if (name.length > 120) throw new Error("VM labels are too long for a Boat VM name.");
  return name;
}

export const boatProvider: ProviderDefinition = {
  id: "boat",
  label: "Boat",
  website: "https://boat.dev",
  fields: [
    { key: "apiKey", label: "API key", kind: "secret", required: true, placeholder: "boat_..." },
    {
      key: "environment",
      label: "Environment",
      kind: "select",
      required: false,
      help: "The Boat environment new VMs start in.",
    },
  ],
  features: {
    sleep: "stop",
    keepsDisk: true,
    keepsMemory: false,
  },
  sizes: { small: "2 vCPU, 4 GB", medium: "4 vCPU, 8 GB", large: "8 vCPU, 16 GB" },
  defaultSize: "small",

  open(config) {
    const apiKey = required(config, "apiKey", "Boat API key");
    const provider = boat({ apiKey, ttlSeconds });
    const { api } = provider;
    const base = sdkDriver({ id: "boat", provider, sleep: "pause" });

    const get = async (sandboxId: string) =>
      (await api.request<{ sandbox: BoatSandbox }>("GET", "/sandboxes/{sandboxId}", { params: { sandboxId } }))
        .sandbox;

    const environments = async () =>
      (await api.request<{ environments: BoatEnvironment[] }>("GET", "/environments")).environments;

    async function waitRunning(sandboxId: string) {
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        const { state } = await get(sandboxId);
        if (running.has(state)) return;
        if (failed.has(state)) throw new Error(`Boat VM ${sandboxId} is ${state}.`);
        await Bun.sleep(1000);
      }
      throw new Error(`Boat VM ${sandboxId} did not start within 5 minutes.`);
    }

    const connect = (sandboxId: string): Promise<Box> => connectSandbox(provider, sandboxId, { recoverSecrets: false });

    return {
      ...base,

      async verify() {
        await environments();
      },

      async options(field): Promise<SelectOption[]> {
        if (field !== "environment") return [];
        return (await environments()).map((environment) => ({
          value: environment.name,
          label: environment.isDefault ? `${environment.name} (default)` : environment.name,
        }));
      },

      // The SDK creates Boat VMs with `noEnv: true`, which drops the environment, so VM Bridge
      // creates them through Boat's API and attaches with the SDK.
      async create(input) {
        const environment = config.values.environment || undefined;
        const { sandbox } = await api.request<{ sandbox: BoatSandbox }>("POST", "/sandboxes", {
          headers: { "Idempotency-Key": input.key },
          body: { type: machines[input.size], ttlSeconds, ...(environment ? { environment, noEnv: false } : {}) },
          timeoutMs: 90_000,
        });
        try {
          await api.request("PATCH", "/sandboxes/{sandboxId}", {
            params: { sandboxId: sandbox.id },
            body: { name: sdkName(input.key, input.labels) },
          });
          await waitRunning(sandbox.id);
          return await connect(sandbox.id);
        } catch (error) {
          await base.destroy(sandbox.id).catch(() => undefined);
          throw error;
        }
      },

      connect,

      async states(labels) {
        const states = await base.states(labels);
        // The SDK reports Boat's transitional states as stopped. Keep them apart so a waking VM is not slept again.
        for (const [id, state] of states) {
          if (state !== "stopped") continue;
          const { state: native } = await get(id);
          if (running.has(native) || settling.has(native)) states.set(id, "running" satisfies ProviderState);
        }
        return states;
      },

      async sleep(box) {
        await api.request("POST", "/sandboxes/{sandboxId}/stop", { params: { sandboxId: box.id }, body: {} });
        return {};
      },

      async wake(vm) {
        const deadline = Date.now() + 3 * 60_000;
        let { state } = await get(vm.sandboxId);
        // A stop must finish before Boat accepts a resume.
        while (["stopping", "archiving", "securing"].includes(state) && Date.now() < deadline) {
          await Bun.sleep(1000);
          ({ state } = await get(vm.sandboxId));
        }
        if (!running.has(state) && !settling.has(state)) {
          await api.request("POST", "/sandboxes/{sandboxId}/resume", {
            params: { sandboxId: vm.sandboxId },
            body: { ttlSeconds },
          });
        }
        await waitRunning(vm.sandboxId);
        return connect(vm.sandboxId);
      },

      async keepAlive(box) {
        // Boat's auto-stop timer counts from start. Push it back while agents work.
        await api.request("PATCH", "/sandboxes/{sandboxId}", { params: { sandboxId: box.id }, body: { ttlSeconds } });
      },

      async destroy(sandboxId) {
        try {
          await api.request("DELETE", "/sandboxes/{sandboxId}", {
            params: { sandboxId },
            headers: { "X-Ascii-Confirm-Delete": sandboxId },
          });
        } catch (error) {
          if (!notFound(error)) throw error;
        }
      },
    };
  },
};
