import { tick } from "@/server/trading";
import { workerWaitMs } from "@/lib/market/calendar";
import { formatEt } from "@/lib/market/time";

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop() {
  console.log("Uriel worker is up. Decisions are deterministic. The model is not on the order path.");
  while (true) {
    const started = Date.now();
    try {
      const result = await tick(new Date());
      if (result.ok) {
        console.log(
          `${result.beat.label} · SPY ${result.beat.spy?.toFixed(2) ?? "—"} · NQ ${result.beat.nq?.toFixed(2) ?? "—"} · ${result.beat.phase}`,
        );
      } else {
        console.log(result.reason);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    const now = new Date();
    const wait = workerWaitMs(now, Date.now() - started);
    if (wait > 60_000) console.log(`Next heartbeat ${formatEt(new Date(now.getTime() + wait))} ET`);
    await sleep(wait);
  }
}

void loop();
