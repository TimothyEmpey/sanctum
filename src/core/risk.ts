import type { Config, Signal, State } from "./types";

export function assess(signal: Signal, s: State, c: Config, now: number, entry: number) {
  const reasons:string[]=[], contract=c.contracts[signal.root];
  const session=c.sessions.find(x=>now>=x.open && now<x.entryEnd);
  if(!session) reasons.push("Outside configured entry session.");
  if(!session?.newsReviewed) reasons.push("News calendar has not been reviewed for this session.");
  if(session?.news.some(n=>now>=n.start && now<=n.end)) reasons.push("Scheduled news blackout.");
  if(!contract.id || contract.expiresAt<=now) reasons.push("Dated execution contract is missing or expired.");
  if(s.paused || s.halt) reasons.push(s.halt ?? "Paused by operator.");
  if(s.position) reasons.push("One shared position across NQ and ES; correlated exposure blocked.");
  if(s.tradesToday>=c.maxTradesPerDay) reasons.push("Daily entry cap reached.");
  if(!Number.isFinite(entry) || !Number.isFinite(signal.stop) || !signal.targets.every(Number.isFinite)) reasons.push("Invalid order prices.");
  if(signal.direction==="LONG" ? signal.stop>=entry || signal.targets[0]<=entry : signal.stop<=entry || signal.targets[0]>=entry) reasons.push("Entry moved outside the stop/target structure.");
  if(Math.abs(signal.targets[0]-entry)/Math.abs(entry-signal.stop)<c.minRewardRisk) reasons.push("Reward/risk no longer meets the minimum.");
  const allowance=Math.max(0,Math.min(c.riskPerTrade,s.equity-s.lossFloor-c.safetyBuffer,c.dailyLoss+(s.equity-s.dayStart)-c.safetyBuffer));
  const riskPerContract=Math.abs(entry-signal.stop)*contract.pointValue+c.slippageTicks*contract.tickSize*contract.pointValue+2*c.commissionPerSide;
  const quantity=Number.isFinite(riskPerContract) && riskPerContract>0 ? Math.min(c.maxContracts,Math.floor(allowance/riskPerContract)) : 0;
  if(quantity<1) reasons.push("Remaining loss allowance cannot fund one whole contract with costs.");
  return {approved:reasons.length===0,quantity:reasons.length===0?quantity:0,risk:quantity*riskPerContract,allowance,reasons};
}

export function breach(s:State,c:Config):string|null {
  if(s.equity<=s.lossFloor+c.safetyBuffer) return "Account loss buffer reached.";
  if(s.equity<=s.dayStart-c.dailyLoss+c.safetyBuffer) return "Daily loss buffer reached.";
  return null;
}
