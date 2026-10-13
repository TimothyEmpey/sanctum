import { fonzoWaitMs } from "@/lib/market/crypto-clock";
import { tickFonzo } from "@/server/trading";

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop() {
  console.log("Fonzo worker is up. Decisions are deterministic. The model is not on the order path.");
  while (true) {
    const started = Date.now();
    try {
      const result = await tickFonzo(new Date());
      if (result.ok) {
        console.log(
          `${result.beat.label} · BTC ${result.beat.btc?.toFixed(2) ?? "—"} · ETH ${result.beat.eth?.toFixed(2) ?? "—"} · ${result.beat.phase}`,
        );
      } else {
        console.log(result.reason);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    const now = new Date();
    const wait = fonzoWaitMs(now, Date.now() - started);
    if (wait > 60_000) console.log(`Next heartbeat ${new Date(now.getTime() + wait).toISOString()} UTC`);
    await sleep(wait);
  }
}

void loop();
