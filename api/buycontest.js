import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ── DB INIT ──────────────────────────────────────────────────
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS bc_contests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT DEFAULT 'pending',
      start_at DATETIME NOT NULL,
      end_at DATETIME NOT NULL,
      pot_usd REAL DEFAULT 0,
      winner1_wallet TEXT,
      winner2_wallet TEXT,
      winner3_wallet TEXT,
      winner1_tickets INTEGER DEFAULT 0,
      winner2_tickets INTEGER DEFAULT 0,
      winner3_tickets INTEGER DEFAULT 0,
      prize1_usd REAL DEFAULT 0,
      prize2_usd REAL DEFAULT 0,
      prize3_usd REAL DEFAULT 0,
      wheel_reserve_usd REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS bc_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contest_id INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      tickets INTEGER DEFAULT 0,
      total_usd REAL DEFAULT 0,
      rank INTEGER DEFAULT 0,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(contest_id, wallet)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS bc_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contest_id INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      tx_signature TEXT UNIQUE NOT NULL,
      usd_amount REAL NOT NULL,
      tickets_added INTEGER NOT NULL,
      token_price REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ── PRICE FETCH ──────────────────────────────────────────────
async function fetchTokenPrice() {
  const tokenAddress = process.env.WHEEL_TOKEN_ADDRESS;
  if (!tokenAddress) return 0;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { headers: { Accept: 'application/json' } });
    const d = await r.json();
    const pairs = (d.pairs || []).filter(p => p.chainId === 'solana' && parseFloat(p.priceUsd) > 0);
    if (pairs.length > 0) {
      const price = parseFloat(pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0].priceUsd);
      if (price > 0) return price;
    }
  } catch {}
  try {
    const r = await fetch(`https://price.jup.ag/v6/price?ids=${tokenAddress}`);
    const d = await r.json();
    const price = parseFloat(d.data?.[tokenAddress]?.price || 0);
    if (price > 0) return price;
  } catch {}
  return 0;
}

// ── VERIFY TX (same logic as wheel — transfer to treasury) ───
async function verifyTokenTransaction(signature) {
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
    const txTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;
    const pre = tx.meta?.preTokenBalances || [];
    const post = tx.meta?.postTokenBalances || [];
    let tokensReceived = 0;
    post.forEach(p => {
      if (p.mint !== tokenAddress || p.owner !== treasury) return;
      const preEntry = pre.find(pr => pr.accountIndex === p.accountIndex);
      const diff = (p.uiTokenAmount?.uiAmount || 0) - (preEntry?.uiTokenAmount?.uiAmount || 0);
      if (diff > 0) tokensReceived += diff;
    });
    if (tokensReceived === 0) return null;
    const tokenPrice = await fetchTokenPrice();
    const usdValue = tokenPrice > 0 ? tokensReceived * tokenPrice : 0;
    return { tokensReceived, tokenPrice, usdValue, txTime };
  } catch (e) {
    console.error('verifyTx:', e);
    return null;
  }
}

// ── GET ACTIVE CONTEST ────────────────────────────────────────
async function getActiveContest() {
  const now = new Date().toISOString();
  const res = await db.execute({
    sql: `SELECT * FROM bc_contests WHERE status = 'active' AND start_at <= ? AND end_at >= ? ORDER BY id DESC LIMIT 1`,
    args: [now, now]
  });
  if (res.rows.length > 0) return { ...res.rows[0], phase: 'active' };
  // Check upcoming
  const upcoming = await db.execute({
    sql: `SELECT * FROM bc_contests WHERE status = 'active' AND start_at > ? ORDER BY start_at ASC LIMIT 1`,
    args: [now]
  });
  if (upcoming.rows.length > 0) return { ...upcoming.rows[0], phase: 'upcoming' };
  // Check ended but not closed
  const ended = await db.execute({
    sql: `SELECT * FROM bc_contests WHERE status = 'active' AND end_at < ? ORDER BY end_at DESC LIMIT 1`,
    args: [now]
  });
  if (ended.rows.length > 0) return { ...ended.rows[0], phase: 'ended' };
  return null;
}


