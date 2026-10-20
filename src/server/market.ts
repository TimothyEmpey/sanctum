import type { Bar } from "@/lib/strategy/orb";

type YahooChart = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<Record<string, Array<number | null>>> };
    }>;
    error?: { description?: string };
  };
};

export async function fetchYahooBars(symbol: string, interval: "1m" | "1h" | "1d", range: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const response = await fetch(url, {
    headers: { "user-agent": "uriel-paper/0.1" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Market data for ${symbol} returned ${response.status}`);
  const body = (await response.json()) as YahooChart;
  const result = body.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const bars: Bar[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const stamp = timestamps[index];
    // The chart adds one live print after the finished candles. It is stamped
    // mid-minute, with the last price in every field and no volume. Keeping it
    // makes the algorithm blind to the real bars.
    if (interval === "1m" && stamp % 60 !== 0) continue;
    const close = quote.close?.[index];
    if (close == null) continue;
    bars.push({
      ts: stamp * 1000,
      open: quote.open?.[index] ?? close,
      high: quote.high?.[index] ?? close,
      low: quote.low?.[index] ?? close,
      close,
      volume: Math.max(0, Math.round(quote.volume?.[index] ?? 0)),
    });
  }
  return bars;
}
