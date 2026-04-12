import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ============================================================
// WHEEL SEGMENT DEFINITIONS
// MUST match wheel.html exactly (same order, same count)
// ============================================================
const WHEEL_CONFIGS = {
  simple: {
    segments: [
      { label: '$10',      amount: 10,  special: null },    // 0
      { label: 'LOSE',     amount: 0,   special: null },    // 1
      { label: '$20',      amount: 20,  special: null },    // 2
      { label: 'LOSE',     amount: 0,   special: null },    // 3
      { label: '$10',      amount: 10,  special: null },    // 4
      { label: 'LOSE',     amount: 0,   special: null },    // 5
      { label: '$50',      amount: 50,  special: null },    // 6
      { label: 'LOSE',     amount: 0,   special: null },    // 7
      { label: '$10',      amount: 10,  special: null },    // 8
      { label: 'LOSE',     amount: 0,   special: null },    // 9
      { label: '$20',      amount: 20,  special: null },    // 10
      { label: 'LOSE',     amount: 0,   special: null },    // 11
      { label: 'YELLOW',   amount: 0,   special: 'yellow'}, // 12
      { label: 'LOSE',     amount: 0,   special: null },    // 13
      { label: '$10',      amount: 10,  special: null },    // 14
      { label: 'LOSE',     amount: 0,   special: null },    // 15
      { label: '$100',     amount: 100, special: null },    // 16
      { label: '$20',      amount: 20,  special: null },    // 17
    ]
  },
  yellow: {
    segments: [
      { label: 'LOSE',   amount: 0,   special: null },    // 0
      { label: '$50',    amount: 50,  special: null },    // 1
      { label: 'LOSE',   amount: 0,   special: null },    // 2
      { label: '$100',   amount: 100, special: null },    // 3
      { label: 'LOSE',   amount: 0,   special: null },    // 4
      { label: '$50',    amount: 50,  special: null },    // 5
      { label: 'LOSE',   amount: 0,   special: null },    // 6
      { label: 'GOLD',   amount: 0,   special: 'gold' }, // 7
      { label: 'LOSE',   amount: 0,   special: null },    // 8
      { label: 'LOSE',   amount: 0,   special: null },    // 9
      { label: 'LOSE',   amount: 0,   special: null },    // 10
    ]
  },
  gold: {
    segments: [
      { label: '$50',   amount: 50,  special: null },    // 0
      { label: 'LOSE',  amount: 0,   special: null },    // 1
      { label: '$50',   amount: 50,  special: null },    // 2
      { label: 'LOSE',  amount: 0,   special: null },    // 3
      { label: '$200',  amount: 200, special: null },    // 4
      { label: 'LOSE',  amount: 0,   special: null },    // 5
      { label: '$50',   amount: 50,  special: null },    // 6
      { label: 'LOSE',  amount: 0,   special: null },    // 7
      { label: '$50',   amount: 50,  special: null },    // 8
      { label: 'LOSE',  amount: 0,   special: null },    // 9
      { label: '$50',   amount: 50,  special: null },    // 10
      { label: 'LOSE',  amount: 0,   special: null },    // 11
    ]
  }
};

// ============================================================
// DB INIT
// ============================================================
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS wheel_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      tx_signature TEXT UNIQUE NOT NULL,
      sol_amount REAL NOT NULL,
      usd_amount REAL NOT NULL,
      tickets_added INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ============================================================
// CHECK TOKEN BALANCE (eligibility)
// ============================================================
async function checkTokenBalance(wallet) {
  const tokenAddress = process.env.WHEEL_TOKEN_ADDRESS;
  if (!tokenAddress) return true; // no token configured = open access
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
  } catch (e) {
    console.error('checkTokenBalance:', e);
    return false;
  }
}

// ============================================================
// VERIFY SOL TRANSACTION
// ============================================================
async function verifySOLTransaction(signature, fromWallet) {
  const treasury = process.env.WHEEL_TREASURY_WALLET;
  if (!treasury) return null;
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

    const keys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey);
    const treasuryIdx = keys.indexOf(treasury);
    const fromIdx = keys.indexOf(fromWallet);
    if (treasuryIdx === -1 || fromIdx === -1) return null;

    const solReceived = (tx.meta.postBalances[treasuryIdx] - tx.meta.preBalances[treasuryIdx]) / 1e9;
    if (solReceived <= 0) return null;

    // Check date
    const startDate = process.env.WHEEL_START_DATE ? new Date(process.env.WHEEL_START_DATE) : new Date('2026-01-01');
    if (tx.blockTime && new Date(tx.blockTime * 1000) < startDate) return null;

    return solReceived;
  } catch (e) {
    console.error('verifySOLTransaction:', e);
    return null;
  }
}

// ============================================================
// SPIN RESULT — server-side RNG
// ============================================================
function getSpinResult(wheelType) {
  const config = WHEEL_CONFIGS[wheelType];
  if (!config) return null;
  const segments = config.segments;
  const idx = Math.floor(Math.random() * segments.length);
  const seg = segments[idx];
  return {
    segmentIndex: idx,
    totalSegments: segments.length,
    result: seg.label,
    amount: seg.amount,
    special: seg.special
  };
}

