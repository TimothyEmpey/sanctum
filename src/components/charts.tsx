"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { fiveMinuteCandles } from "@/lib/market/bars";
import { formatPx, formatUsd } from "@/lib/market/time";
import { aggregateEquity, type EquityRange } from "@/lib/portfolio/equity";

const ranges: EquityRange[] = ["hour", "day", "month", "year", "all"];

export function EquityChart({ points }: { points: { t: number; equityCents: number }[] }) {
  const [range, setRange] = useState<EquityRange>("day");
  const now = points.at(-1)?.t ?? Date.now();
  const data = useMemo(
    () => aggregateEquity(points, range, now).map((point) => ({
      t: point.t,
      label: new Date(point.t).toLocaleString("en-US", range === "hour" ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" }),
      equity: point.equityCents / 100,
    })),
    [points, range, now],
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        {ranges.map((item) => (
          <Button key={item} type="button" size="sm" variant={item === range ? "default" : "outline"} onClick={() => setRange(item)}>
            {item}
          </Button>
        ))}
      </div>
      <div className="h-64 md:h-80">
        {data.length < 2 ? (
          <p className="text-sm text-[var(--muted)]">Equity marks will appear after the worker records a session.</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <defs>
                <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#7c3aed" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#7c3aed" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.45} minTickGap={24} />
              <YAxis
                domain={[(min: number) => min * 0.995, (max: number) => max * 1.005]}
                tick={{ fontSize: 11 }}
                stroke="currentColor"
                opacity={0.45}
                width={72}
                tickFormatter={(value) => `$${Number(value).toFixed(0)}`}
              />
              <Tooltip formatter={(value) => formatUsd(Math.round(Number(value) * 100))} />
              <Area type="monotone" dataKey="equity" stroke="#7c3aed" fill="url(#equityFill)" strokeWidth={2} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

type Ohlc = { t: number; open: number; high: number; low: number; close: number; volume: number };
type CandleFrame = "1D" | "5m";

function formatVol(volume: number) {
  if (volume >= 1_000_000_000) return `${(volume / 1_000_000_000).toFixed(1)}B`;
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(1)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(0)}K`;
  return String(volume);
}

function candleLabel(t: number, frame: CandleFrame, sameDay: boolean) {
  return new Date(t).toLocaleString("en-US", frame === "1D" || !sameDay
    ? { month: "short", day: "numeric", timeZone: "America/New_York" }
    : { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

export function PriceChart({ symbol, daily, minute }: { symbol: string; daily: Ohlc[]; minute: Ohlc[] }) {
  const intraday = useMemo(() => fiveMinuteCandles(minute), [minute]);
  const [frame, setFrame] = useState<CandleFrame>(intraday.length >= 2 ? "5m" : "1D");
  const [hover, setHover] = useState<number | null>(null);
  const points = frame === "5m" ? intraday : daily;
  const active = hover == null ? points.at(-1) : points[hover];
  const prior = hover == null ? points.at(-2) : points[Math.max(0, hover - 1)];
  const change = active && prior && active !== prior ? active.close - prior.close : 0;
  const up = change >= 0;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex gap-2">
          {(["5m", "1D"] as const).map((item) => (
            <Button key={item} type="button" size="sm" variant={item === frame ? "default" : "outline"} onClick={() => { setFrame(item); setHover(null); }}>
              {item}
            </Button>
          ))}
        </div>
        {active ? (
          <p className="tabular w-full text-xs text-[var(--muted)] sm:w-auto">
            O {formatPx(active.open)} H {formatPx(active.high)} L {formatPx(active.low)} C {formatPx(active.close)}{" "}
            <span className={up ? "text-[var(--positive)]" : "text-[var(--negative)]"}>
              {change >= 0 ? "+" : ""}{change.toFixed(2)}
            </span>{" "}
            Vol {formatVol(active.volume)}
          </p>
        ) : null}
      </div>
      {points.length < 2 ? (
        <p className="text-sm text-[var(--muted)]">
          {frame === "5m"
            ? `Five-minute candles for ${symbol} print once that history is stored.`
            : `Daily candles for ${symbol} show up once that history is stored.`}
        </p>
      ) : (
        <CandleSvg symbol={symbol} points={points} frame={frame} hover={hover} onHover={setHover} />
      )}
    </div>
  );
}

function CandleSvg({
  symbol,
  points,
  frame,
  hover,
  onHover,
}: {
  symbol: string;
  points: Ohlc[];
  frame: CandleFrame;
  hover: number | null;
  onHover: (index: number | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const measure = () => setSize({ w: Math.round(node.clientWidth), h: Math.round(node.clientHeight) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => layoutCandles(points, size.w, size.h, frame), [points, size, frame]);

  return (
    <div ref={wrapRef} className="h-[300px] w-full min-w-0 overflow-hidden md:h-[380px]">
      {layout ? (
        <svg
          width={layout.width}
          height={layout.height}
          role="img"
          aria-label={`${symbol} candlestick chart`}
          className="touch-none"
          onPointerMove={(event) => onHover(layout.indexAt(event.clientX, event.currentTarget))}
          onPointerLeave={() => onHover(null)}
        >
          {layout.grid.map((row) => (
            <g key={row.price}>
              <line x1={layout.padL} x2={layout.plotRight} y1={row.y} y2={row.y} stroke="var(--border)" />
              {row.showLabel ? (
                <text x={layout.width - 4} y={row.y + 4} textAnchor="end" fill="var(--muted)" fontSize="11">
                  {row.price.toFixed(2)}
                </text>
              ) : null}
            </g>
          ))}
          <rect x={layout.padL} y={layout.volTop} width={layout.plotRight - layout.padL} height={layout.volH} fill="var(--border)" />
          <line x1={layout.padL} x2={layout.plotRight} y1={layout.lastY} y2={layout.lastY} stroke={layout.lastColor} strokeDasharray="4 3" />
          <text x={layout.width - 4} y={layout.lastY - 6} textAnchor="end" fill={layout.lastColor} fontSize="11" fontWeight="600">
            {layout.lastClose.toFixed(2)}
          </text>
          {layout.candles.map((candle) => (
            <g key={candle.t}>
              <line x1={candle.x} x2={candle.x} y1={candle.highY} y2={candle.lowY} stroke={candle.color} strokeWidth="1.25" />
              <rect x={candle.bodyX} y={candle.bodyY} width={candle.bodyW} height={candle.bodyH} fill={candle.color} />
              <rect x={candle.bodyX} y={candle.volY} width={candle.bodyW} height={candle.volH} fill={candle.color} opacity="0.85" />
            </g>
          ))}
          <line x1={layout.padL} x2={layout.plotRight} y1={layout.volTop} y2={layout.volTop} stroke="var(--border)" />
          {layout.labels.map((label) => (
            <text key={label.key} x={label.x} y={layout.height - 6} textAnchor="middle" fill="var(--muted)" fontSize="11">
              {label.text}
            </text>
          ))}
          {hover != null && layout.candles[hover] ? (
            <line
              x1={layout.candles[hover].x}
              x2={layout.candles[hover].x}
              y1={10}
              y2={layout.volTop + layout.volH}
              stroke="var(--muted)"
              strokeDasharray="3 3"
            />
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}

function layoutCandles(points: Ohlc[], width: number, height: number, frame: CandleFrame) {
  if (width < 280 || points.length < 2) return null;
  const padL = 8;
  const padR = 58;
  const padT = 16;
  const axisH = 22;
  const volH = Math.round(height * 0.18);
  const gap = 16;
  const volTop = height - axisH - volH;
  const priceBottom = volTop - gap;
  const priceH = priceBottom - padT;
  if (priceH < 80) return null;

  const low = Math.min(...points.map((point) => point.low));
  const high = Math.max(...points.map((point) => point.high));
  const pad = Math.max((high - low) * 0.08, 0.05);
  const yMin = low - pad;
  const yMax = high + pad;
  const yOf = (price: number) => padT + ((yMax - price) / (yMax - yMin)) * priceH;
  const plotW = width - padL - padR;
  const slot = plotW / points.length;
  const maxVol = Math.max(...points.map((point) => point.volume), 1);
  const last = points[points.length - 1];
  const lastY = yOf(last.close);
  const firstDay = new Date(points[0].t).toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const lastDay = new Date(last.t).toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const sameDay = firstDay === lastDay;
  const labelCount = Math.max(2, Math.min(points.length, Math.floor(plotW / (frame === "1D" || !sameDay ? 52 : 64))));

  const grid = Array.from({ length: 5 }, (_, index) => {
    const price = yMax - ((yMax - yMin) * index) / 4;
    const y = yOf(price);
    return { price, y, showLabel: Math.abs(y - lastY) > 14 };
  });

  const candles = points.map((point, index) => {
    const x = padL + index * slot + slot / 2;
    const rising = point.close >= point.open;
    const bodyTop = yOf(Math.max(point.open, point.close));
    const bodyBot = yOf(Math.min(point.open, point.close));
    const bodyW = Math.max(1.4, Math.min(slot * 0.64, 12));
    const barVol = Math.max(1, (point.volume / maxVol) * volH);
    return {
      t: point.t,
      x,
      highY: yOf(point.high),
      lowY: yOf(point.low),
      bodyX: x - bodyW / 2,
      bodyY: bodyTop,
      bodyW,
      bodyH: Math.max(1, bodyBot - bodyTop),
      volY: volTop + volH - barVol,
      volH: barVol,
      color: rising ? "var(--positive)" : "var(--negative)",
    };
  });

  const seen = new Set<number>();
  const labels = Array.from({ length: labelCount }, (_, index) => {
    const pointIndex = Math.round((index * (points.length - 1)) / Math.max(1, labelCount - 1));
    if (seen.has(pointIndex)) return null;
    seen.add(pointIndex);
    return {
      key: `${points[pointIndex].t}-${index}`,
      x: padL + pointIndex * slot + slot / 2,
      text: candleLabel(points[pointIndex].t, frame, sameDay),
    };
  }).filter((label) => label != null);

  return {
    width,
    height,
    padL,
    plotRight: width - padR,
    volTop,
    volH,
    lastY,
    lastClose: last.close,
    lastColor: last.close >= last.open ? "var(--positive)" : "var(--negative)",
    grid,
    candles,
    labels,
    indexAt(clientX: number, svg: SVGSVGElement) {
      const rect = svg.getBoundingClientRect();
      const x = clientX - rect.left - padL;
      if (x < 0 || x > plotW) return null;
      return Math.min(points.length - 1, Math.max(0, Math.floor(x / slot)));
    },
  };
}

export function PnlBars({ rows }: { rows: { label: string; pnl: number }[] }) {
  if (!rows.length) return <p className="text-sm text-[var(--muted)]">Closed trades will build this chart.</p>;
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows}>
          <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.45} />
          <YAxis tick={{ fontSize: 11 }} width={64} stroke="currentColor" opacity={0.45} />
          <Tooltip formatter={(value) => formatUsd(Math.round(Number(value) * 100))} />
          <Bar dataKey="pnl" fill="#7c3aed" radius={[6, 6, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
