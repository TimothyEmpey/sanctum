import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { defaultConfig, validateConfig } from "../core/config";
import { initialState } from "../core/engine";
import type { Config, State } from "../core/types";

const directory=()=>path.resolve(process.env.URIEL_DATA_DIR??"data/futures");
export function config():Config {
  const file=path.resolve(process.env.URIEL_CONFIG_FILE??"futures.config.json");
  return fs.existsSync(file)?validateConfig(JSON.parse(fs.readFileSync(file,"utf8"))):structuredClone(defaultConfig);
}
export const fingerprint=(c:Config)=>createHash("sha256").update(JSON.stringify(c)).digest("hex");
export function readState(c:Config):State {
  const file=path.join(directory(),"state.json");
  if(!fs.existsSync(file)) return initialState(c);
  const saved=JSON.parse(fs.readFileSync(file,"utf8"));
  if(saved.fingerprint!==fingerprint(c)) throw new Error("Configuration differs from the saved run. Use a separate URIEL_DATA_DIR for a new validation run.");
  if(saved.state?.schemaVersion!==1) throw new Error("Unsupported ledger schema.");
  if (/(synthetic|fabricated|example)/i.test(saved.state.provenance??"")) throw new Error("Synthetic datasets are not permitted in the trading desk. Configure a real market-data source and a separate ledger.");
  return saved.state;
}
export function saveState(s:State,c:Config) {
  fs.mkdirSync(directory(),{recursive:true,mode:0o700});
  const target=path.join(directory(),"state.json"),tmp=`${target}.${randomUUID()}.tmp`;
  const fd=fs.openSync(tmp,"wx",0o600);
  try {fs.writeFileSync(fd,JSON.stringify({fingerprint:fingerprint(c),state:s}));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(tmp,target);
  const dir=fs.openSync(directory(),"r");try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
export function acquireWriter():()=>void {
  fs.mkdirSync(directory(),{recursive:true,mode:0o700});
  const file=path.join(directory(),"writer.lock");
  // A crashed lock is deliberately not silently stolen. Operator checks PID and removes it.
  const fd=fs.openSync(file,"wx",0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));fs.closeSync(fd);
  return ()=>{if(fs.existsSync(file))fs.unlinkSync(file);};
}
export type Command={id:string;action:"pause"|"resume"|"flatten";at:number};
export function queueCommand(action:Command["action"]) {
  fs.mkdirSync(path.join(directory(),"commands"),{recursive:true,mode:0o700});
  const command={id:randomUUID(),action,at:Date.now()};
  const file=path.join(directory(),"commands",`${command.id}.json`);
  fs.writeFileSync(`${file}.tmp`,JSON.stringify(command),{mode:0o600});fs.renameSync(`${file}.tmp`,file);
  return command;
}
export function commands():Command[] {
  const dir=path.join(directory(),"commands");
  if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(x=>x.endsWith(".json")).map(file=>JSON.parse(fs.readFileSync(path.join(dir,file),"utf8")) as Command).sort((a,b)=>a.at-b.at);
}
export function acknowledge(id:string) {fs.unlinkSync(path.join(directory(),"commands",`${id}.json`));}
