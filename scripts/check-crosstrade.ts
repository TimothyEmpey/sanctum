import {CrossTradeReadClient} from '../src/integrations/crosstrade';
async function main() {
 const token=process.env.CROSSTRADE_API_TOKEN;
 if(!token) throw new Error('Set CROSSTRADE_API_TOKEN in your local environment; do not paste it into chat.');
 const client=new CrossTradeReadClient(token);
 await client.status();await client.accounts();
 console.log('CrossTrade status and account-list reads succeeded. No orders sent. Account environment, eligibility and price alignment are NOT yet verified.');
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Connection check failed');process.exitCode=1;});
