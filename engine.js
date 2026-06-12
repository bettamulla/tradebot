// ============================================================
// ENGINE.JS — The McAllen Strategy Engine
// Seven rules. Every candle passes through all of them.
// A signal only fires when every gate opens.
// ============================================================

// ---------- Indicator math ----------

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function emaSeries(values, period) {
  const out = [];
  const k = 2 / (period + 1);
  let e = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    } else if (i >= period) {
      e = values[i] * k + e * (1 - k);
    }
    out.push(e);
  }
  return out;
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function avgVolume(candles, period = 20) {
  if (candles.length < period) return null;
  return candles.slice(-period).reduce((a, c) => a + c.volume, 0) / period;
}

// ---------- Swing structure (support / resistance) ----------

function findSwings(candles, lookback = 3) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const win = candles.slice(i - lookback, i + lookback + 1);
    if (candles[i].high === Math.max(...win.map(c => c.high))) highs.push(candles[i].high);
    if (candles[i].low === Math.min(...win.map(c => c.low))) lows.push(candles[i].low);
  }
  return { highs: highs.slice(-5), lows: lows.slice(-5) };
}

// ---------- The Seven Rules ----------

/**
 * Evaluate one symbol. Returns a full reasoning trace —
 * every rule's verdict is recorded, pass or fail.
 *
 * @param {Object} params
 * @param {Array}  params.htf       Higher-timeframe candles (sets bias)
 * @param {Array}  params.ltf       Lower-timeframe candles (times entry)
 * @param {Object} params.newsCtx   Output of news.js — sentiment + calendar
 * @param {Object} params.config    Strategy toggles
 */
