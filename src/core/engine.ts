import { evaluate } from "./strategy";
import { assess, breach } from "./risk";
import { MINUTE, validateFrames } from "./market";
import type { Config, Fill, Frame, Root, State } from "./types";

const money=(x:number)=>Math.round(x*100)/100;
export function initialState(c:Config,mode:State["mode"]="replay",provenance="No market data loaded"):State {
  return {schemaVersion:1,configVersion:c.version,mode,provenance,balance:c.startingBalance,equity:c.startingBalance,lossFloor:c.startingBalance-c.maxLoss,peakEquity:c.startingBalance,maxDrawdown:0,dayStart:c.startingBalance,day:"",eodHigh:c.startingBalance,tradesToday:0,paused:false,halt:null,lastTime:0,position:null,pending:null,fills:[],events:[],seenSignals:[],history:{NQ:[],ES:[]},evaluations:[],daily:{},dayOpeningBalance:c.startingBalance,frames:0,lastMarks:{NQ:0,ES:0}};
}
export function event(s:State,time:number,kind:string,message:string) {
  s.events.push({time,kind,message});
}
function mark(s:State,c:Config,prices:Record<Root,number>) {
  s.equity=money(s.balance+(s.position ? (prices[s.position.root]-s.position.entry)*(s.position.direction==="LONG"?1:-1)*s.position.quantity*c.contracts[s.position.root].pointValue : 0));
  s.peakEquity=Math.max(s.peakEquity,s.equity);
  s.maxDrawdown=Math.max(s.maxDrawdown??0,s.peakEquity-s.equity);
}
export function closeQuantity(s:State,c:Config,time:number,rawPrice:number,quantity:number,reason:string,slippage=true) {
  const p=s.position;
  if(!p || quantity<=0 || quantity>p.quantity || !Number.isInteger(quantity)) throw new Error("Invalid close quantity.");
  const spec=c.contracts[p.root], sign=p.direction==="LONG"?1:-1;
  const price=rawPrice-(slippage ? sign*c.slippageTicks*spec.tickSize : 0);
  const fee=money(quantity*c.commissionPerSide), pnl=money((price-p.entry)*sign*quantity*spec.pointValue-fee);
  const fill:Fill={id:`${p.id}:exit:${s.fills.length}`,positionId:p.id,root:p.root,contractId:p.contractId,time,side:sign===1?"SELL":"BUY",quantity,price,fee,reason,netPnl:pnl};
  s.fills.push(fill);s.balance=money(s.balance+pnl);p.realized+=pnl;p.fees+=fee;p.quantity-=quantity;
  event(s,time,"EXIT",`${p.root} ${quantity} contract(s): ${reason} at ${price}.`);
  if(p.quantity===0) s.position=null;
}
export function flatten(s:State,c:Config,time:number,reason:string) {
  s.pending=null;
  if(s.position) closeQuantity(s,c,time,s.lastMarks[s.position.root]||s.position.entry,s.position.quantity,reason);
  mark(s,c,s.lastMarks);
}

