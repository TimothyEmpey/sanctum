import { PrismaClient } from "@prisma/client";
import type { Config, State } from "../core/types";
import { fingerprint } from "./store";

let db:PrismaClient|undefined;
/** Optional audit mirror only. Local durable state remains authoritative for offline simulation. */
export async function mirror(s:State,c:Config) {
  if(!process.env.URIEL_AUDIT_DATABASE_URL) return;
  db??=new PrismaClient({datasourceUrl:process.env.URIEL_AUDIT_DATABASE_URL});
  await db.futuresRun.upsert({where:{id:fingerprint(c)},create:{id:fingerprint(c),configJson:JSON.stringify(c),stateJson:JSON.stringify(s)},update:{stateJson:JSON.stringify(s)}});
}
export async function disconnectAudit(){await db?.$disconnect();}