// Weighted lottery draw — each ticket = 1 entry, drawn without replacement
function _drawWinners(entries) {
  if (!entries || entries.length === 0) return [];
  // Build ticket pool
  let pool = [];
  entries.forEach(e => {
    for (let i = 0; i < (e.tickets || 1); i++) pool.push(e.wallet);
  });
  const winners = [];
  const used = new Set();
  while (winners.length < 3 && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    const wallet = pool[idx];
    if (!used.has(wallet)) {
      used.add(wallet);
      winners.push(entries.find(e => e.wallet === wallet));
    }
    pool.splice(idx, 1);
  }
  return winners;
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

    // ── GET CONTEST STATE ─────────────────────────────────────
    if (action === 'getContest') {
      const contest = await getActiveContest();
      const tokenPrice = await fetchTokenPrice();

      if (!contest) {
        const last = await db.execute(`SELECT * FROM bc_contests WHERE status = 'completed' ORDER BY end_at DESC LIMIT 1`);
        return res.status(200).json({ contest: null, lastContest: last.rows[0] || null, tokenPrice });
      }

      // Auto-finalize when 24h window is over
      if (contest.phase === 'ended' && contest.status === 'active') {
        try {
          const _e = await db.execute({ sql:`SELECT wallet,tickets,total_usd FROM bc_entries WHERE contest_id=?`, args:[contest.id] });
          const _p = await db.execute({ sql:`SELECT COALESCE(SUM(total_usd),0) as p FROM bc_entries WHERE contest_id=?`, args:[contest.id] });
          const _pot = parseFloat(_p.rows[0]?.p||0);
          const _top = _drawWinners(_e.rows);
          await db.execute({
            sql:`UPDATE bc_contests SET status='completed',pot_usd=?,winner1_wallet=?,winner2_wallet=?,winner3_wallet=?,winner1_tickets=?,winner2_tickets=?,winner3_tickets=?,prize1_usd=?,prize2_usd=?,prize3_usd=?,wheel_reserve_usd=? WHERE id=?`,
            args:[_pot,_top[0]?.wallet||null,_top[1]?.wallet||null,_top[2]?.wallet||null,_top[0]?.tickets||0,_top[1]?.tickets||0,_top[2]?.tickets||0,_pot*0.40,_pot*0.20,_pot*0.10,_pot*0.30,contest.id]
          });
        } catch(e) { console.error('finalize:',e); }
        const last = await db.execute(`SELECT * FROM bc_contests WHERE status = 'completed' ORDER BY end_at DESC LIMIT 1`);
        return res.status(200).json({ contest: null, lastContest: last.rows[0] || null, tokenPrice, autoFinalized: true });
      }

      // Leaderboard
      const leaderboard = await db.execute({
        sql: `SELECT wallet, tickets, total_usd, submitted_at FROM bc_entries WHERE contest_id = ? ORDER BY tickets DESC, submitted_at ASC LIMIT 50`,
        args: [contest.id]
      });

      // Total participants + pot
      const stats = await db.execute({
        sql: `SELECT COUNT(*) as participants, COALESCE(SUM(total_usd),0) as pot FROM bc_entries WHERE contest_id = ?`,
        args: [contest.id]
      });

      const pot = parseFloat(stats.rows[0]?.pot || 0);
      const participants = stats.rows[0]?.participants || 0;

      // My entry if wallet provided
      let myEntry = null;
      if (wallet) {
        const me = await db.execute({
          sql: `SELECT * FROM bc_entries WHERE contest_id = ? AND wallet = ?`,
          args: [contest.id, wallet]
        });
        myEntry = me.rows[0] || null;
      }

      return res.status(200).json({
        contest: {
          ...contest,
          pot_usd: pot,
          participants,
          prize1_usd: pot * 0.40,
          prize2_usd: pot * 0.20,
          prize3_usd: pot * 0.10,
          wheel_reserve: pot * 0.30,
        },
        leaderboard: leaderboard.rows,
        myEntry,
        tokenPrice,
        treasuryWallet: process.env.WHEEL_TREASURY_WALLET || '',
        ticketPriceUsd: 20,
        maxTickets: 10,
      });
    }

    // ── SUBMIT TX ─────────────────────────────────────────────
    if (action === 'submitTx') {
      const { txSignature } = body;
      if (!wallet || !txSignature) return res.status(400).json({ error: 'Missing params' });

      // Get active contest
      const contest = await getActiveContest();
      if (!contest) return res.status(400).json({ error: 'No active contest right now.' });
      if (contest.phase !== 'active') return res.status(400).json({ error: contest.phase === 'upcoming' ? 'Contest not started yet.' : 'Contest has ended.' });

      // Check duplicate TX in contest
      const bcDup = await db.execute({ sql: 'SELECT id FROM bc_transactions WHERE tx_signature = ?', args: [txSignature] });
      if (bcDup.rows.length > 0) return res.status(400).json({ error: 'Transaction already used for this contest.' });

      // Verify TX
      const result = await verifyTokenTransaction(txSignature);
      if (!result) return res.status(400).json({ error: 'Transaction not valid. Make sure you sent $YC to the treasury wallet.' });
      if (result.usdValue === 0) return res.status(400).json({ error: 'Cannot verify $YC price right now.' });
      if (result.usdValue < 20) return res.status(400).json({ error: `Amount too small ($${result.usdValue.toFixed(2)}). Minimum $20 per ticket.` });

      // Check TX is within contest window
      if (result.txTime) {
        const start = new Date(contest.start_at);
        const end = new Date(contest.end_at);
        if (result.txTime < start || result.txTime > end) {
          return res.status(400).json({ error: `Transaction outside contest window. Contest: ${start.toUTCString()} → ${end.toUTCString()}` });
        }
      }

      // Calculate tickets (capped at 10)
      const rawTickets = Math.floor(result.usdValue / 20);
      const currentEntry = await db.execute({ sql: 'SELECT * FROM bc_entries WHERE contest_id = ? AND wallet = ?', args: [contest.id, wallet] });
      const existingTickets = currentEntry.rows[0]?.tickets || 0;
      const ticketsToAdd = Math.min(rawTickets, 10 - existingTickets);
      if (ticketsToAdd <= 0) return res.status(400).json({ error: 'You already have the maximum 10 tickets for this contest.' });

      // Record contest TX
      await db.execute({
        sql: 'INSERT INTO bc_transactions (contest_id, wallet, tx_signature, usd_amount, tickets_added, token_price) VALUES (?, ?, ?, ?, ?, ?)',
        args: [contest.id, wallet, txSignature, result.usdValue, ticketsToAdd, result.tokenPrice]
      });

      // Update/create entry
      await db.execute({
        sql: `INSERT INTO bc_entries (contest_id, wallet, tickets, total_usd) VALUES (?, ?, ?, ?)
              ON CONFLICT(contest_id, wallet) DO UPDATE SET tickets = MIN(tickets + ?, 10), total_usd = total_usd + ?`,
        args: [contest.id, wallet, ticketsToAdd, result.usdValue, ticketsToAdd, result.usdValue]
      });

      // ALSO add wheel tickets (same TX = double benefit)
      const wheelDup = await db.execute({ sql: 'SELECT id FROM wheel_transactions WHERE tx_signature = ?', args: [txSignature] });
      let wheelTickets = 0;
      if (wheelDup.rows.length === 0) {
        wheelTickets = Math.floor(result.usdValue / 10);
        if (wheelTickets > 0) {
          await db.execute({
            sql: 'INSERT INTO wheel_transactions (wallet, tx_signature, tokens_received, token_price, usd_amount, tickets_added) VALUES (?, ?, ?, ?, ?, ?)',
            args: [wallet, txSignature, result.tokensReceived, result.tokenPrice, result.usdValue, wheelTickets]
          });
          await db.execute({
            sql: `INSERT INTO wheel_players (wallet, simple_tickets, is_eligible) VALUES (?, ?, 1)
                  ON CONFLICT(wallet) DO UPDATE SET simple_tickets = simple_tickets + ?, is_eligible = 1`,
            args: [wallet, wheelTickets, wheelTickets]
          });
        }
      }

      // Get updated entry
      const updated = await db.execute({ sql: 'SELECT * FROM bc_entries WHERE contest_id = ? AND wallet = ?', args: [contest.id, wallet] });

      return res.status(200).json({
        success: true,
        tickets_added: ticketsToAdd,
        total_tickets: updated.rows[0]?.tickets || ticketsToAdd,
        usd_amount: result.usdValue.toFixed(2),
        wheel_tickets_added: wheelTickets,
        message: wheelTickets > 0 ? `Contest: +${ticketsToAdd} ticket(s) · Wheel: +${wheelTickets} ticket(s) added!` : `+${ticketsToAdd} contest ticket(s) added!`
      });
    }

    // ── PAST CONTESTS ─────────────────────────────────────────
    if (action === 'getPastContests') {
      const contests = await db.execute(`SELECT * FROM bc_contests WHERE status = 'completed' ORDER BY end_at DESC LIMIT 10`);
      return res.status(200).json({ contests: contests.rows });
    }

    // ── ADMIN: CREATE CONTEST ─────────────────────────────────
    if (action === 'adminCreateContest') {
      if (body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const { startAt, endAt } = body;
      if (!startAt || !endAt) return res.status(400).json({ error: 'Missing start/end' });
      // Close any existing active
      await db.execute(`UPDATE bc_contests SET status = 'completed' WHERE status = 'active'`);
      // Create new
      // Ensure dates are stored as ISO strings
      const startISO = new Date(startAt).toISOString();
      const endISO = new Date(endAt).toISOString();
      await db.execute({
        sql: `INSERT INTO bc_contests (status, start_at, end_at) VALUES ('active', ?, ?)`,
        args: [startISO, endISO]
      });
      return res.status(200).json({ success: true });
    }

    // ── ADMIN: END CONTEST ────────────────────────────────────
    if (action === 'adminEndContest') {
      if (body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const { contestId } = body;
      const contest = await db.execute({ sql: `SELECT * FROM bc_contests WHERE id = ?`, args: [contestId] });
      if (!contest.rows[0]) return res.status(400).json({ error: 'Contest not found' });

      const entries = await db.execute({
        sql: `SELECT wallet, tickets, total_usd FROM bc_entries WHERE contest_id = ? ORDER BY tickets DESC, submitted_at ASC`,
        args: [contestId]
      });

      const stats = await db.execute({ sql: `SELECT COALESCE(SUM(total_usd),0) as pot FROM bc_entries WHERE contest_id = ?`, args: [contestId] });
      const pot = parseFloat(stats.rows[0]?.pot || 0);
      const top = _drawWinners(entries.rows);

      await db.execute({
        sql: `UPDATE bc_contests SET status='completed', pot_usd=?,
              winner1_wallet=?, winner2_wallet=?, winner3_wallet=?,
              winner1_tickets=?, winner2_tickets=?, winner3_tickets=?,
              prize1_usd=?, prize2_usd=?, prize3_usd=?, wheel_reserve_usd=?
              WHERE id=?`,
        args: [
          pot,
          top[0]?.wallet || null, top[1]?.wallet || null, top[2]?.wallet || null,
          top[0]?.tickets || 0, top[1]?.tickets || 0, top[2]?.tickets || 0,
          pot * 0.40, pot * 0.20, pot * 0.10, pot * 0.30,
          contestId
        ]
      });
      return res.status(200).json({ success: true, pot, winners: top.slice(0, 3) });
    }

    // ── ADMIN: STATS ──────────────────────────────────────────
    if (action === 'adminBCStats') {
      if (body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const contests = await db.execute(`SELECT * FROM bc_contests ORDER BY created_at DESC LIMIT 20`);
      const contest = await getActiveContest();
      let leaderboard = [], stats = {};
      if (contest) {
        leaderboard = (await db.execute({ sql: `SELECT wallet, tickets, total_usd, submitted_at FROM bc_entries WHERE contest_id = ? ORDER BY tickets DESC, submitted_at ASC`, args: [contest.id] })).rows;
        const s = (await db.execute({ sql: `SELECT COUNT(*) as p, COALESCE(SUM(total_usd),0) as pot FROM bc_entries WHERE contest_id = ?`, args: [contest.id] })).rows[0];
        stats = s;
      }
      return res.status(200).json({ contests: contests.rows, activeContest: contest, leaderboard, stats });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('Buy Contest API error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}