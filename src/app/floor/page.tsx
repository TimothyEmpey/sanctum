import { Suspense } from "react";
import { DeskShell } from "@/components/desk-shell";
import { FuturesPage } from "@/components/futures-pages";
import { getFuturesDesk } from "@/server/futures-view";
import { signOutDesk } from "@/app/actions";
import { Button } from "@/components/ui/button";
export const dynamic="force-dynamic";
export default function FloorPage(){const {s}=getFuturesDesk();return <Suspense><DeskShell halt={Boolean(s.halt)} urielPaused={s.paused} accountControl={<form action={signOutDesk}><Button type="submit" variant="ghost" size="sm">Sign out</Button></form>}><FuturesPage page="Floor"/></DeskShell></Suspense>;}
