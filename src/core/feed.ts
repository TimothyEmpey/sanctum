import { validateFrames } from "./market";
import type { Config } from "./types";

/** Continuous chart prices must never silently become dated-contract fill evidence. */
export function validateFeed(value: unknown, config: Config) {
  const feed=value as { provenance?: unknown; contracts?: Record<string,string>; frames?: unknown };
  if(!feed || typeof feed.provenance!=="string" || !feed.provenance.trim()) throw new Error("Feed requires source provenance.");
  if (/(synthetic|fabricated|example)/i.test(feed.provenance)) throw new Error("Synthetic feeds are not permitted. Use real exchange market data.");
  for(const root of ["NQ","ES"] as const) {
    if(!config.contracts[root].id || feed.contracts?.[root]!==config.contracts[root].id) throw new Error(`Feed ${root} contract does not match the dated execution contract.`);
  }
  return validateFrames(feed.frames);
}
