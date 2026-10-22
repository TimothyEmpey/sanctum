import type { Bar, Config, Frame, Level, Root } from "./types";

export const MINUTE = 60_000;
export function validateFrames(input: unknown): Frame[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Feed must contain paired NQ/ES one-minute frames.");
  let previous = -Infinity;
  for (const f of input as Frame[]) {
    if (!Number.isFinite(f.time) || f.time <= previous || f.time % MINUTE !== 0) throw new Error("Frames must be strictly ordered minute-close timestamps.");
    for (const root of ["NQ", "ES"] as Root[]) {
      const b = f[root];
      if (!b || ![b.time, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) || b.time + MINUTE !== f.time || b.volume < 0 || b.low <= 0 || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close) || b.high < b.low) throw new Error(`Invalid or unsynchronized ${root} candle.`);
      if (![b.open, b.high, b.low, b.close].every(p => Math.abs(p * 4 - Math.round(p * 4)) < 1e-6)) throw new Error("Futures prices must align to 0.25 ticks.");
    }
    previous = f.time;
  }
  return input as Frame[];
}

/** Only complete, contiguous buckets are exposed; UTC anchoring is an explicit research assumption. */
export function aggregate(bars: Bar[], minutes: number): Bar[] {
  const groups = new Map<number, Bar[]>();
  for (const b of bars) {
    const t = Math.floor(b.time / (minutes * MINUTE)) * minutes * MINUTE;
    groups.set(t, [...(groups.get(t) ?? []), b]);
  }
  return [...groups].flatMap(([time, rows]) => {
    if (rows.length !== minutes || rows.some((b, i) => b.time !== time + i * MINUTE)) return [];
    return [{ time, open: rows[0].open, high: Math.max(...rows.map(b => b.high)), low: Math.min(...rows.map(b => b.low)), close: rows.at(-1)!.close, volume: rows.reduce((s,b) => s+b.volume,0) }];
  });
}

export function pivots(bars: Bar[], strength: number, minutes: number): Level[] {
  const found: Level[] = [];
  for (let i = strength; i + strength < bars.length; i++) {
    const b = bars[i], around = bars.slice(i-strength, i+strength+1).filter((_,j) => j !== strength);
    const knownAt = bars[i+strength].time + minutes * MINUTE;
    if (around.every(a => b.high > a.high)) found.push({ price:b.high, kind:"HIGH", source:`${minutes}m swing`, knownAt });
    if (around.every(a => b.low < a.low)) found.push({ price:b.low, kind:"LOW", source:`${minutes}m swing`, knownAt });
  }
  return found;
}

export type StructureEvent = { time: number; direction: "LONG" | "SHORT"; kind: "BOS" | "IFVG" };
export function structure(bars: Bar[], strength: number, minutes: number): StructureEvent[] {
  const ps = pivots(bars, strength, minutes), events: StructureEvent[] = [];
  const broken = new Set<string>();
  const gaps: { low: number; high: number; bullish: boolean; inverted: boolean }[] = [];
  let trend: "LONG" | "SHORT" | null = null;
  for (let i=0; i<bars.length; i++) {
    const b=bars[i], time=b.time+minutes*MINUTE;
    const known=ps.filter(p=>p.knownAt<=b.time);
    const high=known.filter(p=>p.kind==="HIGH").at(-1), low=known.filter(p=>p.kind==="LOW").at(-1);
    // Initialize direction from two confirmed highs/lows, without using future bars.
    if (!trend) {
      const hs=known.filter(p=>p.kind==="HIGH").slice(-2), ls=known.filter(p=>p.kind==="LOW").slice(-2);
      if (hs.length===2 && ls.length===2) {
        if (hs[1].price>hs[0].price && ls[1].price>ls[0].price) trend="LONG";
        if (hs[1].price<hs[0].price && ls[1].price<ls[0].price) trend="SHORT";
      }
    }
    for (const [p, direction] of [[high,"LONG"],[low,"SHORT"]] as const) {
      if (!p) continue;
      const key=`${p.kind}:${p.knownAt}`;
      if (!broken.has(key) && (direction==="LONG" ? b.close>p.price : b.close<p.price)) {
        broken.add(key);
        if (trend!==direction) events.push({ time, direction, kind:"BOS" });
        trend=direction;
      }
    }
    for (const gap of gaps) {
      if (!gap.inverted && (gap.bullish ? b.close<gap.low : b.close>gap.high)) {
        const direction=gap.bullish ? "SHORT" : "LONG";
        events.push({ time, direction, kind:"IFVG" }); trend=direction; gap.inverted=true;
      }
    }
    if(i>=2) {
      if(b.low>bars[i-2].high) gaps.push({low:bars[i-2].high,high:b.low,bullish:true,inverted:false});
      if(b.high<bars[i-2].low) gaps.push({low:b.high,high:bars[i-2].low,bullish:false,inverted:false});
    }
  }
  return events;
}

export function liquidity(bars: Bar[], c: Config, now: number): Level[] {
  const levels = [...pivots(aggregate(bars,60),c.pivotStrength,60), ...pivots(aggregate(bars,240),c.pivotStrength,240)];
  for (const session of c.sessions) {
    if(session.open>now) continue;
    // Explicit 03:00–09:30 ET premarket proxy (6.5h), not a claim about exact London/Asia definitions.
    const prem=bars.filter(b=>b.time>=session.open-390*MINUTE && b.time+MINUTE<=session.open);
    if(prem.length===390) {
      levels.push({price:Math.max(...prem.map(b=>b.high)),kind:"HIGH",source:"Premarket high",knownAt:session.open});
      levels.push({price:Math.min(...prem.map(b=>b.low)),kind:"LOW",source:"Premarket low",knownAt:session.open});
    }
    const past=bars.filter(b=>b.time>=session.open && b.time+MINUTE<=session.flatten);
    if(session.flatten<=now && past.length>0 && past[0].time===session.open && past.at(-1)!.time+MINUTE===session.flatten && past.every((b,i)=>i===0||b.time===past[i-1].time+MINUTE)) {
      levels.push({price:Math.max(...past.map(b=>b.high)),kind:"HIGH",source:`${session.date} session high`,knownAt:session.flatten});
      levels.push({price:Math.min(...past.map(b=>b.low)),kind:"LOW",source:`${session.date} session low`,knownAt:session.flatten});
    }
  }
  return levels.filter(l=>l.knownAt<=now && l.knownAt>=now-7*86400_000);
}
