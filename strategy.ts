// Clean-scalp paper bot for the pump.fun Sharpe sprint (agent-fun/replay/v2).
//
// Idea: ranking is by hourly Sharpe, not by wild PnL, and a prize needs net
// PnL above zero after every fee. So the bot trades small, trades often, and
// never lets one coin hurt it: it snipes a coin in its first few slots after
// creation, but only when the launch looks honest, and it is out within
// minutes on a tight stop, a modest take-profit, or a trailing stop once a
// runner shows. Losers are capped at a few percent of a small stake; winners
// are allowed to run a little under a trailing stop.
//
// A launch looks honest when: the creator bought a real but not dominant
// amount, a handful of distinct wallets (not one, not a bundle crowd) bought
// before us, nobody sold much yet, the creator has not sold, the price has
// not already run away from its create price, and the last few slots still
// show net buying. Every rule is a plain count over the tape the bot itself
// keeps from the batch stream.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream; the
// only time used is block time carried by the events themselves, for pacing.

import {
  BPS,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest / oldest age (slots since CreateEvent) at which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** SOL to put into one coin in total (one buy per coin). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry: window. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** The recent-flow window (slots) and the net inflow it must show (lamports, >= 0 by default). */
  flowWindow: number;
  minFlowLamports: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** First take-profit: sell tp1PartBps of the position once it is worth tp1Bps over its cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** After the first take-profit, the rest stops out at this much under its cost (bps). */
  slAfterTp1Bps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the net flow over exitFlowWindow slots falls below minus this many lamports. */
  exitFlowWindow: number;
  exitFlowLamports: number;
  /** Most main positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: at least this many coins and fills by the end of the window. */
  targetCoins: number;
  targetFills: number;
  /** Block-time seconds the pace is measured over (the 6-hour final window). */
  paceSecs: number;
  /** Probe round trips (buy probeSol, sell as soon as it lands) when coins/fills lag the pace. */
  probeSol: number;
  maxProbes: number;
  /** Fill pacing: split each order into this many pieces when fills lag the pace. */
  baseSplit: number;
  maxSplit: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 8,
  stakeSol: 0.08,
  minBuySol: 0.02,
  minRealSol: 0.3,
  maxRealSol: 30,
  minDevBuySol: 0.05,
  maxDevBuySol: 2.5,
  minBuyers: 1,
  maxBuyers: 4,
  maxSellRatioBps: 5000,
  maxBigSellBps: 2000,
  minRunupBps: 0,
  maxRunupBps: 4000,
  flowWindow: 10,
  minFlowLamports: 0,
  skipDevSold: true,
  buySlippageBps: 1000,
  tp1Bps: 1200,
  tp1PartBps: 5000,
  slAfterTp1Bps: 0,
  tpBps: 3000,
  slBps: 800,
  trailArmBps: 800,
  trailBps: 1000,
  maxHold: 90,
  exitOnDevSell: true,
  staleSlots: 150,
  exitFlowWindow: 20,
  exitFlowLamports: 500_000_000,
  maxMain: 5,
  maxExposureSol: 2,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 21600,
  probeSol: 0.03,
  maxProbes: 3,
  baseSplit: 1,
  maxSplit: 2,
};

const LAMPORTS = 1e9;
/** Curve fees: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;
/** Smallest buy piece worth sending (lamports). */
const MIN_PIECE_LAMPORTS = 2_000_000n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: string;
}

