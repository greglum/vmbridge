import { boxd } from "@opencoredev/sandbox-sdk/boxd";
import { instabox } from "@opencoredev/sandbox-sdk/instabox";
import { railway } from "@opencoredev/sandbox-sdk/railway";
import type { ProviderId } from "@vmbridge/contracts";
import { Sandbox } from "railway";
import { boatProvider } from "./boat.ts";
import { daytonaProvider } from "./daytona.ts";
import { sdkDriver } from "./sdk.ts";
import { required, type ProviderDefinition } from "./types.ts";

export type { Box, Driver, ProviderDefinition, ProviderState } from "./types.ts";

const minutes = (count: number) => count * 60_000;

const boxdProvider: ProviderDefinition = {
  id: "boxd",
  label: "boxd",
  website: "https://boxd.sh",
  fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true }],
  features: {
    sleep: "pause",
    keepsDisk: true,
    keepsMemory: true,
  },
  sizes: { small: "1 vCPU, 4 GB", medium: "2 vCPU, 8 GB", large: "4 vCPU, 16 GB" },
  open(config) {
    const provider = boxd({ apiKey: required(config, "apiKey", "boxd API key") });
    return sdkDriver({
      id: "boxd",
      provider,
      sleep: "pause",
      // boxd suspends on its own after this long without traffic, in case VM Bridge is down.
      create: { idleTimeoutMs: minutes(60) },
      // Listing would otherwise skip sleeping machines, and reading their labels wakes them.
      listSleeping: async () => (await provider.listSleeping()).map(({ id, state }) => ({ id, state })),
    });
  },
};

const instaboxProvider: ProviderDefinition = {
  id: "instabox",
  label: "Instabox",
  website: "https://instabox.sh",
  fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true }],
  features: {
    sleep: "pause",
    keepsDisk: true,
    keepsMemory: true,
  },
  sizes: { small: "2 vCPU, 4 GB", medium: "4 vCPU, 8 GB", large: "8 vCPU, 16 GB" },
  open(config) {
    return sdkDriver({
      id: "instabox",
      provider: instabox({ apiKey: required(config, "apiKey", "Instabox API key") }),
      sleep: "pause",
      // Instabox allows 5 to 30 minutes. Use the longest as a safety net behind VM Bridge's own sleep.
      create: { idleTimeoutMs: minutes(30) },
    });
  },
};

const railwayResources = {
  small: { cpu: 1, memoryGB: 2 },
  medium: { cpu: 2, memoryGB: 4 },
  large: { cpu: 4, memoryGB: 8 },
} as const;

const railwayProvider: ProviderDefinition = {
  id: "railway",
  label: "Railway",
  website: "https://railway.com",
  fields: [
    { key: "token", label: "API token", kind: "secret", required: true },
    {
      key: "environmentId",
      label: "Environment ID",
      kind: "text",
      required: true,
      help: "The Railway environment that holds the sandboxes.",
    },
  ],
  features: {
    sleep: "checkpoint",
    keepsDisk: true,
    keepsMemory: false,
  },
  sizes: { small: "1 vCPU, 2 GB", medium: "2 vCPU, 4 GB", large: "4 vCPU, 8 GB" },
  open(config) {
    // Railway has no pause, and its idle timeout destroys the VM, so VM Bridge never sets one.
    // Sleep is a checkpoint followed by destroy, and waking restores the checkpoint.
    const auth = {
      token: required(config, "token", "Railway API token"),
      environmentId: required(config, "environmentId", "Railway environment ID"),
    };
    return sdkDriver({
      id: "railway",
      provider: railway(auth),
      // Railway sets CPU and memory per client, not per create.
      sized: (size) => railway({ ...auth, resources: railwayResources[size] }),
      sleep: "checkpoint",
      // Railway keeps checkpoints until deleted, and deletes them by ID, not by the key the SDK returns.
      async deleteCheckpoint(key) {
        const checkpoint = (await Sandbox.checkpoints(auth)).find((entry) => entry.key === key);
        if (checkpoint) await Sandbox.deleteCheckpoint(checkpoint.id, auth);
      },
    });
  },
};

export const providers: Record<ProviderId, ProviderDefinition> = {
  boat: boatProvider,
  boxd: boxdProvider,
  daytona: daytonaProvider,
  instabox: instaboxProvider,
  railway: railwayProvider,
};
