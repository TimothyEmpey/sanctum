import fs from "node:fs";
import { initialState, report, step } from "../src/core/engine";
import { validateFeed } from "../src/core/feed";
import { acquireWriter, config, saveState } from "../src/server/store";

const file=process.argv[2];
if(!file) throw new Error("Usage: npm run replay -- path/to/feed.json [report.json]. Use a fresh URIEL_DATA_DIR for each run.");
const c=config(),document=JSON.parse(fs.readFileSync(file,"utf8"));
if(!document.provenance) throw new Error("Feed requires provenance.");
const frames=validateFeed(document,c),s=initialState(c,"replay",document.provenance);
const dir=process.env.URIEL_DATA_DIR??"data/futures";
if(fs.existsSync(`${dir}/state.json`))throw new Error("Existing run preserved. Set URIEL_DATA_DIR to a fresh directory.");
const release=acquireWriter();
try {
  for(const f of frames)step(s,c,f);
  saveState(s,c);
  const result={...report(s,c),openPosition:s.position,pendingSignal:s.pending,provenance:s.provenance};
  if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2),{flag:"wx"});
  console.log(JSON.stringify(result,null,2));
} finally {release();}
