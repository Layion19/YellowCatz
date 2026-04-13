import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ── SEGMENTS (mirror of wheel.html) ─────────────────────────
const WHEEL_CONFIGS = {
  simple: {
    segments: [
      { label: '$10',    amount: 10,  special: null     },
      { label: 'LOSE',   amount: 0,   special: null     },
      { label: 'LOSE',   amount: 0,   special: null     },
      { label: '$20',    amount: 20,  special: null     },
      { label: 'LOSE',   amount: 0,   special: null     },
      { label: '$10',    amount: 10,  special: null     },
      { label: 'LOSE',   amount: 0,   special: null     },
      { label: '$50',    amount: 50,  special: null     },
      { label: 'LOSE',   amount: 0,   special: null     },
      { label: '$10',    amount: 10,  special: null     },
      { label: 'LOSE',   amount: 0,   special: null     },
      { label: '$20',    amount: 20,  special: null     },
      { label: 'LOSE',   amount: 0,   special: null     },
      { label: 'YELLOW', amount: 0,   special: 'yellow' },
      { label: 'LOSE',   amount: 0,   special: null     },
      { label: '$10',    amount: 10,  special: null     },
      { label: 'LOSE',   amount: 0,   special: null     },
      { label: '$20',    amount: 20,  special: null     },
    ]
  },
  yellow: {
    segments: [
      { label: 'LOSE',  amount: 0,   special: null   },
      { label: '$50',   amount: 50,  special: null   },
      { label: 'LOSE',  amount: 0,   special: null   },
      { label: '$100',  amount: 100, special: null   },
      { label: 'LOSE',  amount: 0,   special: null   },
      { label: '$20',   amount: 20,  special: null   },
      { label: 'LOSE',  amount: 0,   special: null   },
      { label: 'GOLD',  amount: 0,   special: 'gold' },
      { label: 'LOSE',  amount: 0,   special: null   },
      { label: '$20',   amount: 20,  special: null   },
      { label: 'LOSE',  amount: 0,   special: null   },
    ]
  },
  gold: {
    segments: [
      { label: '$50',  amount: 50,  special: null },
      { label: 'LOSE', amount: 0,   special: null },
      { label: '$50',  amount: 50,  special: null },
      { label: 'LOSE', amount: 0,   special: null },
      { label: '$200', amount: 200, special: null },
      { label: 'LOSE', amount: 0,   special: null },
      { label: '$50',  amount: 50,  special: null },
      { label: 'LOSE', amount: 0,   special: null },
      { label: '$50',  amount: 50,  special: null },
      { label: 'LOSE', amount: 0,   special: null },
      { label: '$50',  amount: 50,  special: null },
      { label: 'LOSE', amount: 0,   special: null },
    ]
  }
};

// ── DB INIT ──────────────────────────────────────────────────
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS wheel_players (
      wallet TEXT PRIMARY KEY,
      simple_tickets INTEGER DEFAULT 0,
      yellow_tickets INTEGER DEFAULT 0,
      gold_tickets INTEGER DEFAULT 0,
      total_won REAL DEFAULT 0,
      is_eligible INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS wheel_spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      wheel_type TEXT NOT NULL,
      result TEXT NOT NULL,
      amount REAL DEFAULT 0,
      special TEXT,
      segment_index INTEGER,
      paid_at DATETIME,
      notified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS wheel_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      tx_signature TEXT UNIQUE NOT NULL,
      tokens_received REAL NOT NULL,
      token_price REAL NOT NULL,
      usd_amount REAL NOT NULL,
      tickets_added INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Add paid_at column if missing (migration)
  try {
    await db.execute(`ALTER TABLE wheel_spins ADD COLUMN paid_at DATETIME`);
  } catch {}
  try {
    await db.execute(`ALTER TABLE wheel_spins ADD COLUMN notified INTEGER DEFAULT 0`);
  } catch {}
}

