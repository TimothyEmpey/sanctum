/** Read-only direct Tradovate client. No NT8 routes or trading methods are exposed. */
export class CrossTradeReadClient {
  constructor(private readonly token: string, private readonly transport: typeof fetch = fetch) {
    if (!token.trim() || /[\r\n]/.test(token)) throw new Error('A valid CrossTrade bearer token is required.');
  }
  private async get(resource: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(`https://app.crosstrade.io/v1/api/tv/${resource}`, {
        method: 'GET', headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new Error('CrossTrade read failed. Check connectivity; no orders were submitted.'); }
    // Do not echo provider response bodies: they may include account details or credentials.
    if (!response.ok) throw new Error(`CrossTrade read returned HTTP ${response.status}.`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || (body as {success?:unknown}).success !== true)
      throw new Error('CrossTrade returned an unverified response.');
    return body;
  }
  status() { return this.get('status'); }
  accounts() { return this.get('accounts'); }
  snapshot() { return this.get('accounts/snapshot'); }
}
