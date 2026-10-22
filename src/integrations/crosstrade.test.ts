import {it,expect,vi} from 'vitest';
import {CrossTradeReadClient} from './crosstrade';
it('uses only direct Tradovate GET routes and rejects redirects',async()=>{
 const transport=vi.fn(async()=>new Response(JSON.stringify({success:true,accounts:[]})));
 const c=new CrossTradeReadClient('test-only',transport as typeof fetch);
 await c.status();await c.accounts();await c.snapshot();
 expect(transport.mock.calls.map(args=>(args as unknown[])[0])).toEqual(['status','accounts','accounts/snapshot'].map(p=>`https://app.crosstrade.io/v1/api/tv/${p}`));
 for(const call of transport.mock.calls) expect((call as unknown[])[1]).toMatchObject({method:'GET',redirect:'error',cache:'no-store'});
});
it('does not expose a provider error body or transport secret',async()=>{
 const c=new CrossTradeReadClient('secret',async()=>new Response('secret',{status:403}));
 await expect(c.accounts()).rejects.toThrow('HTTP 403');
 const d=new CrossTradeReadClient('secret',async()=>{throw new Error('secret');});
 await expect(d.accounts()).rejects.toThrow('Check connectivity');
});
it('rejects failed success envelopes',async()=>{
 const c=new CrossTradeReadClient('test-only',async()=>new Response('{"success":false}'));
 await expect(c.accounts()).rejects.toThrow('unverified');
});
