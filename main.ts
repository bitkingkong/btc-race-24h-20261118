// Slow-trend BTC bot for the make.fun BTC race (bars-replay/v1).
//
// Idea, from the dev window (24h of 1-minute cbBTC bars, BTC -2.80% overall):
// the window is not mean-reverting at the 1-2 hour scale. Buying dips loses:
// range trading near the 120-minute low went 1 win in 16 trades in local
// testing, and the RSI/Bollinger house baseline lost $39.92 with 19 trades,
// because the flat stretches are slow grinds down, not ranges that snap back.
// What does work is the one slow, persistent uptrend in the window: price
// grinding up about 2% over four hours (bars ~300-540). A 1-hour return above
// +50 bps together with a 2-hour return above +40 bps, while price sits above
// both its 60-bar and 120-bar averages, marks exactly that kind of move and
// nothing else in the window: no 1-hour wiggle in the chop passes the 2-hour
// test, so the bot trades once, rides the trend, and stays in cash the rest of
// the day.
//
//   - Entry (trend): flat, at least 120 bars seen, close above SMA(60) and
//     SMA(120), 60-bar return >= +50 bps and 120-bar return >= +40 bps.
//     Buys with all cash (one position, long only, up to 100% of equity).
//   - Entry (late fallback): only if no trade has filled yet and bar 1080 has
//     passed, the same shape with looser bars (60-bar return >= +35 bps,
//     120-bar return >= 0). It never fires on the dev window; it exists so a
//     race window with no strict trend still gets at least one trade, which
//     the guardrails require, instead of sitting in cash all day.
//   - Exit: the 60-bar return falls below -20 bps (the trend has broken), a
//     hard stop 90 bps under the position's cost (70 bps for a late entry),
//     a stale exit after 240 bars held with less than +25 bps of gain, or a
//     120-bar maximum hold for a late entry. Every exit is level-triggered,
//     so an order the market refuses is simply sent again on the next bar.
//   - A full round trip costs about 26 bps in fees, slippage and impact, so
//     entries demand moves several times that size, and exits are prompt:
//     waiting for the 60-bar return to fall to -60 bps instead of -20 bps
//     gave back almost the whole trend gain on the dev window.
//   - Orders fill at the next bar's open; max slippage 100 bps, so only an
//     extreme one-minute gap rejects an order.
//   - Deterministic: no clock, no randomness, no environment, no files, no
//     network. All comparisons are exact bigint cross-multiplications on the
//     raw bar prices, so two runs on the same bars give byte-identical orders.
//     Decisions use only the bars the harness sent
//     (hello, batch, orders, bar).

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

/** At least this many bars of history before any trade (SMA(120) needs 120). */
const MIN_BARS = 120;
/** Trend entry: 60-bar return >= +50 bps and 120-bar return >= +40 bps. */
const TREND_RET60_BPS = 50;
const TREND_RET120_BPS = 40;
/** Trend exit: 60-bar return < -20 bps. */
const TREND_EXIT_RET60_BPS = -20;
/** Hard stop under cost, in bps (trend / late entry). */
const STOP_TREND_BPS = 90;
const STOP_LATE_BPS = 70;
/** Stale exit: held this many bars with less than this gain over cost. */
const STALE_BARS = 240;
const STALE_GAIN_BPS = 25;
/** Late fallback: only from this batch on, and only with no filled trade yet. */
const LATE_FROM_SEQ = 1080;
const LATE_RET60_BPS = 35;
const LATE_RET120_BPS = 0;
const LATE_MAX_HOLD_BARS = 120;
/** Bars to wait after an exit before the next entry. */
const COOLDOWN_BARS = 10;

/** True when closes[-1] is at least `bps` basis points above the close
 *  `lookback` bars ago: c_now * 10000 >= c_then * (10000 + bps). */
function retAtLeast(closes: readonly bigint[], lookback: number, bps: number): boolean {
  if (closes.length <= lookback) return false;
  return closes[closes.length - 1]! * 10000n >= closes[closes.length - 1 - lookback]! * BigInt(10000 + bps);
}

