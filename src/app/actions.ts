"use server";

import { revalidatePath } from "next/cache";
import { AuthError } from "next-auth";
import { assetBySymbol, normalizeSymbol } from "@/lib/assets";
import { auth, signIn, signOut } from "@/auth";
import { prisma } from "@/server/db";
import { flattenAgentTrades } from "@/server/trading";

async function requireAccount() {
  const session = await auth();
  if (!session?.user) throw new Error("Sign in required.");
  const account = await prisma.account.findFirst();
  if (!account) throw new Error("No paper account is set up.");
  return account;
}

export async function authenticate(formData: FormData) {
  try {
    await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      redirectTo: "/",
    });
  } catch (error) {
    if (error instanceof AuthError) return { error: "That email or password did not match." };
    throw error;
  }
}

export async function signOutDesk() {
  await signOut({ redirectTo: "/login" });
}

export async function togglePause(formData: FormData) {
  const account = await requireAccount();
  const fonzo = String(formData.get("desk") ?? "uriel") === "fonzo";
  const paused = fonzo ? !account.fonzoPaused : !account.agentPaused;
  const name = fonzo ? "Fonzo" : "Uriel";
  await prisma.account.update({
    where: { id: account.id },
    data: fonzo ? { fonzoPaused: paused } : { agentPaused: paused },
  });
  await prisma.agentEvent.create({
    data: {
      accountId: account.id,
      kind: "CONTROL",
      level: "info",
      message: paused ? `${name} paused. No new entries.` : `${name} resumed. Entries follow the risk engine.`,
    },
  });
  revalidatePath("/", "layout");
}

export async function flattenNow(formData: FormData) {
  const account = await requireAccount();
  const symbol = normalizeSymbol(String(formData.get("symbol") ?? "SPY"));
  const asset = assetBySymbol(symbol);
  if (!asset) throw new Error("That symbol is not tradable.");
  const closed = await flattenAgentTrades(account.id, new Date(), "FLATTEN", { symbols: [asset.symbol] });
  await prisma.agentEvent.create({
    data: {
      accountId: account.id,
      kind: "FLATTEN",
      level: "info",
      message: closed.length
        ? `Flattened ${closed.length} ${asset.symbol} position${closed.length === 1 ? "" : "s"}.`
        : `No agent ${asset.symbol} position was open.`,
    },
  });
  revalidatePath("/", "layout");
}
