import { signOutDesk } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Suspense } from "react";
import { DeskShell } from "@/components/desk-shell";
import { getFuturesDesk } from "@/server/futures-view";
export const dynamic="force-dynamic";
export default function DeskLayout({children}:{children:React.ReactNode}) {
 const {s}=getFuturesDesk();
 return <Suspense><DeskShell halt={Boolean(s.halt)} urielPaused={s.paused} accountControl={<form action={signOutDesk}><Button type="submit" variant="ghost" size="sm">Sign out</Button></form>}>{children}</DeskShell></Suspense>;
}
