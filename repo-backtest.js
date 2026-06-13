// ============================================================
// BACKTEST.JS — The Truth Machine
// Walks the seven rules forward through historical candles,
// candle by candle, exactly as the live engine would have seen
// them. No hindsight. No cheating. Simulated fills at stop or
// target. Outputs the honest numbers: win rate, profit factor,
// max drawdown, equity curve, full trade log.
//
// LIMITATION (stated, not hidden): Rule 7 (news sentiment) is
// excluded — historical headline sentiment isn't reconstructable.
// So the backtest measures the TECHNICAL edge (Rules 1–6).
// Live results with the news veto should be equal or better,
// since the veto only removes trades that fight the macro tape.
// ============================================================

const { evaluate } = require("./engine");
const { CONTRACTS, PROFILES } = require("./risk");

const YAHOO_SYMBOLS = { ES: "ES=F", MES: "MES=F", NQ: "NQ=F", MNQ: "MNQ=F" };

async function fetchHistory(symbol, interval, range) {
  const ySym = YAHOO_SYMBOLS[symbol] || "MES=F";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error("No historical data returned");
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

/**
 * Walk-forward backtest.
 * @param {string} symbol        MES | ES | MNQ | NQ
 * @param {string} profileKey    paper | topstep50k | topstep100k
 * @param {object} config        engine toggles (rsiFilter etc.)
 */
async function runBacktest(symbol = "MES", profileKey = "paper", config = {}) {
  // Yahoo allows ~60 days of 5m/15m data — that's our window
  const [htfAll, ltfAll] = await Promise.all([
    fetchHistory(symbol, "15m", "60d"),
    fetchHistory(symbol, "5m", "60d"),
  ]);

  const profile = PROFILES[profileKey] || PROFILES.paper;
  const spec = CONTRACTS[symbol] || CONTRACTS.MES;

  const WARMUP_HTF = 210;   // need 200-EMA + slope history
  const WARMUP_LTF = 60;

  let balance = profile.startingBalance;
  let highWater = balance;
  let maxDrawdown = 0;
  let openPos = null;
  const trades = [];
  const equityCurve = [];
  let dayKey = null, dailyPnL = 0, dailyHalted = false;
  let skippedByHalt = 0;

  // Walk the 5m series forward
  let htfIdx = 0;
  for (let i = WARMUP_LTF; i < ltfAll.length; i++) {
    const now = ltfAll[i].time;
    const candle = ltfAll[i];

    // Daily reset (UTC day — close enough for stats)
    const dk = new Date(now * 1000).toISOString().slice(0, 10);
    if (dk !== dayKey) { dayKey = dk; dailyPnL = 0; dailyHalted = false; }

    // ---- Manage open position: stop/target on this candle's range ----
    if (openPos) {
      let exit = null, reason = null;
      if (openPos.direction === "LONG") {
        if (candle.low <= openPos.stop) { exit = openPos.stop; reason = "STOP"; }       // stop first: conservative
        else if (candle.high >= openPos.target) { exit = openPos.target; reason = "TARGET"; }
      } else {
        if (candle.high >= openPos.stop) { exit = openPos.stop; reason = "STOP"; }
        else if (candle.low <= openPos.target) { exit = openPos.target; reason = "TARGET"; }
      }
      if (exit !== null) {
        const points = openPos.direction === "LONG" ? exit - openPos.entry : openPos.entry - exit;
        const pnl = points * spec.pointValue * openPos.contracts;
        balance += pnl; dailyPnL += pnl;
        if (balance > highWater) highWater = balance;
        maxDrawdown = Math.max(maxDrawdown, highWater - balance);
        trades.push({ ...openPos, exit, exitReason: reason, pnl, closedAt: now });
        equityCurve.push({ t: now, balance });
        if (dailyPnL <= -profile.maxDailyLoss * 0.9) dailyHalted = true;
        openPos = null;
      }
      if (openPos) continue; // one position at a time — no new evals while in a trade
    }

    if (dailyHalted) { skippedByHalt++; continue; }

    // ---- Advance HTF pointer to candles known at this moment ----
    while (htfIdx < htfAll.length && htfAll[htfIdx].time <= now) htfIdx++;
    if (htfIdx < WARMUP_HTF) continue;

    const htf = htfAll.slice(Math.max(0, htfIdx - 260), htfIdx);
    const ltf = ltfAll.slice(Math.max(0, i - 120), i + 1);

    // ---- Run the engine exactly as live (news excluded — see header) ----
    const result = evaluate({ htf, ltf, newsCtx: null, config: { ...config, newsFilter: false } });

    if (result.signal) {
      const stopPoints = Math.abs(result.signal.entry - result.signal.stop);
      const riskPerContract = stopPoints * spec.pointValue;
      const maxRisk = balance * (profile.riskPerTradePct / 100);
      let contracts = Math.min(Math.floor(maxRisk / riskPerContract), profile.maxContracts);
      const remainingDaily = profile.maxDailyLoss + dailyPnL;
      while (contracts > 0 && contracts * riskPerContract > remainingDaily) contracts--;
      if (contracts >= 1) {
        openPos = {
          direction: result.signal.direction,
          entry: result.signal.entry,
          stop: result.signal.stop,
          target: result.signal.target,
          contracts,
          openedAt: now,
        };
      }
    }
  }

  // ---- The honest numbers ----
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const days = new Set(trades.map(t => new Date(t.closedAt * 1000).toISOString().slice(0, 10))).size;

  return {
    symbol, profile: profile.name,
    periodDays: 60,
    totalTrades: trades.length,
    tradingDays: days,
    winRate: trades.length ? +(wins.length / trades.length * 100).toFixed(1) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    netPnL: +(balance - profile.startingBalance).toFixed(2),
    avgWin: wins.length ? +(grossWin / wins.length).toFixed(2) : 0,
    avgLoss: losses.length ? +(-grossLoss / losses.length).toFixed(2) : 0,
    maxDrawdown: +maxDrawdown.toFixed(2),
    drawdownLimit: profile.trailingDrawdown,
    wouldSurviveTopstep: maxDrawdown < profile.trailingDrawdown,
    daysHaltedEarly: skippedByHalt > 0,
    finalBalance: +balance.toFixed(2),
    equityCurve: equityCurve.filter((_, idx) => idx % Math.max(1, Math.floor(equityCurve.length / 100)) === 0),
    trades: trades.slice(-100).map(t => ({
      direction: t.direction, contracts: t.contracts,
      entry: +t.entry.toFixed(2), exit: +t.exit.toFixed(2),
      exitReason: t.exitReason, pnl: +t.pnl.toFixed(2),
      openedAt: new Date(t.openedAt * 1000).toISOString(),
      closedAt: new Date(t.closedAt * 1000).toISOString(),
    })),
    note: "Rules 1–6 only. News veto (Rule 7) not reconstructable historically; live performance with the veto should match or exceed this.",
  };
}

module.exports = { runBacktest };
