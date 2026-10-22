import {it,expect} from 'vitest';
import {checkPriceAlignment,type PriceObservation} from './price-alignment';
const q:PriceObservation={root:'NQ',contract:'NQZ26',kind:'last',price:20000,eventAt:1000,receivedAt:1010};
const limits={maxAgeMs:500,maxSkewMs:100,maxDifferenceTicks:1};
const check=(a:PriceObservation|undefined,b:PriceObservation|undefined)=>checkPriceAlignment(a,b,{root:'NQ',contract:'NQZ26'},1100,limits);
it('requires an independent comparable broker observation',()=>{expect(check(q,undefined).ok).toBe(false);expect(check(q,{...q,kind:'bid'}).ok).toBe(false);});
it('blocks different expiries, stale data, clock skew and off-tick prices',()=>{
 for(const change of [{contract:'NQH27'},{eventAt:1},{eventAt:1101},{eventAt:800},{price:20000.1}]) expect(check(q,{...q,...change}).ok).toBe(false);
});
it('measures like-for-like deviation in futures ticks',()=>{
 expect(check(q,{...q,price:20000.25})).toMatchObject({ok:true,differenceTicks:1});
 expect(check(q,{...q,price:20000.5})).toMatchObject({ok:false,differenceTicks:2});
});
