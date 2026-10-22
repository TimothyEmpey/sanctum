import type { Config, Root } from "./types";

export const defaultConfig: Config = {
  version: "tjr-2026-research-v1", sourceUrl: "https://www.youtube.com/watch?v=8PYgFVB0GHE",
  strategyValidated: false, startingBalance: 50_000, maxLoss: 2_000, dailyLoss: 300,
  riskPerTrade: 100, maxContracts: 1, maxTradesPerDay: 2, safetyBuffer: 200,
  drawdown: "STATIC", commissionPerSide: 2.5, slippageTicks: 2, minRewardRisk: 1,
  pivotStrength: 2, maxSetupMinutes: 120, maxFrameAgeSeconds: 90, experimentBudget: 1_000,
  contracts: {
    NQ: { root: "NQ", id: "", expiresAt: 0, tickSize: .25, pointValue: 20 },
    ES: { root: "ES", id: "", expiresAt: 0, tickSize: .25, pointValue: 50 },
  },
  sessions: [],
};

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== "object") throw new Error("Configuration must be an object.");
  const c = value as Config;
  const positive: (keyof Config)[] = ["startingBalance", "maxLoss", "dailyLoss", "riskPerTrade", "maxContracts", "maxTradesPerDay", "safetyBuffer", "minRewardRisk", "pivotStrength", "maxSetupMinutes", "maxFrameAgeSeconds", "experimentBudget"];
  for (const k of positive) if (typeof c[k] !== "number" || !Number.isFinite(c[k]) || Number(c[k]) <= 0) throw new Error(`Invalid ${k}.`);
  for (const k of ["commissionPerSide", "slippageTicks"] as const) if (!Number.isFinite(c[k]) || c[k] < 0) throw new Error(`Invalid ${k}.`);
  if (![c.maxContracts, c.maxTradesPerDay, c.pivotStrength, c.slippageTicks].every(Number.isInteger)) throw new Error("Contract counts, pivot strength and slippage ticks must be integers.");
  if (!c.version || typeof c.strategyValidated !== "boolean" || !["STATIC", "EOD_TRAILING"].includes(c.drawdown)) throw new Error("Invalid strategy/risk profile.");
  if (c.maxLoss >= c.startingBalance || c.safetyBuffer >= c.maxLoss || c.dailyLoss > c.maxLoss) throw new Error("Invalid loss allowance.");
  for (const root of ["NQ", "ES"] as Root[]) {
    const contract = c.contracts?.[root];
    if (!contract || contract.root !== root || contract.tickSize !== .25 || contract.pointValue !== (root === "NQ" ? 20 : 50)) throw new Error(`Invalid ${root} contract specification.`);
    if (typeof contract.id !== "string" || !Number.isFinite(contract.expiresAt)) throw new Error("Invalid contract mapping.");
    if (contract.id && !new RegExp(`^${root}[HMUZ]\\d{2,4}$`).test(contract.id)) throw new Error("Map a dated NQ/ES contract, never a continuous chart symbol.");
  }
  if (!Array.isArray(c.sessions)) throw new Error("Explicit exchange sessions are required.");
  const dates = new Set<string>();
  for (const s of c.sessions) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date) || dates.has(s.date) || ![s.open, s.entryEnd, s.flatten].every(Number.isFinite) || !(s.open < s.entryEnd && s.entryEnd < s.flatten)) throw new Error("Invalid or duplicate session.");
    dates.add(s.date);
    if (typeof s.newsReviewed !== "boolean" || !Array.isArray(s.news) || s.news.some(n => !Number.isFinite(n.start) || !Number.isFinite(n.end) || n.start >= n.end || typeof n.label !== "string")) throw new Error("Invalid news schedule.");
  }
  return c;
}

export function executionMode(raw: string | undefined): "replay" | "paper" {
  if (raw === undefined || raw === "replay") return "replay";
  if (raw === "paper") return "paper";
  throw new Error("External execution is unavailable. Only local replay or paper mode is implemented.");
}
