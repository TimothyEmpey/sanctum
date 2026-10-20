/** Sell what the broker can fill. Never request more than the live balance. */
export function sellableQty(requested: number, available: number | null) {
  if (!(requested > 0)) return 0;
  const cap =
    available == null || !Number.isFinite(available) ? requested : Math.min(requested, Math.max(0, available));
  const qty = Math.floor((cap + 1e-12) * 1e8) / 1e8;
  return qty > 0 ? qty : 0;
}

/** Alpaca: "insufficient balance for BTC (requested: 0.003, available: 0.002992498)". */
export function availableFromBalanceError(message: string) {
  const match = /available:\s*([0-9]*\.?[0-9]+)/i.exec(message);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}
