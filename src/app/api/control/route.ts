import { NextResponse } from "next/server";
import { localMutation } from "@/server/http";
import { queueCommand } from "@/server/store";
export async function POST(request:Request) {
  try {
    localMutation(request);
    const body=await request.text();if(body.length>1024)throw new Error("Request too large.");
    const {action}=JSON.parse(body);
    if(!["pause","resume","flatten"].includes(action))throw new Error("Unknown control.");
    return NextResponse.json({queued:queueCommand(action),message:"Queued for the local simulation worker. This is not a broker command."},{status:202});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Invalid command"},{status:400});}
}