// ============================================================
// HANDLER
// ============================================================
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

    // ── CHECK WALLET ──────────────────────────────────────────
    if (action === 'checkWallet') {
      if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

      let player = await db.execute({ sql: 'SELECT * FROM wheel_players WHERE wallet = ?', args: [wallet] });

      if (player.rows.length > 0) {
        await db.execute({ sql: 'UPDATE wheel_players SET last_seen = CURRENT_TIMESTAMP WHERE wallet = ?', args: [wallet] });
      }

      const eligible = await checkTokenBalance(wallet);

      if (!eligible && !(player.rows[0]?.is_eligible)) {
        return res.status(200).json({
          eligible: false,
          message: 'You need to hold $YELLOWCATZ tokens to participate',
          simple_tickets: 0, yellow_tickets: 0, gold_tickets: 0
        });
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

      const solAmount = await verifySOLTransaction(txSignature, wallet);
      if (solAmount === null) return res.status(400).json({ error: 'Transaction not valid or not confirmed yet. Wait a few seconds and try again.' });

      const solPrice = parseFloat(process.env.SOL_PRICE_USD || '150');
      const usdAmount = solAmount * solPrice;
      const tickets = Math.floor(usdAmount / 10);

      if (tickets === 0) return res.status(400).json({
        error: `Amount too small: $${usdAmount.toFixed(2)} received. Minimum $10 per ticket.`
      });

      await db.execute({
        sql: 'INSERT INTO wheel_transactions (wallet, tx_signature, sol_amount, usd_amount, tickets_added) VALUES (?, ?, ?, ?, ?)',
        args: [wallet, txSignature, solAmount, usdAmount, tickets]
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
        usd_amount: usdAmount.toFixed(2),
        simple_tickets: pl.simple_tickets || 0,
        yellow_tickets: pl.yellow_tickets || 0,
        gold_tickets: pl.gold_tickets || 0
      });
    }

    // ── SPIN ──────────────────────────────────────────────────
    if (action === 'spin') {
      const { wheelType } = body;
      if (!wallet || !wheelType) return res.status(400).json({ error: 'Missing params' });

      const validTypes = ['simple', 'yellow', 'gold'];
      if (!validTypes.includes(wheelType)) return res.status(400).json({ error: 'Invalid wheel type' });

      const ticketField = `${wheelType}_tickets`;
      const p = await db.execute({ sql: 'SELECT * FROM wheel_players WHERE wallet = ?', args: [wallet] });
      if (!p.rows[0] || p.rows[0][ticketField] < 1) {
        return res.status(400).json({ error: `No ${wheelType} tickets` });
      }

      const spin = getSpinResult(wheelType);

      await db.execute({
        sql: `UPDATE wheel_players SET ${ticketField} = ${ticketField} - 1, total_won = total_won + ? WHERE wallet = ?`,
        args: [spin.amount, wallet]
      });

      // Special prizes unlock next wheel
      if (spin.special === 'yellow') {
        await db.execute({ sql: 'UPDATE wheel_players SET yellow_tickets = yellow_tickets + 1 WHERE wallet = ?', args: [wallet] });
      } else if (spin.special === 'gold') {
        await db.execute({ sql: 'UPDATE wheel_players SET gold_tickets = gold_tickets + 1 WHERE wallet = ?', args: [wallet] });
      }

      await db.execute({
        sql: 'INSERT INTO wheel_spins (wallet, wheel_type, result, amount, special, segment_index) VALUES (?, ?, ?, ?, ?, ?)',
        args: [wallet, wheelType, spin.result, spin.amount, spin.special || null, spin.segmentIndex]
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
      const players = await db.execute('SELECT COUNT(*) as c FROM wheel_players WHERE is_eligible = 1');
      const spins = await db.execute('SELECT COUNT(*) as c FROM wheel_spins');
      const won = await db.execute('SELECT COALESCE(SUM(amount),0) as t FROM wheel_spins WHERE amount > 0');
      const wins = await db.execute('SELECT wallet, wheel_type, result, amount, created_at FROM wheel_spins WHERE amount > 0 ORDER BY created_at DESC LIMIT 50');
      const top = await db.execute('SELECT wallet, simple_tickets, yellow_tickets, gold_tickets, total_won FROM wheel_players ORDER BY total_won DESC LIMIT 50');
      return res.status(200).json({
        players: players.rows[0]?.c || 0,
        total_spins: spins.rows[0]?.c || 0,
        total_won: won.rows[0]?.t || 0,
        wins: wins.rows,
        top_players: top.rows
      });
    }

    // ── ADMIN ADD TICKETS ─────────────────────────────────────
    if (action === 'adminAddTickets') {
      if (body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const { targetWallet, ticketType, amount } = body;
      const validFields = ['simple', 'yellow', 'gold'];
      if (!validFields.includes(ticketType)) return res.status(400).json({ error: 'Invalid type' });
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