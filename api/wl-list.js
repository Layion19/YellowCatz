// api/wl-list.js
// GET  → returns whitelist entries + warnings + collab applications
// POST → update status of an entry

const { createClient } = require('@libsql/client');
const VALID = ['pending', 'approved', 'rejected'];

async function ensureTables(client) {
  // Create tables if they don't exist
  await client.execute(`CREATE TABLE IF NOT EXISTS yc_whitelist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    x_handle TEXT NOT NULL UNIQUE,
    eth_address TEXT NOT NULL UNIQUE,
    community TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS yc_wl_warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eth_address TEXT NOT NULL,
    x_handle TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS yc_collab_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twitter_link TEXT NOT NULL,
    community_description TEXT NOT NULL,
    support_offer TEXT NOT NULL,
    main_contact TEXT NOT NULL,
    collab_tweet TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Migrate missing columns silently
  const cols = [
    ['yc_whitelist',           'rt_link',      'TEXT DEFAULT ""'],
    ['yc_whitelist',           'comment_link', 'TEXT DEFAULT ""'],
    ['yc_collab_applications', 'ugc',          'TEXT DEFAULT ""'],
  ];
  for (const [tbl, col, def] of cols) {
    try { await client.execute(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`); }
    catch(e) { /* already exists — ok */ }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token || token !== process.env.WL_ADMIN_TOKEN)
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    const client = createClient({
      url:       process.env.TURSO_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });

    await ensureTables(client);

    /* ── GET: list all ── */
    if (req.method === 'GET') {
      const [wl, warn, collab] = await Promise.all([
        client.execute(`SELECT id, x_handle, eth_address, community, rt_link, comment_link, status, created_at FROM yc_whitelist ORDER BY created_at DESC`),
        client.execute(`SELECT id, eth_address, x_handle, reason, created_at FROM yc_wl_warnings ORDER BY created_at DESC`),
        client.execute(`SELECT id, twitter_link, community_description, support_offer, main_contact, collab_tweet, ugc, status, created_at FROM yc_collab_applications ORDER BY created_at DESC`),
      ]);

      return res.status(200).json({
        entries:  wl.rows.map(r => ({
          id:r[0], x_handle:r[1], eth_address:r[2], community:r[3],
          rt_link:r[4], comment_link:r[5], status:r[6], created_at:r[7]
        })),
        warnings: warn.rows.map(r => ({
          id:r[0], eth_address:r[1], x_handle:r[2], reason:r[3], created_at:r[4]
        })),
        collabs: collab.rows.map(r => ({
          id:r[0], twitter_link:r[1], community_description:r[2], support_offer:r[3],
          main_contact:r[4], collab_tweet:r[5], ugc:r[6], status:r[7], created_at:r[8]
        })),
      });
    }

    /* ── POST: update status ── */
    if (req.method === 'POST') {
      const { id, status, table } = req.body || {};
      if (!id || !VALID.includes(status))
        return res.status(400).json({ error: 'Invalid id or status' });

      const tbl = table === 'collab' ? 'yc_collab_applications' : 'yc_whitelist';
      const r = await client.execute({
        sql: `UPDATE ${tbl} SET status = ? WHERE id = ?`,
        args: [status, id]
      });
      if (r.rowsAffected === 0) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[wl-list] ERROR:', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};