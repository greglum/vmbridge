// The watch page: a VM's screen, live and view-only. The token in the address is the only credential, and VM Bridge
// passes the screen's stream through `<this address>/stream`, so the page needs nothing else.
import "@fontsource-variable/mona-sans";
import RFB from "@novnc/novnc";
import "./watch.css";

/** How VM Bridge closes the stream of a VM that is asleep. */
const asleepCode = 4000;
/** How VM Bridge closes a stream that sent more than a viewer does. Trying again would do the same. */
const refusedCode = 1008;
const asleepRetryMs = 10_000;
const maxRetryMs = 30_000;

const screen = document.getElementById("screen")!;
const status = document.getElementById("status")!;
const path = location.pathname.replace(/\/+$/, "");
const streamUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}/stream`;

let failures = 0;

function show(text: string | null) {
  status.textContent = text ?? "";
  status.hidden = text === null;
}

/** Whether the link still opens the page. A stream that never opened may mean it was replaced or turned off. */
async function linkWorks() {
  try {
    const response = await fetch(path, { method: "HEAD", cache: "no-store" });
    return response.status !== 404;
  } catch {
    return true;
  }
}

function connect() {
  const socket = new WebSocket(streamUrl);
  socket.binaryType = "arraybuffer";
  let opened = false;
  socket.addEventListener("open", () => (opened = true));

  const rfb = new RFB(screen, socket);
  rfb.viewOnly = true;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.background = "#000000";
  rfb.addEventListener("connect", () => {
    failures = 0;
    show(null);
  });

  socket.addEventListener("close", async (event) => {
    if (event.code === asleepCode) {
      show("The VM is asleep. This page shows it again when it wakes.");
      setTimeout(connect, asleepRetryMs);
      return;
    }
    if (event.code === refusedCode) {
      show("This page cannot show the screen. Reload to try again.");
      return;
    }
    if (!opened && !(await linkWorks())) {
      show("This link no longer works.");
      return;
    }
    failures += 1;
    show("Reconnecting");
    setTimeout(connect, Math.min(maxRetryMs, 1000 * 2 ** (failures - 1)));
  });
}

connect();
