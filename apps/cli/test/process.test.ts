import { expect, test } from "bun:test";
import { stopProcess } from "../src/process.ts";

/** A Bun process that reports when it is ready, and on SIGUSR2 either exits or carries on as a stuck VM Bridge would. */
async function spawn(onSignal: "exit" | "ignore") {
  const script = `process.on("SIGUSR2", () => { ${onSignal === "exit" ? "process.exit(0)" : ""} }); console.log("ready"); setInterval(() => {}, 1000);`;
  const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  return child;
}

test("a process that stops on the signal is left to exit by itself", async () => {
  const child = await spawn("exit");
  expect(await stopProcess(child.pid, "SIGUSR2", 5_000)).toBe(true);
  expect(await child.exited).toBe(0);
});

test("a process still running after the wait is killed", async () => {
  const child = await spawn("ignore");
  const started = Date.now();
  expect(await stopProcess(child.pid, "SIGUSR2", 500)).toBe(false);
  expect(child.signalCode).toBe("SIGKILL");
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("a process that is already gone counts as stopped", async () => {
  const child = await spawn("exit");
  child.kill("SIGKILL");
  await child.exited;
  expect(await stopProcess(child.pid, "SIGUSR2", 500)).toBe(true);
});
