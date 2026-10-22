"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";
export function FuturesControls({paused}:{paused:boolean}) {
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState("");const router=useRouter();
 async function send(action:string){setBusy(true);try{const response=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});const body=await response.json();setNotice(body.message??body.error);router.refresh();}catch{setNotice('Could not reach the local worker queue.');}finally{setBusy(false);}}
 return <><div className="mt-4 flex flex-wrap gap-2"><Button disabled={busy} onClick={()=>send(paused?'resume':'pause')}>{paused?'Resume Uriel':'Pause Uriel'}</Button><Button disabled={busy} variant="outline" onClick={()=>send('flatten')}>Flatten simulation</Button></div><p role="status" className="mt-3 text-xs text-[var(--muted)]">{notice||'Controls require the local worker. These are simulation actions, not broker orders.'}</p></>;
}
