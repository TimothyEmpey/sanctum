import type { Root } from './types';
export type PriceObservation = {
  root: Root; contract: string; kind: 'last' | 'bid' | 'ask'; price: number;
  eventAt: number; receivedAt: number;
};
export type AlignmentLimits = { maxAgeMs:number; maxSkewMs:number; maxDifferenceTicks:number };
/** Compares like-for-like observations. Caller must supply trusted, normalized dated symbols.
 * This is a prerequisite check, not proof of execution readiness or provider entitlement. */
export function checkPriceAlignment(data: PriceObservation | undefined, broker: PriceObservation | undefined,
  expected: {root:Root;contract:string}, now:number, limits:AlignmentLimits) {
  const fail=(reason:string)=>({ok:false,reason,differenceTicks:null});
  if (!Number.isFinite(now) || ![limits.maxAgeMs,limits.maxSkewMs,limits.maxDifferenceTicks].every(n=>Number.isFinite(n)&&n>=0) || limits.maxAgeMs===0)
    return fail('Invalid alignment limits');
  if (!data || !broker) return fail('Waiting for both price sources');
  if (!new RegExp(`^${expected.root}[HMUZ]\\d{2,4}$`).test(expected.contract)) return fail('Dated contract required');
  for (const quote of [data,broker]) {
    if (quote.root!==expected.root || quote.contract!==expected.contract) return fail('Contract mismatch');
    if (![quote.price,quote.eventAt,quote.receivedAt].every(Number.isFinite) || quote.price<=0 || Math.abs(quote.price*4-Math.round(quote.price*4))>1e-6) return fail('Invalid price observation');
    if (quote.eventAt>now || quote.receivedAt>now || quote.eventAt>quote.receivedAt) return fail('Clock mismatch');
    if (now-quote.eventAt>limits.maxAgeMs || now-quote.receivedAt>limits.maxAgeMs) return fail('Stale price');
  }
  if (!['last','bid','ask'].includes(data.kind) || data.kind!==broker.kind) return fail('Price types differ');
  if (Math.abs(data.eventAt-broker.eventAt)>limits.maxSkewMs) return fail('Price timestamps differ');
  const differenceTicks=Math.abs(data.price-broker.price)/.25;
  return {ok:differenceTicks<=limits.maxDifferenceTicks,reason:differenceTicks<=limits.maxDifferenceTicks?'Aligned':'Price discrepancy',differenceTicks};
}
