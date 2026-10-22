"""Real CME minute-bar collector. No orders, fabricated bars, or silent rollover.
Requires databento Python SDK and DATABENTO_API_KEY. See docs/MFFU-CONNECTION.md.
"""
import argparse
import json
import math
import os
import re
import tempfile
import time
from pathlib import Path


class PairedBars:
    def __init__(self, contracts):
        self.contracts = contracts
        self.pending = {}
        self.frames = []
        self.last = -1

    def add(self, root, bar, now_ms):
        t = bar['time']
        values = [bar[k] for k in ('open', 'high', 'low', 'close', 'volume')]
        if (root not in ('NQ', 'ES') or t % 60000 or t + 60000 > now_ms
                or not math.isfinite(t) or not math.isfinite(now_ms)
                or not all(math.isfinite(v) for v in values)
                or bar['volume'] < 0 or bar['low'] <= 0
                or bar['low'] > min(bar['open'], bar['close'])
                or bar['high'] < max(bar['open'], bar['close'])
                or any(abs(bar[k]*4-round(bar[k]*4)) > 1e-6 for k in ('open','high','low','close'))):
            raise ValueError('Invalid, incomplete or off-tick exchange candle')
        if t + 60000 <= self.last:
            return False  # reconnect duplicates cannot append a second frame
        self.pending.setdefault(t, {})[root] = bar
        pair = self.pending[t]
        if len(pair) != 2:
            # Bounded memory if one subscription stops publishing. Never forward-fill.
            self.pending = {k:v for k,v in self.pending.items() if k >= t-86400000}
            return False
        self.frames.append({'time':t+60000, **pair})
        self.frames = self.frames[-10080:]
        self.last = t+60000
        self.pending = {k:v for k,v in self.pending.items() if k > t}
        return True

    def document(self):
        return {'provenance':'Databento GLBX.MDP3 ohlcv-1m; real exchange data',
                'contracts':self.contracts, 'frames':self.frames}


def write_atomic(target, value):
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=target.parent, prefix='.feed-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, target)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default='futures.config.json')
    parser.add_argument('--output', default='data/futures/feed.json')
    parser.add_argument('--nq-symbol', required=True, help='Exact provider raw contract symbol, verified against Tradovate')
    parser.add_argument('--es-symbol', required=True)
    args = parser.parse_args()
    if not os.environ.get('DATABENTO_API_KEY'):
        raise SystemExit('DATABENTO_API_KEY is missing. Keep the key in your local environment.')
    config = json.loads(Path(args.config).read_text())
    now = int(time.time()*1000)
    contracts = {}
    provider_symbols = {'NQ':args.nq_symbol, 'ES':args.es_symbol}
    for root in ('NQ','ES'):
        contract = config['contracts'][root]
        match = re.fullmatch(root+r'([HMUZ])(\d{2}|\d{4})', contract['id'])
        if not match or contract['expiresAt'] <= now:
            raise SystemExit('Configure verified, unexpired dated contracts first.')
        raw = re.fullmatch(root+r'([HMUZ])(\d{1,4})', provider_symbols[root])
        if not raw or raw[1] != match[1] or not match[2].endswith(raw[2]):
            raise SystemExit('Provider contract month/year differs from the configured contract.')
        contracts[root] = contract['id']
    # Import only after local validation. No subscription starts merely by importing this module.
    import databento as db
    collector = PairedBars(contracts)
    ids = {}
    client = db.Live(key=os.environ['DATABENTO_API_KEY'])
    client.subscribe(dataset='GLBX.MDP3', schema='ohlcv-1m', stype_in='raw_symbol',
                     symbols=list(provider_symbols.values()))
    try:
        for record in client:
            if any(c['expiresAt'] <= int(time.time()*1000) for c in config['contracts'].values()):
                raise RuntimeError('Configured contract expired; collection stopped.')
            if isinstance(record, db.SymbolMappingMsg):
                for root, symbol in provider_symbols.items():
                    if record.stype_in_symbol == symbol:
                        ids[record.instrument_id] = root
            elif isinstance(record, db.OHLCVMsg):
                root = ids.get(record.instrument_id)
                if root is None:
                    raise RuntimeError('Unmapped market-data instrument; collection stopped.')
                bar = {'time':record.ts_event//1_000_000,
                       **{k:getattr(record,k)/1_000_000_000 for k in ('open','high','low','close')},
                       'volume':record.volume}
                if collector.add(root, bar, int(time.time()*1000)):
                    write_atomic(Path(args.output), collector.document())
            elif isinstance(record, db.ErrorMsg):
                raise RuntimeError('Market-data provider reported an error; collection stopped.')
    finally:
        client.stop()


if __name__ == '__main__':
    main()