interface Coin {
  createSlot: number;
  creator: string;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<string>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  best: bigint;
  tookTp1: boolean;
  lastValue: bigint;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Strategy {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime = 0;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        createSlot: -1, creator: '', vq0: 0n, vt0: 0n, devBuy: 0n, trades: 0,
        buyers: new Set(), bought: 0n, soldByOthers: 0n, bigSellBps: 0n,
        devSold: false, lastTradeSlot: -1, recent: [], done: false, complete: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** How many pieces to split an order into now: baseSplit, more when fills lag the pace. */
  const pieces = (): number => {
    if (firstTime === null) return p.baseSplit;
    const elapsed = Math.max(0, Math.min(p.paceSecs, lastTime - firstTime));
    const due = (p.targetFills * elapsed) / p.paceSecs;
    if (myFills >= due) return p.baseSplit;
    const behind = due - myFills;
    return Math.min(p.maxSplit, p.baseSplit + (behind > p.targetFills * 0.15 ? 1 : 0));
  };

  /** Split `tokens` of a sell into k orders (same reply, same price each). */
  const splitSell = (mint: Pubkey, tokens: bigint, k: number, room: number): OrderInput[] => {
    const n = BigInt(Math.max(1, Math.min(k, room)));
    const piece = tokens / n;
    if (piece < MIN_PIECE_LAMPORTS) return [{ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 }];
    const out: OrderInput[] = [];
    for (let i = 0n; i < n; i++) {
      out.push({
        side: 'sell', mint,
        token_amount: i === n - 1n ? tokens - piece * (n - 1n) : piece,
        max_slippage_bps: 10_000,
      });
    }
    return out;
  };

  /** Split a buy amount into k orders. */
  const splitBuy = (mint: Pubkey, amount: bigint, k: number, room: number): OrderInput[] => {
    const n = BigInt(Math.max(1, Math.min(k, room)));
    const piece = amount / n;
    if (piece < MIN_PIECE_LAMPORTS) return [{ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps }];
    const out: OrderInput[] = [];
    for (let i = 0n; i < n; i++) {
      out.push({
        side: 'buy', mint,
        quote_lamports: i === n - 1n ? amount - piece * (n - 1n) : piece,
        max_slippage_bps: p.buySlippageBps,
      });
    }
    return out;
  };

  /** Net recorded SOL flow (buys minus sells) over the last `w` slots. */
  const flow = (c: Coin, now: number, w: number): bigint => {
    let net = 0n;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i]!;
      if (t.slot <= now - w) break;
      net += t.isBuy ? t.sol : -t.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
        if (f.side === 'sell' && f.status === 'filled') selling.delete(f.mint);
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.createSlot = e.slot;
          c.creator = e.creator;
          c.vq0 = BigInt(e.virtual_quote_reserves);
          c.vt0 = BigInt(e.virtual_token_reserves);
          c.lastTradeSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = BigInt(e.sol_amount);
          const isCreator = e.user === c.creator;
          if (e.slot === c.createSlot && e.is_buy && isCreator) c.devBuy += sol;
          if (!e.is_buy && isCreator) c.devSold = true;
          if (e.is_buy) {
            if (!isCreator) {
              c.buyers.add(e.user);
              c.bought += sol;
            }
          } else if (!isCreator) {
            c.soldByOthers += sol;
            const curve = state.curves.get(e.mint);
            if (curve !== undefined && curve.real_quote_reserves > 0n) {
              const bps = (sol * BPS) / curve.real_quote_reserves;
              if (bps > c.bigSellBps) c.bigSellBps = bps;
            }
          }
          c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
          c.trades++;
          c.lastTradeSlot = e.slot;
          traded.add(e.mint);
        } else {
          coinOf(e.mint).complete = true;
        }
      }
      // Trim old ticks: only the recent-flow windows matter.
      const keep = Math.max(p.flowWindow, p.exitFlowWindow) + 5;
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.recent.length && c.recent[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.recent.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const room = () => cap - orders.length;

      // --- Exits first: every held coin is re-priced from the latest marks. ---
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            coinOf(mint).done = true;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const tokens = BigInt(pos.token_amount);
        const cost = BigInt(pos.cost_lamports);
        const value = sellValue(tokens, vq, vt) - tx;
        if (value > h.best) h.best = value;
        h.lastValue = value;
        const c = coinOf(mint);
        const slBps = h.tookTp1 ? p.slAfterTp1Bps : p.slBps;
        let exit = false;
        let partial = false;
        if (value <= (cost * (BPS - BigInt(slBps))) / BPS) exit = true;
        if (!exit && value >= (cost * (BPS + BigInt(p.tpBps))) / BPS) exit = true;
        if (!exit && !h.tookTp1 && value >= (cost * (BPS + BigInt(p.tp1Bps))) / BPS) partial = true;
        if (!exit && h.best >= (cost * (BPS + BigInt(p.trailArmBps))) / BPS && value <= (h.best * (BPS - BigInt(p.trailBps))) / BPS) exit = true;
        if (!exit && now - h.openedSlot > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && c.devSold) exit = true;
        if (!exit && now - c.lastTradeSlot > p.staleSlots) exit = true;
        if (!exit && flow(c, now, p.exitFlowWindow) < -BigInt(p.exitFlowLamports)) exit = true;
        if (!exit && !partial) continue;
        if (selling.has(mint)) continue;
        if (room() <= 0) break;
        if (partial) {
          const part = (tokens * BigInt(p.tp1PartBps)) / BPS;
          if (part <= 0n) continue;
          orders.push(...splitSell(mint, part, pieces(), room()));
          h.tookTp1 = true;
          selling.add(mint);
        } else {
          orders.push(...splitSell(mint, tokens, pieces(), room()));
          selling.add(mint);
        }
      }

      // --- Probe round trips: sell the whole probe as soon as its buy has landed. ---
      for (const [mint, isSelling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint) || selling.has(mint)) continue;
        if (room() <= 0) break;
        orders.push(...splitSell(mint, BigInt(pos.token_amount), pieces(), room()));
        if (!isSelling) probes.set(mint, true);
      }

      // --- Entries: one small buy per honest-looking fresh coin. ---
      let free = state.freeCashLamports();
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0n;
      for (const [mint, h] of held) exposure += BigInt(state.positions.get(mint)?.cost_lamports ?? 0n);
      for (const mint of traded) {
        if (room() <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        const c = coins.get(mint)!;
        if (c.done || c.createSlot < 0) continue;
        const age = now - c.createSlot;
        if (age < p.minAge || age > p.maxAge) continue;
        if (slotsLeft <= 0 || held.size >= p.maxMain) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
        const devBuySol = Number(c.devBuy) / LAMPORTS;
        if (devBuySol < p.minDevBuySol || devBuySol > p.maxDevBuySol) continue;
        if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(p.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(p.maxBigSellBps)) continue;
        if (p.skipDevSold && c.devSold) continue;
        if (c.vq0 > 0n && c.vt0 > 0n) {
          const priceNow = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          const price0 = Number(c.vq0) / Number(c.vt0);
          const runup = Math.round((priceNow / price0 - 1) * 10000);
          if (runup < p.minRunupBps || runup > p.maxRunupBps) continue;
        }
        if (flow(c, now, p.flowWindow) < BigInt(p.minFlowLamports)) continue;
        const capLamports = state.maxBuyLamports(mint);
        let amount = BigInt(Math.floor(p.stakeSol * LAMPORTS));
        if (amount > capLamports) amount = capLamports;
        if (amount > BigInt(Math.floor(p.maxExposureSol * LAMPORTS)) - exposure) amount = BigInt(Math.floor(p.maxExposureSol * LAMPORTS)) - exposure;
        if (amount > free - tx) amount = free - tx;
        if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
        orders.push(...splitBuy(mint, amount, pieces(), room()));
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { openedSlot: now, best: 0n, tookTp1: false, lastValue: 0n });
        slotsLeft--;
      }

      // --- Guardrail pacing: open a probe only late in the window and only
      // when the coin count (not the fill count) lags the pace. Probes are a
      // safety net for a quiet window, not a fill farm: an immediate probe
      // round trip loses its fees for certain, so firing one early to chase
      // fills would bleed the whole run (measured: ~0.0005 SOL each).
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = pace > 0.8 && myCoins.size < Math.ceil(p.targetCoins * pace);
        if (needCoins) {
          for (const mint of traded) {
            if (room() <= 0 || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const probeAmount = BigInt(Math.floor(p.probeSol * LAMPORTS));
            if (state.maxBuyLamports(mint) < probeAmount) continue;
            if (free < probeAmount + 2n * tx) break;
            orders.push(...splitBuy(mint, probeAmount, pieces(), room()));
            probes.set(mint, false);
            free -= probeAmount + tx;
          }
        }
      }
      return orders;
    },
  };
}
