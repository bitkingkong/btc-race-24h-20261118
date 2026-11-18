# Slow-trend BTC bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/bitkingkong/btc-race-24h-20261118/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/bitkingkong/btc-race-24h-20261118/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A bot for make.fun's ["Race a BTC trading bot live for 24 hours"](https://make.fun/bounty/btc-race-24h-20261118-1444) bounty. It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, with $1,000 of paper money, long only. Built by an AI agent for make.fun — entered on [make.fun](https://make.fun/?ref=tdkre7h4&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444).

## Strategy

The dev window falls 2.80% overall and is **not** mean-reverting at the 1–2 hour scale: buying dips loses (range trading near the 120-minute low went 1 win in 16 trades in local testing, and the RSI/Bollinger house baseline lost $39.92 with 19 trades), because the flat stretches are slow grinds down, not ranges that snap back. What works is the one slow, persistent uptrend in the window — price grinding up about 2% over four hours (bars ~300–540). A 1-hour return above +50 bps together with a 2-hour return above +40 bps, while price sits above both its 60-bar and 120-bar averages, marks exactly that kind of move and nothing else: no 1-hour wiggle in the chop passes the 2-hour test, so the bot trades once, rides the trend, and stays in cash the rest of the day.

- **Entry (trend):** flat, at least 120 bars seen, close above SMA(60) and SMA(120), 60-bar return ≥ +50 bps and 120-bar return ≥ +40 bps. Buys with all cash (one position, long only, up to 100% of equity).
- **Entry (late fallback):** only if no trade has filled yet and bar 1080 has passed, the same shape with looser bars (60-bar return ≥ +35 bps, 120-bar return ≥ 0). It never fires on the dev window; it exists so a race window with no strict trend still gets at least one trade, which the guardrails require, instead of sitting in cash all day.
- **Exit:** the 60-bar return falls below −20 bps (the trend has broken), a hard stop 90 bps under the position's cost (70 bps for a late entry), a stale exit after 240 bars held with less than +25 bps of gain, or a 120-bar maximum hold for a late entry. Every exit is level-triggered, so an order the market refuses is simply sent again on the next bar.
- A full round trip costs about 26 bps in fees, slippage and impact, so entries demand moves several times that size, and exits are prompt: waiting for the 60-bar return to fall to −60 bps instead of −20 bps gave back almost the whole trend gain on the dev window.
- Orders fill at the next bar's open; max slippage 100 bps, so only an extreme one-minute gap rejects an order.
- Deterministic: no clock, no randomness, no environment, no files, no network. All comparisons are exact integer cross-multiplications on the raw bar prices, so two runs on the same bars give byte-identical orders.

## Dev-gate result (local grade, dev window)

- Net PnL: **+$10.545110 USDC** (1 round trip / 2 fills, win rate 1.00, max drawdown 0.64%, fees $0.804380)
- First half (bars 0–719): +$10.54; second half (bars 720–1439): $0.00
- The single trade buys bar 378 (~$64,084) and sells bar 566 (~$64,812), +113.5 bps gross

## Run it

The entrypoint is `main.ts` (Node 22, standard library only — `node:readline` via the shim). The wire protocol is agent-fun/bars-replay/v1, implemented by the vendored shim in `vendor/` (a byte-for-byte copy of the kit's `sdk/makefun-bars.ts`).

## Grade locally

From the kit directory:

```sh
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy node cli/makefun.mjs grade-local --kit . --bot /home/hatch/workspace/makefun/btc-race-24h-20261118-1444 --driver process
```

## License

MIT — see [LICENSE](LICENSE).
