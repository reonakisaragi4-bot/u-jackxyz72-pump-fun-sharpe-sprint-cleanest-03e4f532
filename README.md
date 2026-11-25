# Pump.fun Sharpe Sprint — Clean-scalp paper bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reonakisaragi4-bot/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reonakisaragi4-bot/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the make.fun bounty
[Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).
Places go by hourly Sharpe ratio on a 6-hour pump.fun forward replay, so
this bot trades small, trades selectively, and never lets one coin hurt it.

## How it trades

`main.ts` is the entrypoint (Node 22, `node /bot/main.ts`); the strategy
lives in `strategy.ts` and the SDK shim is vendored byte for byte in
`vendor/makefun-bot.ts`. It is deterministic: no clock, no environment, no
unseeded randomness — every decision is a pure function of the batch stream.

- **Entry — one small buy per honest-looking fresh coin.** A coin qualifies
  in its first 8 slots after creation when the creator bought a real but not
  dominant amount (0.05–2.5 SOL), a handful of distinct wallets (1–4) bought
  before us, nobody sold much yet, the creator has not sold, the price has
  not already run away from its create price (run-up at most 40%), and the
  real SOL reserve is 0.3–30 SOL. Stake is 0.08 SOL, capped at 1% of the
  real reserve and at 2 SOL of total exposure, at most 5 positions open.
- **Exits — tight and quick.** Take-profit +30% (with half sold at +12%
  first, the rest then stopped at breakeven), stop-loss −8%, a trailing stop
  that arms at +8% and exits on a 10% pullback from the best value, a 90-slot
  holding cap, and exits on a creator sell, a stale coin, or a sharp
  negative net flow. Losers are capped at a few percent of a small stake;
  the few runners are allowed to run under the trailing stop.
- **Guardrail pacing.** The 20-coin / round-trip guardrail is met by the
  entry rate itself on the dev window (103 qualifying round trips). A probe
  mechanism exists only as a late safety net: it fires only after 80% of
  the window has elapsed and only when the coin count lags the pace, because
  an immediate probe round trip loses its fees for certain (measured at
  ~0.0005 SOL each) and firing probes to chase fills bled every earlier
  version of this bot.

## Local verification

Measured with the kit's own tooling on the dev window (24 h, 128,058
events), `grade-local --driver process`:

- Net PnL **−0.124 SOL** (−1.24% on 10 SOL), 103 round trips over 103 coins,
  308 fills, win rate 13.6%, max drawdown **1.8%** — guardrails met.
- For comparison on the same window, the kit's pilot momentum bot lost
  9.44 SOL (drawdown 95%) and its pilot sniper lost 0.50 SOL (drawdown
  5.4%). This bot is the cleanest of the three, but it is still below
  holding cash on the dev window: the honest read is that its edge on the
  dev data is ~zero (gross trading PnL ≈ −0.007 SOL; the rest is fees), so
  the final 6-hour window — unseen data — is a coin flip around zero with
  very small stakes. The two action-log executions reproduce byte for byte.
- The local pilot simulator (kit `tools/sim.ts`, part-00000 slice only)
  reported +0.005 SOL on its ~11 h slice; the full-window grade-local
  above is the number to trust, and the slice result is not cited as the
  score.

## Files

- `main.ts` — entrypoint
- `strategy.ts` — the strategy (tunable `DEFAULT_PARAMS`)
- `vendor/makefun-bot.ts` — kit SDK shim, byte-identical to `sdk/ts/makefun-bot.ts`
- `LICENSE` — MIT
- `.makefun/owner.json` — ownership proof for @rkstore89 (no GitHub login linked)
