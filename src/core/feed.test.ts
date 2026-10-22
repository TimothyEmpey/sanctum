import { expect,it } from "vitest";
import { validateFeed } from "./feed";
import { defaultConfig } from "./config";
it("rejects a continuous or mismatched source contract",()=>{
  const c=structuredClone(defaultConfig);c.contracts.NQ.id="NQZ26";c.contracts.ES.id="ESZ26";
  expect(()=>validateFeed({provenance:"export",contracts:{NQ:"NQ1!",ES:"ESZ26"},frames:[]},c)).toThrow(/contract/);
});
it("synthetic profits cannot satisfy the month gate",async()=>{
  const {initialState,report}=await import("./engine");const c=structuredClone(defaultConfig),s=initialState(c,"replay","SYNTHETIC");
  for(let i=1;i<=30;i++)s.daily[`2026-09-${String(i).padStart(2,"0")}`]=10;
  s.balance+=300;expect(report(s,c).monthGate).toBe(false);
});
it("rejects fabricated feeds before they can reach the trading desk",()=>{
  const c=structuredClone(defaultConfig);c.contracts.NQ.id="NQZ26";c.contracts.ES.id="ESZ26";
  expect(()=>validateFeed({provenance:"SYNTHETIC EXAMPLE",contracts:{NQ:"NQZ26",ES:"ESZ26"},frames:[]},c)).toThrow(/Synthetic/);
});
