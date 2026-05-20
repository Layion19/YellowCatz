// api/wl-submit.js
// POST /api/wl-submit
//
// Règles doublons :
//   - x_handle déjà existant         → 409, refusé, rien enregistré
//   - eth_address déjà existante
//     avec x_handle différent         → 409, refusé, MAIS enregistré dans yc_wl_warnings

const { createClient } = require('@libsql/client');

const CREATE_WL = `
  CREATE TABLE IF NOT EXISTS yc_whitelist (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    x_handle     TEXT NOT NULL UNIQUE,
    eth_address  TEXT NOT NULL UNIQUE,
    community    TEXT DEFAULT '',
    rt_link      TEXT DEFAULT '',
    comment_link TEXT DEFAULT '',
    status       TEXT DEFAULT 'pending',
    created_at   TEXT DEFAULT (datetime('now'))
  )`;

const CREATE_WARN = `
  CREATE TABLE IF NOT EXISTS yc_wl_warnings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    eth_address TEXT NOT NULL,
    x_handle    TEXT NOT NULL,
    reason      TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  )`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { x_handle, eth_address, community, rt_link, comment_link } = req.body || {};

  if (!x_handle || !eth_address)
    return res.status(400).json({ error: 'Missing required fields' });

  if (!/^0x[0-9a-fA-F]{40,}$/.test(eth_address))
    return res.status(400).json({ error: 'Invalid ETH address' });

  const handle = x_handle.toLowerCase().trim();
  const eth    = eth_address.toLowerCase().trim();

  let client;
  try {
    client = createClient({
      url:       process.env.TURSO_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });

    await client.execute(CREATE_WL);
    await client.execute(CREATE_WARN);

    // 1 — check x_handle duplicate
    const dupHandle = await client.execute({
      sql:  'SELECT id FROM yc_whitelist WHERE x_handle = ? LIMIT 1',
      args: [handle],
    });

    if (dupHandle.rows.length > 0) {
      // Silently blocked — no warning stored (same person trying twice)
      return res.status(409).json({ error: 'Already registered' });
    }

    // 2 — check eth_address duplicate (different handle = suspicious)
    const dupEth = await client.execute({
      sql:  'SELECT id, x_handle FROM yc_whitelist WHERE eth_address = ? LIMIT 1',
      args: [eth],
    });

    if (dupEth.rows.length > 0) {
      // Store as warning for the admin
      await client.execute({
        sql:  'INSERT INTO yc_wl_warnings (eth_address, x_handle, reason) VALUES (?, ?, ?)',
        args: [eth, handle, 'ETH address already registered with a different X handle'],
      });
      return res.status(409).json({ error: 'Already registered' });
    }

    // 3 — All clear, insert
    await client.execute({
      sql:  'INSERT INTO yc_whitelist (x_handle, eth_address, community, rt_link, comment_link) VALUES (?, ?, ?, ?, ?)',
      args: [handle, eth, (community || '').trim(), (rt_link || '').trim(), (comment_link || '').trim()],
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[wl-submit]', err);
    return res.status(500).json({ error: 'Database error' });
  }
};