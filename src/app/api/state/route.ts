import { NextResponse } from "next/server";
import { report } from "@/core/engine";
import { config, readState } from "@/server/store";
export const dynamic="force-dynamic";
export async function GET() {
  try {
    const c=config(),s=readState(c);
    return NextResponse.json({config:c,state:{...s,history:{NQ:s.history.NQ.slice(-700),ES:s.history.ES.slice(-700)},events:s.events.slice(-80),fills:s.fills.slice(-100)},report:report(s,c)},{headers:{"Cache-Control":"no-store"}});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Ledger unavailable"},{status:503});}
}
