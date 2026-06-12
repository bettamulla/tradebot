// ============================================================
// RISK.JS — The Risk Brain + Paper Broker
// This component has veto power over the engine. Always.
// Top Step rules hardcoded as an unbreachable ceiling.
// Paper broker simulates fills so the whole system runs
// risk-free from your phone before a penny is exposed.
// ============================================================

// ---------- Account profiles ----------
// Adjust to your evaluation tier. Defaults: Topstep 50K Combine.

const PROFILES = {
  topstep50k: {
    name: "Topstep $50K",
    startingBalance: 50000,
    maxDailyLoss: 1000,        // hard stop for the day
    trailingDrawdown: 2000,    // trails from high-water mark
    maxContracts: 5,
    riskPerTradePct: 0.5,      // % of balance risked per trade
  },
  topstep100k: {
    name: "Topstep $100K",
    startingBalance: 100000,
    maxDailyLoss: 2000,
    trailingDrawdown: 3000,
    maxContracts: 10,
    riskPerTradePct: 0.5,
  },
  paper: {
    name: "Paper Account",
    startingBalance: 50000,
    maxDailyLoss: 1000,
    trailingDrawdown: 2000,
    maxContracts: 5,
    riskPerTradePct: 0.5,
  },
};

// Futures contract specs (per point values)
const CONTRACTS = {
  ES:  { pointValue: 50,  tickSize: 0.25, name: "E-mini S&P 500" },
  MES: { pointValue: 5,   tickSize: 0.25, name: "Micro E-mini S&P 500" },
  NQ:  { pointValue: 20,  tickSize: 0.25, name: "E-mini Nasdaq" },
  MNQ: { pointValue: 2,   tickSize: 0.25, name: "Micro E-mini Nasdaq" },
};

// ---------- The Risk Brain ----------

class RiskBrain {
  constructor(profileKey = "paper") {
    this.profile = PROFILES[profileKey];
    this.balance = this.profile.startingBalance;
    this.highWaterMark = this.balance;
    this.dailyPnL = 0;
    this.dailyDate = this.todayKey();
    this.halted = false;
    this.haltReason = null;
  }

  todayKey() { return new Date().toISOString().slice(0, 10); }

  resetDailyIfNewDay() {
    const today = this.todayKey();
    if (today !== this.dailyDate) {
      this.dailyDate = today;
      this.dailyPnL = 0;
      this.halted = false;
      this.haltReason = null;
    }
  }

  /** Position sizing from ATR stop distance. Returns contracts or 0. */
  sizePosition(signal, symbol = "MES") {
    this.resetDailyIfNewDay();
    if (this.halted) return { contracts: 0, veto: this.haltReason };

    const spec = CONTRACTS[symbol];
    const stopPoints = Math.abs(signal.entry - signal.stop);
    const riskPerContract = stopPoints * spec.pointValue;
    const maxRisk = this.balance * (this.profile.riskPerTradePct / 100);

    // Veto 1: would this trade alone breach the daily loss limit?
    const remainingDaily = this.profile.maxDailyLoss + this.dailyPnL; // dailyPnL negative when losing
    if (riskPerContract > remainingDaily) {
      return { contracts: 0, veto: `One contract risks $${riskPerContract.toFixed(0)} but only $${remainingDaily.toFixed(0)} of daily loss budget remains.` };
    }

    let contracts = Math.floor(maxRisk / riskPerContract);
    contracts = Math.min(contracts, this.profile.maxContracts);

    // Cap so total risk never exceeds remaining daily budget
    while (contracts > 0 && contracts * riskPerContract > remainingDaily) contracts--;

    if (contracts < 1) return { contracts: 0, veto: "Stop distance too wide for risk budget. Trade skipped — correctly." };
    return { contracts, riskDollars: contracts * riskPerContract };
  }

