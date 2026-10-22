export type Root = "NQ" | "ES";
export type Direction = "LONG" | "SHORT";
export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Frame = { time: number; NQ: Bar; ES: Bar };
export type Level = { price: number; kind: "HIGH" | "LOW"; source: string; knownAt: number };
export type Contract = { root: Root; id: string; expiresAt: number; tickSize: number; pointValue: number };
export type Signal = { id: string; root: Root; direction: Direction; time: number; entry: number; stop: number; targets: number[]; evidence: string[] };
export type Evaluation = { root: Root; phase: string; checks: { label: string; passed: boolean }[]; levels: Level[]; signal?: Signal };
export type Position = { id: string; signalId: string; root: Root; contractId: string; direction: Direction; openedAt: number; entry: number; initialStop: number; stop: number; targets: number[]; nextTarget: number; initialQuantity: number; quantity: number; realized: number; fees: number };
export type Fill = { id: string; positionId: string; root: Root; contractId: string; time: number; side: "BUY" | "SELL"; quantity: number; price: number; fee: number; reason: string; netPnl: number };
export type Event = { time: number; kind: string; message: string };
export type Session = { date: string; open: number; entryEnd: number; flatten: number; news: { start: number; end: number; label: string }[]; newsReviewed: boolean };
export type Config = {
  version: string; sourceUrl: string; strategyValidated: boolean;
  startingBalance: number; maxLoss: number; dailyLoss: number; riskPerTrade: number; maxContracts: number;
  maxTradesPerDay: number; safetyBuffer: number; drawdown: "STATIC" | "EOD_TRAILING";
  commissionPerSide: number; slippageTicks: number; minRewardRisk: number; pivotStrength: number;
  maxSetupMinutes: number; maxFrameAgeSeconds: number; experimentBudget: number;
  contracts: Record<Root, Contract>; sessions: Session[];
};
export type State = {
  schemaVersion: 1; configVersion: string; mode: "replay" | "paper"; provenance: string;
  balance: number; equity: number; lossFloor: number; peakEquity: number; maxDrawdown: number; dayStart: number; day: string;
  eodHigh: number; tradesToday: number; paused: boolean; halt: string | null; lastTime: number;
  position: Position | null; fills: Fill[]; events: Event[]; seenSignals: string[]; history: Record<Root, Bar[]>;
  evaluations: Evaluation[]; daily: Record<string, number>; dayOpeningBalance: number; frames: number;
  pending: Signal | null; lastMarks: Record<Root, number>;
};
