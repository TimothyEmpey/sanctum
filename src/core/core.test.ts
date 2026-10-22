import { describe, expect, it } from "vitest";
import { defaultConfig, executionMode, validateConfig } from "./config";
import { aggregate, pivots, structure, validateFrames } from "./market";
import { assess } from "./risk";
import { closeQuantity, initialState, report, step } from "./engine";
import { externalAdapter, orderCanReleaseReservation } from "./execution";
import { evaluate } from "./strategy";
import type { Bar, Config, Frame, Signal } from "./types";

const OPEN=Date.parse("2026-10-20T13:30:00Z");
function config():Config {
  const c=structuredClone(defaultConfig);c.safetyBuffer=50;c.riskPerTrade=500;c.dailyLoss=1000;c.maxContracts=3;
  c.contracts.NQ={...c.contracts.NQ,id:"NQZ26",expiresAt:OPEN+86400_000};
  c.contracts.ES={...c.contracts.ES,id:"ESZ26",expiresAt:OPEN+86400_000};
  c.sessions=[{date:"2026-10-20",open:OPEN,entryEnd:OPEN+3600_000,flatten:OPEN+6*3600_000,newsReviewed:true,news:[]}];
  return c;
}
function bar(time:number,open=20000,high=open+1,low=open-1,close=open):Bar{return {time,open,high,low,close,volume:100};}
function frame(time:number,b=bar(time-60_000)):Frame{return {time,NQ:b,ES:bar(time-60_000,6000)};}
function signal():Signal{return {id:"test",root:"NQ",direction:"LONG",time:OPEN,entry:20000,stop:19990,targets:[20020,20030],evidence:[]};}
function opened() {
  const c=config(),s=initialState(c);s.day="2026-10-20";s.lastTime=OPEN;s.pending=signal();
  step(s,c,frame(OPEN+60_000));return {s,c};
}
describe("configuration and external boundary",()=>{
  it("never arms a real adapter through environment",()=>{expect(()=>executionMode("live")).toThrow();expect(()=>externalAdapter()).toThrow();});
  it("rejects continuous and wrong-root execution symbols",()=>{for(const id of ["NQ1!","NQ1","ESZ26"]){const c=config();c.contracts.NQ.id=id;expect(()=>validateConfig(c)).toThrow();}});
  it("rejects invalid numeric limits",()=>{const c=config();c.riskPerTrade=NaN;expect(()=>validateConfig(c)).toThrow();});
  it("rejects unordered session boundaries",()=>{const c=config();c.sessions[0].flatten=OPEN;expect(()=>validateConfig(c)).toThrow();});
  it("reserves unknown and partial outcomes",()=>{for(const status of ["UNKNOWN","PARTIAL","ACCEPTED"] as const)expect(orderCanReleaseReservation(status,0,true)).toBe(false);expect(orderCanReleaseReservation("CANCELED",1,true)).toBe(false);expect(orderCanReleaseReservation("CANCELED",0,true)).toBe(true);});
});
describe("causal market data",()=>{
  it("rejects mismatched clocks, duplicates, NaN and impossible candles",()=>{
    const f=frame(OPEN);expect(()=>validateFrames([f,f])).toThrow();
    const bad=structuredClone(f);bad.ES.time-=60_000;expect(()=>validateFrames([bad])).toThrow();
    bad.ES=f.ES;bad.NQ.low=NaN;expect(()=>validateFrames([bad])).toThrow();
    bad.NQ=bar(OPEN-60_000,20000,19999);expect(()=>validateFrames([bad])).toThrow();
  });
  it("does not fabricate incomplete five-minute candles",()=>{const rows=Array.from({length:5},(_,i)=>bar(OPEN+i*60_000));expect(aggregate(rows,5)).toHaveLength(1);expect(aggregate(rows.slice(1),5)).toHaveLength(0);});
  it("only confirms a pivot after the right-hand bars close",()=>{const rows=[bar(OPEN,10,11,9),bar(OPEN+60_000,12,13,11),bar(OPEN+120_000,10,11,9)];expect(pivots(rows.slice(0,2),1,1)).toHaveLength(0);expect(pivots(rows,1,1)[0].knownAt).toBe(OPEN+180_000);});
  it("detects a close through a bullish fair value gap",()=>{const rows=[bar(OPEN,100,101,99),bar(OPEN+60_000,102,103,101),bar(OPEN+120_000,104,105,103),bar(OPEN+180_000,102,103,99,100)];expect(structure(rows,1,1)).toContainEqual({time:OPEN+240_000,direction:"SHORT",kind:"IFVG"});});
  it("does not produce a signal from insufficient history",()=>{expect(evaluate("NQ",{NQ:[],ES:[]},config(),OPEN).signal).toBeUndefined();});
});
describe("shared futures risk",()=>{
  it("uses dollar multipliers and integer contracts with fees",()=>{const c=config(),s=initialState(c),d=assess(signal(),s,c,OPEN,20000);expect(d.quantity).toBe(2);expect(d.risk).toBe(430);});
  it("will not spend headline buying power as risk",()=>{const c=config(),s=initialState(c);s.equity=s.lossFloor+60;expect(assess(signal(),s,c,OPEN,20000).approved).toBe(false);});
  it("blocks a second correlated position",()=>{const {s,c}=opened();expect(assess({...signal(),root:"ES"},s,c,OPEN,6000).approved).toBe(false);});
  it("requires mapped unexpired contracts and reviewed news",()=>{const c=config(),s=initialState(c);c.contracts.NQ.expiresAt=OPEN;expect(assess(signal(),s,c,OPEN,20000).approved).toBe(false);c.contracts.NQ.expiresAt=OPEN+1;c.sessions[0].newsReviewed=false;expect(assess(signal(),s,c,OPEN,20000).approved).toBe(false);});
  it("blocks news windows and late entries",()=>{const c=config(),s=initialState(c);c.sessions[0].news=[{start:OPEN-1000,end:OPEN+1000,label:"CPI"}];expect(assess(signal(),s,c,OPEN,20000).approved).toBe(false);expect(assess(signal(),s,c,OPEN+3600_000,20000).approved).toBe(false);});
  it("rechecks risk after a gap beyond target",()=>{expect(assess(signal(),initialState(config()),config(),OPEN,20025).approved).toBe(false);});
});
describe("execution replay",()=>{
  it("fills on next open with adverse entry slippage and commission",()=>{const {s}=opened();expect(s.position?.entry).toBe(20000.5);expect(s.position?.quantity).toBe(2);expect(s.balance).toBe(49995);});
  it("rejects duplicate frames without another fill",()=>{const {s,c}=opened();expect(()=>step(s,c,frame(s.lastTime))).toThrow();expect(s.fills).toHaveLength(1);});
  it("rejects future candles",()=>{expect(()=>step(initialState(config()),config(),frame(OPEN),OPEN-1)).toThrow();});
  it("chooses stop first when both levels touched",()=>{const {s,c}=opened();step(s,c,frame(OPEN+120_000,bar(OPEN+60_000,20000,20030,19980,20010)));expect(s.position).toBeNull();expect(s.fills.at(-1)?.reason).toBe("STOP");expect(s.fills.at(-1)?.price).toBe(19989.5);});
  it("models gap-through stops at worse opening price",()=>{const {s,c}=opened();step(s,c,frame(OPEN+120_000,bar(OPEN+60_000,19980,19985,19970,19975)));expect(s.fills.at(-1)?.price).toBe(19979.5);});
  it("takes integer partials and moves remaining stop to entry",()=>{const {s,c}=opened();step(s,c,frame(OPEN+120_000,bar(OPEN+60_000,20001,20021,20000,20020)));expect(s.position?.quantity).toBe(1);expect(s.position?.stop).toBe(20000.5);expect(s.fills.at(-1)?.quantity).toBe(1);});
  it("blocks delayed signals after missing minutes",()=>{const c=config(),s=initialState(c);s.lastTime=OPEN;s.pending=signal();step(s,c,frame(OPEN+120_000));expect(s.fills).toHaveLength(0);});
  it("blocks stale paper entry",()=>{const c=config(),s=initialState(c,"paper");s.lastTime=OPEN;s.pending=signal();step(s,c,frame(OPEN+60_000),OPEN+10*60_000);expect(s.fills).toHaveLength(0);});
  it("flattens at the configured deadline",()=>{const {s,c}=opened();step(s,c,frame(c.sessions[0].flatten));expect(s.position).toBeNull();expect(s.fills.at(-1)?.reason).toBe("SESSION_CLOSE");});
  it("keeps managing protection while paused",()=>{const {s,c}=opened();s.paused=true;step(s,c,frame(OPEN+120_000,bar(OPEN+60_000,20000,20001,19980,19990)));expect(s.position).toBeNull();});
  it("survives a JSON round-trip without losing a position",()=>{const {s,c}=opened(),restored=JSON.parse(JSON.stringify(s));step(restored,c,frame(OPEN+120_000));expect(restored.position.id).toBe(s.position?.id);expect(restored.fills).toHaveLength(1);});
  it("computes short P&L with multiplier and exit fees",()=>{const {s,c}=opened();s.position!.direction="SHORT";const before=s.balance;closeQuantity(s,c,OPEN+120_000,19990,2,"TEST",false);expect(s.balance-before).toBe(415);});
  it("does not claim a month of validation from example data",()=>{const {s,c}=opened();expect(report(s,c).monthGate).toBe(false);expect(report(s,c).validated).toBe(false);});
});