  /** Record a closed trade's P&L and enforce halts. */
  recordPnL(pnl) {
    this.resetDailyIfNewDay();
    this.balance += pnl;
    this.dailyPnL += pnl;
    if (this.balance > this.highWaterMark) this.highWaterMark = this.balance;

    if (this.dailyPnL <= -this.profile.maxDailyLoss * 0.9) {
      this.halted = true;
      this.haltReason = `Daily P&L ${this.dailyPnL.toFixed(0)} hit 90% of max daily loss. KILL SWITCH — done for the day.`;
    }
    if (this.highWaterMark - this.balance >= this.profile.trailingDrawdown * 0.9) {
      this.halted = true;
      this.haltReason = `Within 10% of trailing drawdown limit. KILL SWITCH — account preservation mode.`;
    }
  }

  status() {
    this.resetDailyIfNewDay();
    return {
      profile: this.profile.name,
      balance: this.balance,
      dailyPnL: this.dailyPnL,
      highWaterMark: this.highWaterMark,
      drawdownUsed: this.highWaterMark - this.balance,
      drawdownLimit: this.profile.trailingDrawdown,
      dailyLossLimit: this.profile.maxDailyLoss,
      halted: this.halted,
      haltReason: this.haltReason,
    };
  }
}

// ---------- The Paper Broker ----------
// Simulates fills against live price. Every trade logged with the
// full reasoning trace that produced it — so you can audit the
// machine's thinking on every position, win or lose.

class PaperBroker {
  constructor(riskBrain) {
    this.risk = riskBrain;
    this.openPositions = [];
    this.closedTrades = [];
    this.nextId = 1;
  }

  open(signal, symbol, contracts, trace) {
    const spec = CONTRACTS[symbol];
    const pos = {
      id: this.nextId++,
      symbol, contracts,
      direction: signal.direction,
      entry: signal.entry,
      stop: signal.stop,
      target: signal.target,
      pointValue: spec.pointValue,
      openedAt: new Date().toISOString(),
      trace, // the full seven-rule reasoning that justified this trade
    };
    this.openPositions.push(pos);
    return pos;
  }

  /** Call on every new price tick/candle. Closes positions on stop/target. */
  markToMarket(symbol, price) {
    const stillOpen = [];
    for (const pos of this.openPositions) {
      if (pos.symbol !== symbol) { stillOpen.push(pos); continue; }
      let exit = null, reason = null;
      if (pos.direction === "LONG") {
        if (price <= pos.stop) { exit = pos.stop; reason = "STOP"; }
        else if (price >= pos.target) { exit = pos.target; reason = "TARGET"; }
      } else {
        if (price >= pos.stop) { exit = pos.stop; reason = "STOP"; }
        else if (price <= pos.target) { exit = pos.target; reason = "TARGET"; }
      }
      if (exit !== null) {
        const points = pos.direction === "LONG" ? exit - pos.entry : pos.entry - exit;
        const pnl = points * pos.pointValue * pos.contracts;
        const closed = { ...pos, exit, exitReason: reason, pnl, closedAt: new Date().toISOString() };
        this.closedTrades.push(closed);
        this.risk.recordPnL(pnl);
      } else {
        stillOpen.push(pos);
      }
    }
    this.openPositions = stillOpen;
  }

  unrealized(symbol, price) {
    return this.openPositions
      .filter(p => p.symbol === symbol)
      .reduce((sum, p) => {
        const points = p.direction === "LONG" ? price - p.entry : p.entry - price;
        return sum + points * p.pointValue * p.contracts;
      }, 0);
  }

  summary() {
    const wins = this.closedTrades.filter(t => t.pnl > 0);
    return {
      open: this.openPositions,
      closed: this.closedTrades.slice(-50),
      totalTrades: this.closedTrades.length,
      winRate: this.closedTrades.length ? (wins.length / this.closedTrades.length * 100).toFixed(1) : null,
      totalPnL: this.closedTrades.reduce((a, t) => a + t.pnl, 0),
    };
  }
}

module.exports = { RiskBrain, PaperBroker, PROFILES, CONTRACTS };
