// ============================================================
// SERVER.JS — The Conductor
// Express backend. Pulls market data, runs the engine on a loop,
// routes everything through the risk brain, serves the dashboard API.
//
// PAPER MODE by default. No real money touches this until you
// deliberately wire a broker API in Phase 3.
//
// Deploy: Railway / Render / any Node host.
// Env vars:
//   GEMINI_API_KEY     — for news sentiment reasoning (aistudio.google.com)
//   NEWS_API_KEY       — newsapi.org (free tier fine)
//   SYMBOL             — MES | ES | MNQ | NQ   (default MES)
//   PROFILE            — paper | topstep50k | topstep100k
// ============================================================

const express = require("express");
const cors = require("cors");
const { evaluate } = require("./engine");
const { getNewsContext } = require("./news");
const { RiskBrain, PaperBroker } = require("./risk");

const app = express();
app.use(cors());
app.use(express.json());

const SYMBOL = process.env.SYMBOL || "MES";
const PROFILE = process.env.PROFILE || "paper";
const POLL_MS = 60 * 1000; // evaluate once per minute candle

const risk = new RiskBrain(PROFILE);
const broker = new PaperBroker(risk);

// Rolling state served to the dashboard
const state = {
  symbol: SYMBOL,
  mode: "PAPER",
  autoExecute: true,           // paper mode: fully hands-off
  lastEvaluation: null,        // full seven-rule trace, every cycle
  lastSignal: null,
  newsContext: null,
  price: null,
  config: { rsiFilter: true, newsFilter: true },
  log: [],                     // rolling event log
};

function log(msg) {
  state.log.unshift({ t: new Date().toISOString(), msg });
  state.log = state.log.slice(0, 200);
  console.log(msg);
}

// ---------- Market data ----------
// Starter pack uses Yahoo Finance futures quotes (free, ~delayed).
// Swap fetchCandles() for Polygon / Databento / Tradovate data
// when you want real-time. The interface stays identical.

const YAHOO_SYMBOLS = { ES: "ES=F", MES: "MES=F", NQ: "NQ=F", MNQ: "MNQ=F" };

async function fetchCandles(symbol, interval, range) {
  const ySym = YAHOO_SYMBOLS[symbol] || "MES=F";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error("No chart data");
  const q = r.indicators.quote[0];
  const candles = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null) continue;
    candles.push({
      time: r.timestamp[i],
      open: q.open[i], high: q.high[i], low: q.low[i],
      close: q.close[i], volume: q.volume[i] || 0,
    });
  }
  return candles;
}

// ---------- The evaluation loop ----------

let evaluating = false;

async function cycle() {
  if (evaluating) return;
  evaluating = true;
  try {
    // 1. Data: higher timeframe (15m) sets bias, lower (5m) times entry
    const [htf, ltf] = await Promise.all([
      fetchCandles(SYMBOL, "15m", "5d"),
      fetchCandles(SYMBOL, "5m", "1d"),
    ]);
    const price = ltf[ltf.length - 1].close;
    state.price = price;

    // 2. Mark open positions to market (stops/targets fill in paper)
    broker.markToMarket(SYMBOL, price);

    // 3. News brain
    state.newsContext = await getNewsContext(`${SYMBOL} futures`);

    // 4. Run the seven rules
    const result = evaluate({ htf, ltf, newsCtx: state.newsContext, config: state.config });
    state.lastEvaluation = { trace: result.trace, at: new Date().toISOString(), price };

    // 5. Signal? Route through the risk brain.
    if (result.signal && broker.openPositions.length === 0) {
      const sized = risk.sizePosition(result.signal, SYMBOL);
      if (sized.veto) {
        log(`SIGNAL VETOED by Risk Brain: ${sized.veto}`);
      } else if (state.autoExecute) {
        const pos = broker.open(result.signal, SYMBOL, sized.contracts, result.trace);
        state.lastSignal = { ...result.signal, contracts: sized.contracts, positionId: pos.id };
        log(`PAPER FILL: ${result.signal.direction} ${sized.contracts}x ${SYMBOL} @ ${result.signal.entry.toFixed(2)} | stop ${result.signal.stop.toFixed(2)} | target ${result.signal.target.toFixed(2)}`);
      } else {
        state.lastSignal = { ...result.signal, contracts: sized.contracts, pending: true };
        log(`SIGNAL PENDING CONFIRMATION: ${result.signal.direction} ${sized.contracts}x ${SYMBOL}`);
      }
    }
  } catch (e) {
    log(`Cycle error: ${e.message}`);
  } finally {
    evaluating = false;
  }
}

setInterval(cycle, POLL_MS);
cycle(); // run immediately on boot

// ---------- Dashboard API ----------

app.get("/api/state", (req, res) => {
  res.json({
    ...state,
    risk: risk.status(),
    trades: broker.summary(),
    unrealized: state.price ? broker.unrealized(SYMBOL, state.price) : 0,
  });
});

// Toggle strategy filters from the phone
app.post("/api/config", (req, res) => {
  const { rsiFilter, newsFilter, autoExecute } = req.body;
  if (rsiFilter !== undefined) state.config.rsiFilter = !!rsiFilter;
  if (newsFilter !== undefined) state.config.newsFilter = !!newsFilter;
  if (autoExecute !== undefined) state.autoExecute = !!autoExecute;
  log(`Config updated: ${JSON.stringify({ ...state.config, autoExecute: state.autoExecute })}`);
  res.json({ ok: true, config: state.config, autoExecute: state.autoExecute });
});

// Confirm a pending signal (evaluation mode: one-tap execute)
app.post("/api/confirm", (req, res) => {
  if (!state.lastSignal?.pending) return res.status(400).json({ error: "No pending signal" });
  const sig = state.lastSignal;
  const pos = broker.open(sig, SYMBOL, sig.contracts, state.lastEvaluation.trace);
  state.lastSignal = { ...sig, pending: false, positionId: pos.id };
  log(`CONFIRMED BY TRADER: ${sig.direction} ${sig.contracts}x ${SYMBOL}`);
  res.json({ ok: true, position: pos });
});

// Manual kill switch from the phone
app.post("/api/halt", (req, res) => {
  risk.halted = true;
  risk.haltReason = "Manual halt from dashboard.";
  log("MANUAL HALT engaged.");
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Trading system live on :${PORT} | ${SYMBOL} | ${PROFILE} | PAPER MODE`));
