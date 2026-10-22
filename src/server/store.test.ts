import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { defaultConfig } from "../core/config";
import { initialState } from "../core/engine";
import { acquireWriter, readState, saveState } from "./store";
import { localMutation } from "./http";
let dir:string;
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),"uriel-test-"));process.env.URIEL_DATA_DIR=dir;});
afterEach(()=>{delete process.env.URIEL_DATA_DIR;fs.rmSync(dir,{recursive:true,force:true});});
it("serializes writers and allows a clean restart",()=>{const release=acquireWriter();expect(()=>acquireWriter()).toThrow();release();acquireWriter()();});
it("persists state and rejects silently changed parameters",()=>{saveState(initialState(defaultConfig),defaultConfig);expect(readState(defaultConfig).balance).toBe(50000);expect(()=>readState({...defaultConfig,riskPerTrade:200})).toThrow();});
it("read-only state loading does not create files",()=>{readState(defaultConfig);expect(fs.readdirSync(dir)).toEqual([]);});
it("rejects cross-origin and remote control requests",()=>{expect(()=>localMutation(new Request("http://127.0.0.1:3100/api/control",{headers:{origin:"https://evil.example"}}))).toThrow();expect(()=>localMutation(new Request("http://127.0.0.1:3100/api/control",{headers:{origin:"http://127.0.0.1:3100"}}))).not.toThrow();});
it("accepts a loopback Host after Next normalizes the internal URL",()=>{
  expect(()=>localMutation(new Request("http://localhost:3100/api/control",{headers:{host:"127.0.0.1:3100",origin:"http://127.0.0.1:3100"}}))).not.toThrow();
  expect(()=>localMutation(new Request("http://localhost:3100/api/control",{headers:{host:"evil.example",origin:"http://evil.example"}}))).toThrow();
});
it("refuses a saved synthetic ledger in the trading desk",()=>{
  saveState(initialState(defaultConfig,"replay","SYNTHETIC EXAMPLE"),defaultConfig);
  expect(()=>readState(defaultConfig)).toThrow(/Synthetic/);
});