/** Pure simulator: never imports credentials, network clients, or a real execution adapter. */
export function step(s:State,c:Config,frame:Frame,wallTime=frame.time):State {
  validateFrames([frame]);
  if(c.version!==s.configVersion) throw new Error("Configuration changed: start a separate validation run.");
  if(frame.time<=s.lastTime) throw new Error("Duplicate or out-of-order frame rejected.");
  if(frame.time>wallTime) throw new Error("Future or incomplete candle rejected.");
  const stale=s.mode==="paper" && wallTime-frame.time>c.maxFrameAgeSeconds*1000;
  const gap=s.lastTime>0 && frame.time-s.lastTime>MINUTE;
  const date=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(frame.time-1);
  if(date!==s.day) {
    if(s.day) {
      if(s.position) {flatten(s,c,s.lastTime,"MISSING_SESSION_CLOSE");s.halt="Open position survived a session boundary; review required.";s.paused=true;}
      s.daily[s.day]=money(s.balance-s.dayOpeningBalance);
      s.eodHigh=Math.max(s.eodHigh,s.balance);
      if(c.drawdown==="EOD_TRAILING") s.lossFloor=Math.max(s.lossFloor,Math.min(c.startingBalance,s.eodHigh-c.maxLoss));
    }
    s.day=date;s.dayStart=s.balance;s.dayOpeningBalance=s.balance;s.tradesToday=0;s.pending=null;
  }
  const session=c.sessions.find(x=>x.date===date);
  const time=frame.time;
  for(const root of ["NQ","ES"] as Root[]) {s.history[root].push(frame[root]);s.lastMarks[root]=frame[root].close;}
  // Keep enough history for 4h swings and session targets without unbounded chart payloads.
  for(const root of ["NQ","ES"] as Root[]) s.history[root]=s.history[root].filter(b=>b.time>=time-7*86400_000);
  if(gap) {s.pending=null;event(s,time,"DATA_GAP","Missing minutes: no new entry on this frame.");}
  if(stale) {s.pending=null;event(s,time,"STALE_DATA","Stale data: no new entries; local fills are historical simulation only.");}

  // A signal is executable only on the immediately following candle, never at its own close.
  const pending=s.pending;s.pending=null;
  if(pending && !gap && !stale && time-pending.time===MINUTE) {
    const spec=c.contracts[pending.root], sign=pending.direction==="LONG"?1:-1;
    const entry=frame[pending.root].open+sign*c.slippageTicks*spec.tickSize;
    const decision=assess(pending,s,c,time-MINUTE,entry);
    if(decision.approved) {
      const fee=money(decision.quantity*c.commissionPerSide),id=`position:${pending.id}`;
      s.position={id,signalId:pending.id,root:pending.root,contractId:spec.id,direction:pending.direction,openedAt:time-MINUTE,entry,initialStop:pending.stop,stop:pending.stop,targets:pending.targets,nextTarget:0,initialQuantity:decision.quantity,quantity:decision.quantity,realized:-fee,fees:fee};
      s.balance=money(s.balance-fee);s.tradesToday++;
      s.fills.push({id:`${id}:entry`,positionId:id,root:pending.root,contractId:spec.id,time:time-MINUTE,side:sign===1?"BUY":"SELL",quantity:decision.quantity,price:entry,fee,reason:"ENTRY",netPnl:-fee});
      event(s,time,"ENTRY",`${pending.direction} ${decision.quantity} ${spec.id} at ${entry}; local simulation.`);
    } else event(s,time,"RISK_BLOCK",decision.reasons.join(" "));
  }

  const p=s.position;
  if(p) {
    const b=frame[p.root],long=p.direction==="LONG";
    // OHLC cannot establish intrabar sequence: stop is always evaluated before targets.
    const stopHit=long?b.low<=p.stop:b.high>=p.stop;
    if(stopHit) closeQuantity(s,c,time,long?Math.min(p.stop,b.open):Math.max(p.stop,b.open),p.quantity,"STOP");
    else {
      const worst={...s.lastMarks,[p.root]:long?b.low:b.high};
      mark(s,c,worst);
      const hit=breach(s,c);
      if(hit) {s.halt=hit;s.paused=true;closeQuantity(s,c,time,worst[p.root],p.quantity,"RISK_HALT");}
      else {
        while(s.position && p.nextTarget<p.targets.length && (long?b.high>=p.targets[p.nextTarget]:b.low<=p.targets[p.nextTarget])) {
          const target=p.targets[p.nextTarget];
          const quantity=p.nextTarget===p.targets.length-1 ? p.quantity : Math.max(1,Math.floor(p.initialQuantity/p.targets.length));
          closeQuantity(s,c,time,target,Math.min(quantity,p.quantity),"TARGET",false);
          p.nextTarget++;
          // Becomes effective on the next bar; never retrospectively reorders the current bar.
          if(s.position) p.stop=p.entry;
        }
      }
    }
  }
  mark(s,c,s.lastMarks);
  const hit=breach(s,c);
  if(hit) {s.halt=hit;s.paused=true;flatten(s,c,time,"RISK_HALT");}
  if(!session || time>=session.flatten) flatten(s,c,time,"SESSION_CLOSE");
  s.evaluations=(["NQ","ES"] as Root[]).map(root=>evaluate(root,s.history,c,time));
  if(!stale && !gap && !s.position && !s.paused && !s.halt && session && time>=session.open && time<session.entryEnd) {
    // Stable NQ-first tie-break, one shared account risk budget, no simultaneous correlated entries.
    for(const evaluation of s.evaluations) {
      const signal=evaluation.signal;
      if(!signal || s.seenSignals.includes(signal.id)) continue;
      s.seenSignals.push(signal.id);
      const decision=assess(signal,s,c,time,signal.entry);
      if(decision.approved) {s.pending=signal;event(s,time,"SIGNAL",`${signal.root}: all strategy and risk checks passed; next-bar execution.`);break;}
      event(s,time,"RISK_BLOCK",`${signal.root}: ${decision.reasons.join(" ")}`);
    }
  }
  s.daily[date]=money(s.balance-s.dayOpeningBalance);s.lastTime=time;s.frames++;
  return s;
}

export function report(s:State,c:Config) {
  const groups=new Map<string,number>();
  for(const f of s.fills) groups.set(f.positionId,(groups.get(f.positionId)??0)+f.netPnl);
  if(s.position) groups.delete(s.position.id);
  const pnls=[...groups.values()],wins=pnls.filter(x=>x>0),losses=pnls.filter(x=>x<0);
  const weeks:Record<string,number>={};
  for(const [day,pnl] of Object.entries(s.daily)) {
    const d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));
    const key=d.toISOString().slice(0,10);weeks[key]=money((weeks[key]??0)+pnl);
  }
  const dates=Object.keys(s.daily).sort(),span=dates.length?Math.round((Date.parse(dates.at(-1)!)-Date.parse(dates[0]))/86400_000)+1:0;
  return {maxDrawdown:money(s.maxDrawdown??0),netPnl:money(s.balance-c.startingBalance),closedTrades:pnls.length,winRate:pnls.length?wins.length/pnls.length:null,profitFactor:losses.length?wins.reduce((a,b)=>a+b,0)/-losses.reduce((a,b)=>a+b,0):null,fees:money(s.fills.reduce((a,b)=>a+b.fee,0)),weeks,calendarDays:span,positiveWeeks:Object.values(weeks).filter(x=>x>0).length,monthGate:!/(synthetic|example|no market data)/i.test(s.provenance) && dates.length>=20 && span>=28 && Object.keys(weeks).length>=4 && s.balance>c.startingBalance && Object.values(weeks).filter(x=>x<0).length<=1,validated:false, note:"A positive month is an initial research gate, not proof of profitability or permission to trade live."};
}
