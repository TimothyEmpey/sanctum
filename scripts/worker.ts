import fs from "node:fs";
import path from "node:path";
import { executionMode } from "../src/core/config";
import { event, flatten, step } from "../src/core/engine";
import { validateFeed } from "../src/core/feed";
import { acknowledge, acquireWriter, commands, config, readState, saveState } from "../src/server/store";
import { disconnectAudit, mirror } from "../src/server/audit";

async function main() {
  const mode=executionMode(process.env.URIEL_MODE);
  const c=config(),release=acquireWriter();
  let stopping=false;
  process.on("SIGINT",()=>{stopping=true;});process.on("SIGTERM",()=>{stopping=true;});
  let s;
  try {s=readState(c);s.mode=mode;} catch(error) {release();throw error;}
  const feed=path.resolve(process.env.URIEL_FEED_FILE??"data/futures/feed.json");
  console.log(`Uriel ${mode}: NQ1! / ES1!. Local simulation only. No broker connection.`);
  try {
    while(!stopping) {
      for(const cmd of commands()) {
        // Command event is saved before deletion: re-delivery is idempotent after a crash.
        if(!s.events.some(e=>e.kind===`CONTROL:${cmd.id}`)) {
          if(cmd.action==="resume" && s.halt) event(s,cmd.at,`CONTROL:${cmd.id}`,"Resume refused: risk halt requires a separate reviewed run.");
          else {
            s.paused=cmd.action!=="resume";s.pending=null;
            if(cmd.action==="flatten") flatten(s,c,s.lastTime||cmd.at,"OPERATOR_FLATTEN");
            event(s,cmd.at,`CONTROL:${cmd.id}`,cmd.action);
          }
          saveState(s,c);
        }
        acknowledge(cmd.id);
      }
      if(fs.existsSync(feed)) {
        const document=JSON.parse(fs.readFileSync(feed,"utf8"));
        const frames=validateFeed(document,c);
        s.provenance=document.provenance;
        for(const frame of frames.filter(f=>f.time>s.lastTime)) {
          if(stopping)break;
          step(s,c,frame,mode==="paper"?Date.now():frame.time);saveState(s,c);
        }
        await mirror(s,c);
      }
      saveState(s,c);
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  } catch(error) {
    s.paused=true;s.pending=null;s.halt="Worker error: review data and ledger before resuming.";
    event(s,Date.now(),"WORKER_ERROR",error instanceof Error?error.message:"Unknown error");saveState(s,c);throw error;
  } finally {release();await disconnectAudit();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
