import { config, readState } from "./store";
import { report } from "../core/engine";
import type { Root } from "../core/types";
export function getFuturesDesk(asset?:string) {
  const c=config(),s=readState(c),r=report(s,c),root:Root=asset==="ES"?"ES":"NQ";
  const bars=(symbol:Root)=>s.history[symbol].map(b=>({...b,t:b.time}));
  let balance=c.startingBalance;
  const equity=Object.entries(s.daily).sort(([a],[b])=>a.localeCompare(b)).map(([date,pnl])=>({t:Date.parse(`${date}T20:00:00Z`),equityCents:Math.round((balance+=pnl)*100)}));
  const p=s.position;
  const openRisk=p?Math.max(0,Math.abs(p.entry-p.stop)*p.quantity*c.contracts[p.root].pointValue+p.quantity*(c.commissionPerSide+c.slippageTicks*c.contracts[p.root].tickSize*c.contracts[p.root].pointValue)):0;
  return {c,s,r,root,bars,equity,openRisk,evaluation:s.evaluations.find(e=>e.root===root)};
}
export type FuturesDesk=ReturnType<typeof getFuturesDesk>;