function evaluate({ htf, ltf, newsCtx, config = {} }) {
  const cfg = {
    emaFast: 20, emaMid: 50, emaSlow: 200,
    volMultiplier: 1.2,        // volume must exceed avg × this
    atrPeriod: 14,
    atrStopMult: 1.5,
    atrTargetMult: 2.5,        // reward:risk baked in
    rsiFilter: config.rsiFilter ?? true,
    rsiOverbought: 70, rsiOversold: 30,
    newsFilter: config.newsFilter ?? true,
    ...config,
  };

  const trace = [];           // every rule's reasoning, human-readable
  const fail = (rule, reason) => {
    trace.push({ rule, pass: false, reason });
    return { signal: null, trace };
  };
  const pass = (rule, reason) => trace.push({ rule, pass: true, reason });

  const ltfCloses = ltf.map(c => c.close);
  const htfCloses = htf.map(c => c.close);
  const price = ltfCloses[ltfCloses.length - 1];

  // ---- RULE 1: Environment — trending or ranging? ----
  const fastSeries = emaSeries(htfCloses, cfg.emaFast);
  const recent = fastSeries.slice(-10).filter(v => v !== null);
  if (recent.length < 10) return fail("R1 Environment", "Insufficient data");
  const slope = (recent[9] - recent[0]) / recent[0];
  const atrVal = atr(htf, cfg.atrPeriod);
  const slopeThreshold = (atrVal / price) * 0.5; // slope must be meaningful vs volatility
  if (Math.abs(slope) < slopeThreshold)
    return fail("R1 Environment", `Market ranging — EMA slope ${(slope * 100).toFixed(3)}% below threshold. Engine idles.`);
  pass("R1 Environment", `Trending. EMA20 slope ${(slope * 100).toFixed(3)}% over last 10 HTF bars.`);

  // ---- RULE 2: Trend alignment (Dow logic) ----
  const hFast = ema(htfCloses, cfg.emaFast);
  const hMid = ema(htfCloses, cfg.emaMid);
  const hSlow = ema(htfCloses, cfg.emaSlow);
  let bias = null;
  if (hFast > hMid && hMid > hSlow && price > hFast) bias = "LONG";
  else if (hFast < hMid && hMid < hSlow && price < hFast) bias = "SHORT";
  if (!bias) return fail("R2 Trend Alignment", "EMA stack not aligned on higher timeframe. No bias.");
  pass("R2 Trend Alignment", `HTF bias: ${bias}. EMA stack ${bias === "LONG" ? "20>50>200" : "20<50<200"} confirmed.`);

  // ---- RULE 3: Support / Resistance positioning ----
  const swings = findSwings(ltf);
  const atrLtf = atr(ltf, cfg.atrPeriod);
  if (!atrLtf) return fail("R3 S/R Zones", "Insufficient data for ATR.");
  let zone = null;
  if (bias === "LONG") {
    const nearestSupport = swings.lows.filter(l => l < price).sort((a, b) => b - a)[0];
    if (nearestSupport && (price - nearestSupport) < atrLtf * 1.5) zone = nearestSupport;
    if (!zone) return fail("R3 S/R Zones", "Price not near a support zone. No discounted entry available — chasing is prohibited.");
    pass("R3 S/R Zones", `Price within 1.5×ATR of support at ${zone.toFixed(2)}. Valid pullback entry zone.`);
  } else {
    const nearestResistance = swings.highs.filter(h => h > price).sort((a, b) => a - b)[0];
    if (nearestResistance && (nearestResistance - price) < atrLtf * 1.5) zone = nearestResistance;
    if (!zone) return fail("R3 S/R Zones", "Price not near a resistance zone. No premium entry available — chasing is prohibited.");
    pass("R3 S/R Zones", `Price within 1.5×ATR of resistance at ${zone.toFixed(2)}. Valid pullback entry zone.`);
  }

  // ---- RULE 4: Volume confirmation gate ----
  const lastVol = ltf[ltf.length - 1].volume;
  const avgVol = avgVolume(ltf);
  if (!avgVol || lastVol < avgVol * cfg.volMultiplier)
    return fail("R4 Volume Gate", `Volume ${lastVol} below ${cfg.volMultiplier}× average (${Math.round(avgVol)}). Move lacks participation — McAllen: price without volume is fragile.`);
  pass("R4 Volume Gate", `Volume ${lastVol} exceeds ${cfg.volMultiplier}× average. Real participation behind the move.`);

  // ---- RULE 5: Confirmation over anticipation ----
  const last = ltf[ltf.length - 1];
  const confirmed = bias === "LONG"
    ? last.close > last.open && last.close > ltf[ltf.length - 2].high
    : last.close < last.open && last.close < ltf[ltf.length - 2].low;
  if (!confirmed)
    return fail("R5 Confirmation", "No confirming close beyond prior bar's extreme. We do not front-run patterns.");
  pass("R5 Confirmation", `Confirming ${bias === "LONG" ? "bullish close above prior high" : "bearish close below prior low"}.`);

  // ---- RULE 6 (optional): Momentum filter ----
  if (cfg.rsiFilter) {
    const r = rsi(ltfCloses);
    if (bias === "LONG" && r > cfg.rsiOverbought)
      return fail("R6 Momentum", `RSI ${r.toFixed(1)} overbought — entering an exhausted move is prohibited.`);
    if (bias === "SHORT" && r < cfg.rsiOversold)
      return fail("R6 Momentum", `RSI ${r.toFixed(1)} oversold — entering an exhausted move is prohibited.`);
    pass("R6 Momentum", `RSI ${r.toFixed(1)} — room to run.`);
  } else {
    pass("R6 Momentum", "Filter disabled by config.");
  }

  // ---- RULE 7: Fundamental overlay (the news brain) ----
  if (cfg.newsFilter && newsCtx) {
    if (newsCtx.eventLockout)
      return fail("R7 Fundamental", `High-impact event window: ${newsCtx.eventLockout}. Trading suppressed.`);
    if (newsCtx.sentiment) {
      const s = newsCtx.sentiment; // { score: -1..1, label, headline_summary }
      if (bias === "LONG" && s.score < -0.3)
        return fail("R7 Fundamental", `Macro sentiment bearish (${s.score.toFixed(2)}): "${s.summary}". Long signal contradicts the news environment.`);
      if (bias === "SHORT" && s.score > 0.3)
        return fail("R7 Fundamental", `Macro sentiment bullish (${s.score.toFixed(2)}): "${s.summary}". Short signal contradicts the news environment.`);
      pass("R7 Fundamental", `Sentiment ${s.score.toFixed(2)} (${s.label}) aligns with ${bias} bias. "${s.summary}"`);
    } else {
      pass("R7 Fundamental", "No sentiment data — proceeding on technicals alone (degraded mode).");
    }
  } else {
    pass("R7 Fundamental", "News filter disabled by config.");
  }

  // ---- ALL GATES OPEN: construct the signal ----
  const stopDistance = atrLtf * cfg.atrStopMult;
  const targetDistance = atrLtf * cfg.atrTargetMult;
  const signal = {
    direction: bias,
    entry: price,
    stop: bias === "LONG" ? price - stopDistance : price + stopDistance,
    target: bias === "LONG" ? price + targetDistance : price - targetDistance,
    atr: atrLtf,
    riskReward: (cfg.atrTargetMult / cfg.atrStopMult).toFixed(2),
    timestamp: new Date().toISOString(),
  };
  trace.push({ rule: "SIGNAL", pass: true, reason: `${bias} @ ${price.toFixed(2)} | stop ${signal.stop.toFixed(2)} | target ${signal.target.toFixed(2)} | R:R ${signal.riskReward}` });

  return { signal, trace };
}

module.exports = { evaluate, ema, atr, rsi, avgVolume, findSwings };