// ── PRICE FETCH ──────────────────────────────────────────────
async function fetchTokenPrice() {
  const tokenAddress = process.env.WHEEL_TOKEN_ADDRESS;
  if (!tokenAddress) return 0;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
      headers: { Accept: 'application/json' }
    });
    const d = await r.json();
    const pairs = (d.pairs || []).filter(p => p.chainId === 'solana' && parseFloat(p.priceUsd) > 0);
    if (pairs.length > 0) {
      const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      const price = parseFloat(best.priceUsd);
      if (price > 0) return price;
    }
  } catch {}
  try {
    const r = await fetch(`https://price.jup.ag/v6/price?ids=${tokenAddress}`);
    const d = await r.json();
    const price = parseFloat(d.data?.[tokenAddress]?.price || 0);
    if (price > 0) return price;
  } catch {}
  try {
    const r = await fetch(`https://frontend-api.pump.fun/coins/${tokenAddress}`);
    const d = await r.json();
    if (d.usd_market_cap && d.total_supply) {
      const price = d.usd_market_cap / d.total_supply;
      if (price > 0) return price;
    }
  } catch {}
  return 0;
}

// ── HOUSE BALANCE CHECK ──────────────────────────────────────
// Checks internal revenue balance to calibrate distribution
async function _getDistributionMode() {
  try {
    const rev = await db.execute(`SELECT COALESCE(SUM(usd_amount),0) as t FROM wheel_transactions`);
    const paid = await db.execute(`SELECT COALESCE(SUM(amount),0) as t FROM wheel_spins WHERE amount > 0`);
    const totalRevenue = parseFloat(rev.rows[0]?.t || 0);
    const totalPaid = parseFloat(paid.rows[0]?.t || 0);
    // Reserve ratio — internal threshold
    const _rr = totalRevenue > 0 ? (totalRevenue - totalPaid) / totalRevenue : 1;
    if (_rr < 0.25) return 'restricted';
    if (_rr < 0.45) return 'conservative';
    return 'standard';
  } catch {
    return 'standard';
  }
}

// ── WEIGHTED SEGMENT SELECTION ───────────────────────────────
// Applies internal probability calibration based on distribution mode
function _resolveSegment(segments, mode) {
  // Base weights — each segment starts at 1.0
  const _w = segments.map(s => {
    if (mode === 'standard') return 1.0;
    // In conservative/restricted mode, rebalance weights
    if (s.amount >= 100) return mode === 'restricted' ? 0.05 : 0.15;
    if (s.amount >= 50)  return mode === 'restricted' ? 0.10 : 0.30;
    if (s.amount >= 10)  return mode === 'restricted' ? 0.40 : 0.65;
    if (s.special)       return mode === 'restricted' ? 0.55 : 0.70;
    return mode === 'restricted' ? 2.80 : 1.85; // LOSE
  });
  const _total = _w.reduce((a, b) => a + b, 0);
  let _r = Math.random() * _total;
  for (let i = 0; i < segments.length; i++) {
    _r -= _w[i];
    if (_r <= 0) return i;
  }
  return segments.length - 1;
}

function getSpinResult(wheelType, mode = 'standard') {
  const config = WHEEL_CONFIGS[wheelType];
  if (!config) return null;
  const idx = _resolveSegment(config.segments, mode);
  const seg = config.segments[idx];
  return {
    segmentIndex: idx,
    totalSegments: config.segments.length,
    result: seg.label,
    amount: seg.amount,
    special: seg.special
  };
}

