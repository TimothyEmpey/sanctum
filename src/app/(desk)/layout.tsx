import { Suspense } from "react";
import { DeskShell } from "@/components/desk-shell";
import { getDesk } from "@/server/desk";

export const dynamic = "force-dynamic";

export default async function DeskLayout({ children }: { children: React.ReactNode }) {
  const desk = await getDesk();
  return (
    <Suspense>
      <DeskShell halt={Boolean(desk?.haltReason)} urielPaused={Boolean(desk?.urielPaused)} fonzoPaused={Boolean(desk?.fonzoPaused)} stockLive={Boolean(desk?.stockLive)}>
        {children}
      </DeskShell>
    </Suspense>
  );
}
