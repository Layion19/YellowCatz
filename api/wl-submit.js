// api/wl-submit.js
import { createClient } from '@libsql/client';

async function parseBody(req) {
  let raw = '';
  await new Promise(resolve => {
    req.on('data', c => { raw += c; });
    req.on('end', resolve);
  });
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const body = await parseBody(req);
  const { type } = body;
  if (!type) return res.status(400).json({ error: 'Missing type' });

  try {
    const db = createClient({
      url:       process.env.TURSO_DATABASE_URL || process.env.TURSO_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });

    async function addCol(table, col, def) {
      try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
      catch(e) { /* already exists */ }
    }

    /* ── WHITELIST ── */
    if (type === 'whitelist') {
      const { x_handle, eth_address, community, rt_link, comment_link } = body;

      if (!x_handle || !eth_address)
        return res.status(400).json({ error: 'Missing required fields' });
      if (!/^0x[0-9a-fA-F]{40,}$/.test(eth_address.trim()))
        return res.status(400).json({ error: 'Invalid ETH address' });

      const handle = x_handle.toLowerCase().trim();
      const eth    = eth_address.toLowerCase().trim();

      await db.execute(`CREATE TABLE IF NOT EXISTS yc_whitelist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        x_handle TEXT NOT NULL UNIQUE,
        eth_address TEXT NOT NULL UNIQUE,
        community TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      await addCol('yc_whitelist', 'rt_link',      "TEXT DEFAULT ''");
      await addCol('yc_whitelist', 'comment_link', "TEXT DEFAULT ''");

      await db.execute(`CREATE TABLE IF NOT EXISTS yc_wl_warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        eth_address TEXT NOT NULL,
        x_handle TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`);

      const dupHandle = await db.execute({ sql: 'SELECT id FROM yc_whitelist WHERE x_handle = ? LIMIT 1', args: [handle] });
      if (dupHandle.rows.length > 0) return res.status(409).json({ error: 'Already registered' });

      const dupEth = await db.execute({ sql: 'SELECT id FROM yc_whitelist WHERE eth_address = ? LIMIT 1', args: [eth] });
      if (dupEth.rows.length > 0) {
        await db.execute({ sql: 'INSERT INTO yc_wl_warnings (eth_address, x_handle, reason) VALUES (?,?,?)', args: [eth, handle, 'ETH already registered with different X handle'] });
        return res.status(409).json({ error: 'Already registered' });
      }

      await db.execute({
        sql:  'INSERT INTO yc_whitelist (x_handle, eth_address, community, rt_link, comment_link) VALUES (?,?,?,?,?)',
        args: [handle, eth, (community||'').trim(), (rt_link||'').trim(), (comment_link||'').trim()]
      });
      return res.status(200).json({ success: true });
    }

    /* ── COLLAB ── */
    if (type === 'collab') {
      const { twitter_link, community_description, support_offer, main_contact, collab_tweet } = body;

      if (!twitter_link || !community_description || !support_offer || !main_contact || !collab_tweet)
        return res.status(400).json({ error: 'All fields are required' });

      await db.execute(`CREATE TABLE IF NOT EXISTS yc_collab_applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        twitter_link TEXT NOT NULL,
        community_description TEXT NOT NULL,
        support_offer TEXT NOT NULL,
        main_contact TEXT NOT NULL,
        collab_tweet TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      await addCol('yc_collab_applications', 'ugc', "TEXT DEFAULT ''");

      await db.execute({
        sql:  'INSERT INTO yc_collab_applications (twitter_link, community_description, support_offer, main_contact, collab_tweet) VALUES (?,?,?,?,?)',
        args: [twitter_link.trim(), community_description.trim(), support_offer.trim(), main_contact.trim(), collab_tweet.trim()]
      });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid type' });

  } catch (err) {
    console.error('[wl-submit] ERROR:', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}