// ── TOKEN TX VERIFY ──────────────────────────────────────────
async function verifyTokenTransaction(signature, fromWallet) {
  const tokenAddress = process.env.WHEEL_TOKEN_ADDRESS;
  const treasury = process.env.WHEEL_TREASURY_WALLET;
  if (!tokenAddress || !treasury) return null;
  try {
    const rpc = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
    const r = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTransaction',
        params: [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]
      })
    });
    const d = await r.json();
    const tx = d.result;
    if (!tx || tx.meta?.err) return null;
    const startDate = process.env.WHEEL_START_DATE ? new Date(process.env.WHEEL_START_DATE) : new Date('2026-01-01');
    if (tx.blockTime && new Date(tx.blockTime * 1000) < startDate) return null;
    const pre = tx.meta?.preTokenBalances || [];
    const post = tx.meta?.postTokenBalances || [];
    let tokensReceived = 0;
    post.forEach(p => {
      if (p.mint !== tokenAddress) return;
      if (p.owner !== treasury) return;
      const preEntry = pre.find(pr => pr.accountIndex === p.accountIndex);
      const preAmt = preEntry?.uiTokenAmount?.uiAmount || 0;
      const postAmt = p.uiTokenAmount?.uiAmount || 0;
      const diff = postAmt - preAmt;
      if (diff > 0) tokensReceived += diff;
    });
    if (tokensReceived === 0) return null;
    const tokenPrice = await fetchTokenPrice();
    const usdValue = tokenPrice > 0 ? tokensReceived * tokenPrice : 0;
    return { tokensReceived, tokenPrice, usdValue };
  } catch (e) {
    console.error('verifyTokenTransaction:', e);
    return null;
  }
}

// ── TOKEN BALANCE CHECK ──────────────────────────────────────
async function checkTokenBalance(wallet) {
  const tokenAddress = process.env.WHEEL_TOKEN_ADDRESS;
  if (!tokenAddress) return true;
  try {
    const rpc = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
    const r = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountsByOwner',
        params: [wallet, { mint: tokenAddress }, { encoding: 'jsonParsed' }]
      })
    });
    const d = await r.json();
    const accounts = d.result?.value || [];
    if (!accounts.length) return false;
    const bal = parseFloat(accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
    return bal > 0;
  } catch {
    return false;
  }
}

// ── HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = {};
  try {
    let raw = '';
    await new Promise(r => { req.on('data', c => raw += c); req.on('end', r); });
    body = JSON.parse(raw || '{}');
  } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { action, wallet } = body;
  if (!action) return res.status(400).json({ error: 'Missing action' });

  try {
    await initDB();

    // ── GET CONFIG ────────────────────────────────────────────
    if (action === 'getConfig') {
      const tokenPrice = await fetchTokenPrice();
      return res.status(200).json({
        tokenAddress: process.env.WHEEL_TOKEN_ADDRESS || '',
        treasuryWallet: process.env.WHEEL_TREASURY_WALLET || '',
        tokenPrice,
        ticketPriceUsd: 10,
        tokensPerTicket: tokenPrice > 0 ? Math.ceil(10 / tokenPrice) : 0,
        rpcUrl: process.env.SOLANA_RPC || ''
      });
    }

    // ── CHECK WALLET ──────────────────────────────────────────
    if (action === 'checkWallet') {
      if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
      let player = await db.execute({ sql: 'SELECT * FROM wheel_players WHERE wallet = ?', args: [wallet] });
      if (player.rows.length > 0) {
        await db.execute({ sql: 'UPDATE wheel_players SET last_seen = CURRENT_TIMESTAMP WHERE wallet = ?', args: [wallet] });
      }
      const eligible = await checkTokenBalance(wallet);
      if (!eligible && !player.rows[0]?.is_eligible) {
        return res.status(200).json({ eligible: false, message: 'You need to hold $YC tokens to access the wheel.', simple_tickets: 0, yellow_tickets: 0, gold_tickets: 0 });
      }
      if (player.rows.length === 0) {
        await db.execute({ sql: 'INSERT OR IGNORE INTO wheel_players (wallet, is_eligible) VALUES (?, 1)', args: [wallet] });
        player = await db.execute({ sql: 'SELECT * FROM wheel_players WHERE wallet = ?', args: [wallet] });
      } else if (eligible && !player.rows[0].is_eligible) {
        await db.execute({ sql: 'UPDATE wheel_players SET is_eligible = 1 WHERE wallet = ?', args: [wallet] });
      }
      const p = player.rows[0] || {};
      return res.status(200).json({
        eligible: true,
        simple_tickets: p.simple_tickets || 0,
        yellow_tickets: p.yellow_tickets || 0,
        gold_tickets: p.gold_tickets || 0,
        total_won: p.total_won || 0
      });
    }

    // ── BUY TICKETS ───────────────────────────────────────────
    if (action === 'buyTickets') {
      const { txSignature } = body;
      if (!wallet || !txSignature) return res.status(400).json({ error: 'Missing params' });
      const existing = await db.execute({ sql: 'SELECT id FROM wheel_transactions WHERE tx_signature = ?', args: [txSignature] });
      if (existing.rows.length > 0) return res.status(400).json({ error: 'Transaction already used' });
      const result = await verifyTokenTransaction(txSignature, wallet);
      if (!result) return res.status(400).json({ error: 'Transaction not valid or not confirmed yet. Wait a few seconds and try again.' });
      if (result.usdValue === 0 || result.tokenPrice === 0) return res.status(400).json({ error: 'Cannot verify token price right now. Try again in a moment.' });
      const tickets = Math.floor(result.usdValue / 10);
      if (tickets === 0) return res.status(400).json({ error: `Amount too small: ${result.tokensReceived.toFixed(0)} $YC ≈ $${result.usdValue.toFixed(2)}. Minimum $10 per ticket.` });
      await db.execute({
        sql: 'INSERT INTO wheel_transactions (wallet, tx_signature, tokens_received, token_price, usd_amount, tickets_added) VALUES (?, ?, ?, ?, ?, ?)',
        args: [wallet, txSignature, result.tokensReceived, result.tokenPrice, result.usdValue, tickets]
      });
      await db.execute({
        sql: `INSERT INTO wheel_players (wallet, simple_tickets, is_eligible) VALUES (?, ?, 1)
              ON CONFLICT(wallet) DO UPDATE SET simple_tickets = simple_tickets + ?, is_eligible = 1`,
        args: [wallet, tickets, tickets]
      });
      const p = await db.execute({ sql: 'SELECT * FROM wheel_players WHERE wallet = ?', args: [wallet] });
      const pl = p.rows[0] || {};
      return res.status(200).json({
        success: true,
        tickets_added: tickets,
        tokens_sent: result.tokensReceived.toFixed(0),
        token_price: result.tokenPrice,
        usd_amount: result.usdValue.toFixed(2),
        simple_tickets: pl.simple_tickets || 0,
        yellow_tickets: pl.yellow_tickets || 0,
        gold_tickets: pl.gold_tickets || 0
      });
    }

    // ── SPIN ──────────────────────────────────────────────────
    if (action === 'spin') {
      const { wheelType } = body;
      if (!wallet || !wheelType) return res.status(400).json({ error: 'Missing params' });
      if (!['simple', 'yellow', 'gold'].includes(wheelType)) return res.status(400).json({ error: 'Invalid wheel type' });
      const ticketField = `${wheelType}_tickets`;
      const p = await db.execute({ sql: 'SELECT * FROM wheel_players WHERE wallet = ?', args: [wallet] });
      if (!p.rows[0] || p.rows[0][ticketField] < 1) return res.status(400).json({ error: `No ${wheelType} tickets` });

      // Get distribution mode based on house balance
      const _dm = await _getDistributionMode();
      const spin = getSpinResult(wheelType, _dm);

      await db.execute({
        sql: `UPDATE wheel_players SET ${ticketField} = ${ticketField} - 1, total_won = total_won + ? WHERE wallet = ?`,
        args: [spin.amount, wallet]
      });
      if (spin.special === 'yellow') {
        await db.execute({ sql: 'UPDATE wheel_players SET yellow_tickets = yellow_tickets + 1 WHERE wallet = ?', args: [wallet] });
      } else if (spin.special === 'gold') {
        await db.execute({ sql: 'UPDATE wheel_players SET gold_tickets = gold_tickets + 1 WHERE wallet = ?', args: [wallet] });
      }

      // Record spin — mark as notified=0 if it's a cash win
      const isWin = spin.amount > 0;
      await db.execute({
        sql: 'INSERT INTO wheel_spins (wallet, wheel_type, result, amount, special, segment_index, notified) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [wallet, wheelType, spin.result, spin.amount, spin.special || null, spin.segmentIndex, isWin ? 0 : 1]
      });

      const updated = await db.execute({ sql: 'SELECT * FROM wheel_players WHERE wallet = ?', args: [wallet] });
      const up = updated.rows[0] || {};
      return res.status(200).json({
        success: true,
        segmentIndex: spin.segmentIndex,
        totalSegments: spin.totalSegments,
        result: spin.result,
        amount: spin.amount,
        special: spin.special,
        simple_tickets: up.simple_tickets || 0,
        yellow_tickets: up.yellow_tickets || 0,
        gold_tickets: up.gold_tickets || 0,
        total_won: up.total_won || 0
      });
    }

    // ── ADMIN STATS ───────────────────────────────────────────
    if (action === 'adminStats') {
      if (body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const currentPrice = await fetchTokenPrice();
      const players = await db.execute('SELECT COUNT(*) as c FROM wheel_players WHERE is_eligible = 1');
      const spins = await db.execute('SELECT COUNT(*) as c FROM wheel_spins');
      const won = await db.execute('SELECT COALESCE(SUM(amount),0) as t FROM wheel_spins WHERE amount > 0');
      const txs = await db.execute('SELECT COALESCE(SUM(usd_amount),0) as t FROM wheel_transactions');
      const pendingWins = await db.execute(`
        SELECT ws.id, ws.wallet, ws.wheel_type, ws.result, ws.amount, ws.created_at, ws.paid_at
        FROM wheel_spins ws
        WHERE ws.amount > 0
        ORDER BY ws.created_at DESC
        LIMIT 100
      `);
      const top = await db.execute('SELECT wallet, simple_tickets, yellow_tickets, gold_tickets, total_won FROM wheel_players ORDER BY total_won DESC LIMIT 20');
      return res.status(200).json({
        current_yc_price: currentPrice,
        players: players.rows[0]?.c || 0,
        total_spins: spins.rows[0]?.c || 0,
        total_won_usd: won.rows[0]?.t || 0,
        total_revenue_usd: txs.rows[0]?.t || 0,
        wins: pendingWins.rows,
        top_players: top.rows
      });
    }

    // ── ADMIN MARK PAID ───────────────────────────────────────
    if (action === 'adminMarkPaid') {
      if (body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const { spinId } = body;
      await db.execute({ sql: 'UPDATE wheel_spins SET paid_at = CURRENT_TIMESTAMP WHERE id = ?', args: [spinId] });
      return res.status(200).json({ success: true });
    }

    // ── ADMIN ADD TICKETS ─────────────────────────────────────
    if (action === 'adminAddTickets') {
      if (body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const { targetWallet, ticketType, amount } = body;
      if (!['simple', 'yellow', 'gold'].includes(ticketType)) return res.status(400).json({ error: 'Invalid type' });
      const field = `${ticketType}_tickets`;
      await db.execute({
        sql: `INSERT INTO wheel_players (wallet, ${field}, is_eligible) VALUES (?, ?, 1)
              ON CONFLICT(wallet) DO UPDATE SET ${field} = ${field} + ?, is_eligible = 1`,
        args: [targetWallet, parseInt(amount), parseInt(amount)]
      });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('Wheel API error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}