describe("complete strategy sequence",()=>{
  function scenario() {
    const c=config();c.pivotStrength=1;c.minRewardRisk=.1;c.sessions[0].entryEnd=OPEN+120*60_000;
    let seed=2,nq=20000,es=6000;
    const frames:Frame[]=[];
    for(let i=0;i<510;i++) {
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      const move=Math.round((seed/4294967296-.5)*24)*.25,time=OPEN-390*60_000+i*60_000;
      const candle=(price:number)=>bar(time,price,Math.max(price,price+move)+.25,Math.min(price,price+move)-.25,price+move);
      frames.push({time:time+60_000,NQ:candle(nq),ES:candle(es)});nq+=move;es+=move;
    }
    return {c,frames};
  }
  it("requires all six checks, then executes only the next bar",()=>{
    const {c,frames}=scenario(),s=initialState(c,"replay","SYNTHETIC unit fixture");
    for(const frame of frames.slice(0,423))step(s,c,frame);
    expect(s.pending?.direction).toBe("SHORT");
    expect(s.evaluations[0].checks.every(x=>x.passed)).toBe(true);
    expect(s.fills).toHaveLength(0);
    step(s,c,frames[423]);
    expect(s.fills[0].reason).toBe("ENTRY");
    expect(s.fills[0].time).toBe(frames[422].time);
    expect(s.fills[0].quantity).toBeGreaterThan(0);
  });
  it("ignores future candles when evaluating a historical decision",()=>{
    const {c,frames}=scenario(),now=frames[422].time;
    const history=(rows:Frame[])=>({NQ:rows.map(f=>f.NQ),ES:rows.map(f=>f.ES)});
    const expected=evaluate("NQ",history(frames.slice(0,423)),c,now);
    expect(expected.signal).toBeDefined();
    expect(evaluate("NQ",history(frames),c,now)).toEqual(expected);
  });
  it("stands down if the other index cannot confirm structure",()=>{
    const {c,frames}=scenario(),rows=frames.slice(0,423);
    expect(evaluate("NQ",{NQ:rows.map(f=>f.NQ),ES:rows.map(f=>bar(f.ES.time,6000))},c,rows.at(-1)!.time).signal).toBeUndefined();
  });
});
