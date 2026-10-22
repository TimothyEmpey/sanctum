import { aggregate, liquidity, MINUTE, pivots, structure } from "./market";
import type { Bar, Config, Direction, Evaluation, Root } from "./types";

/** Deterministic research interpretation of the video. No claimed replication of discretionary judgment. */
export function evaluate(root: Root, history: Record<Root,Bar[]>, c: Config, now: number): Evaluation {
  const bars=history[root].filter(b=>b.time+MINUTE<=now), peer=history[root==="NQ"?"ES":"NQ"].filter(b=>b.time+MINUTE<=now), levels=liquidity(bars,c,now);
  const five=structure(aggregate(bars,5),c.pivotStrength,5), peerFive=structure(aggregate(peer,5),c.pivotStrength,5);
  const one=structure(bars,c.pivotStrength,1);
  const checks=["Liquidity swept", "Five-minute reversal", "NQ and ES aligned", "One-minute pullback", "One-minute continuation", "Liquidity target available"].map(label=>({label,passed:false}));
  const result:Evaluation={root,phase:"Waiting for liquidity sweep",checks,levels};
  if(bars.length<30) {result.phase="Warming up market history"; return result;}
  const session=c.sessions.find(s=>now>=s.open && now<s.flatten);
  // Permit a premarket setup, but never an entry before the configured cash open.
  if(!session || now>=session.entryEnd) {result.phase="Outside entry window";return result;}
  const sweeps:{time:number;direction:Direction;price:number}[]=[];
  for(const sourceBars of [bars,peer]) {
  const sourceLevels=liquidity(sourceBars,c,now);
  for(let i=1;i<sourceBars.length;i++) {
    const b=sourceBars[i];
    if(b.time<Math.max(session.open-60*MINUTE,now-c.maxSetupMinutes*MINUTE)) continue;
    for(const l of sourceLevels) {
      if(l.knownAt>b.time) continue;
      const touchedBefore=sourceBars.slice(0,i).some(x=>x.time>=l.knownAt && (l.kind==="HIGH"?x.high>l.price:x.low<l.price));
      if(touchedBefore) continue;
      if(l.kind==="HIGH" && b.high>l.price) sweeps.push({time:b.time+MINUTE,direction:"SHORT",price:l.price});
      if(l.kind==="LOW" && b.low<l.price) sweeps.push({time:b.time+MINUTE,direction:"LONG",price:l.price});
    }
  }
  }
  sweeps.sort((a,b)=>a.time-b.time);
  const sweep=sweeps.at(-1);
  if(!sweep) return result;
  if(sweeps.some(x=>x.time===sweep.time && x.direction!==sweep.direction)) {result.phase="Conflicting liquidity sweeps";return result;}
  checks[0].passed=true;
  const reversal=five.find(e=>e.time>=sweep.time && e.direction===sweep.direction);
  result.phase="Waiting for five-minute reversal";
  if(!reversal) return result;
  checks[1].passed=true;
  result.phase="Waiting for NQ / ES alignment";
  if(five.at(-1)?.direction!==sweep.direction || peerFive.at(-1)?.direction!==sweep.direction) return result;
  checks[2].passed=true;
  result.phase="Waiting for one-minute pullback";
  const retrace=one.find(e=>e.time>reversal.time && e.direction!==sweep.direction);
  if(!retrace) return result;
  checks[3].passed=true;
  result.phase="Waiting for one-minute continuation";
  const continuation=one.find(e=>e.time>retrace.time && e.direction===sweep.direction);
  if(!continuation || continuation.time!==now) return result;
  checks[4].passed=true;
  const retraceBars=bars.filter(b=>b.time+MINUTE>=retrace.time && b.time+MINUTE<=now);
  const entry=bars.at(-1)!.close, long=sweep.direction==="LONG", tick=c.contracts[root].tickSize;
  const stop=long ? Math.min(...retraceBars.map(b=>b.low))-tick : Math.max(...retraceBars.map(b=>b.high))+tick;
  const targetLevels=[...levels,...pivots(aggregate(bars,5),c.pivotStrength,5)];
  const targets=[...new Set(targetLevels.filter(l=>l.knownAt<=now && (long?l.kind==="HIGH" && l.price>entry:l.kind==="LOW" && l.price<entry)).map(l=>l.price))].sort((a,b)=>long?a-b:b-a).slice(0,3);
  result.phase="Waiting for a usable liquidity target";
  if(!targets.length || Math.abs(targets[0]-entry)/Math.abs(entry-stop)<c.minRewardRisk) return result;
  checks[5].passed=true; result.phase="Setup complete";
  result.signal={id:`${c.version}:${root}:${sweep.direction}:${now}`,root,direction:sweep.direction,time:now,entry,stop,targets,evidence:checks.map(x=>x.label)};
  return result;
}