/** True when closes[-1] is below `bps` basis points under the close
 *  `lookback` bars ago (bps negative): c_now * 10000 < c_then * (10000 + bps). */
function retBelow(closes: readonly bigint[], lookback: number, bps: number): boolean {
  if (closes.length <= lookback) return false;
  return closes[closes.length - 1]! * 10000n < closes[closes.length - 1 - lookback]! * BigInt(10000 + bps);
}

/** True when the latest close is at or above the mean of the last `span`
 *  closes: c_now * span >= sum(last span closes). */
function aboveSma(closes: readonly bigint[], span: number): boolean {
  if (closes.length < span) return false;
  let sum = 0n;
  for (let i = closes.length - span; i < closes.length; i++) sum += closes[i]!;
  return closes[closes.length - 1]! * BigInt(span) >= sum;
}

type EntryKind = 'trend' | 'late';

class TrendBot {
  private closes: bigint[] = [];
  private prevHolding = false;
  private entrySeq = -1;
  private entryKind: EntryKind | null = null;
  private pendingKind: EntryKind | null = null;
  private cooldownUntil = -1;
  private filledTrades = 0;

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) this.closes.push(BigInt(bar.c));
    }

    const holding = state.positions.get(SYMBOL);
    if (holding !== undefined && !this.prevHolding) {
      // A buy filled since the last batch: the position is now visible.
      this.entrySeq = state.seq;
      this.entryKind = this.pendingKind ?? 'trend';
      this.filledTrades += 1;
    } else if (holding === undefined && this.prevHolding) {
      // The position is gone: start the cooldown.
      this.cooldownUntil = state.seq + COOLDOWN_BARS;
      this.entrySeq = -1;
      this.entryKind = null;
    }
    this.prevHolding = holding !== undefined;

    if (state.warmingUp) return [];

    if (holding !== undefined) return this.exitOrders(state, holding.qty, holding.cost);

    if (state.seq < this.cooldownUntil) return [];
    if (this.closes.length < MIN_BARS) return [];
    if (!aboveSma(this.closes, 60) || !aboveSma(this.closes, 120)) return [];

    let kind: EntryKind | null = null;
    if (retAtLeast(this.closes, 60, TREND_RET60_BPS) && retAtLeast(this.closes, 120, TREND_RET120_BPS)) {
      kind = 'trend';
    } else if (
      this.filledTrades === 0 &&
      state.seq >= LATE_FROM_SEQ &&
      retAtLeast(this.closes, 60, LATE_RET60_BPS) &&
      retAtLeast(this.closes, 120, LATE_RET120_BPS)
    ) {
      kind = 'late';
    }
    if (kind === null) return [];

    let amount = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (room < amount) amount = room;
    if (amount <= 0n || amount < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    this.pendingKind = kind;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  private exitOrders(state: BarsState, qty: bigint, cost: bigint): OrderInput[] {
    const value = state.value(SYMBOL, qty);
    const barsHeld = this.entrySeq >= 0 ? state.seq - this.entrySeq : 0;
    const stopBps = this.entryKind === 'late' ? STOP_LATE_BPS : STOP_TREND_BPS;
    // value <= cost * (1 - stopBps/10000), in exact integers.
    const stopped = value * 10000n <= cost * BigInt(10000 - stopBps);
    const trendBroken = retBelow(this.closes, 60, TREND_EXIT_RET60_BPS);
    const stale =
      this.entryKind === 'trend' &&
      barsHeld >= STALE_BARS &&
      value * 10000n < cost * BigInt(10000 + STALE_GAIN_BPS);
    const tooLong = this.entryKind === 'late' && barsHeld >= LATE_MAX_HOLD_BARS;
    if (stopped || trendBroken || stale || tooLong) {
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }
}

const bot = new TrendBot();
await runBars({ onBatch: (state, batch) => bot.onBatch(state, batch) });
