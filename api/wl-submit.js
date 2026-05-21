// api/wl-submit.js
// POST /api/wl-submit
// type: 'whitelist' → yc_whitelist
// type: 'collab'    → yc_collab_applications

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

const CREATE_COLLAB = `
  CREATE TABLE IF NOT EXISTS yc_collab_applications (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    twitter_link          TEXT NOT NULL,
    community_description TEXT NOT NULL,
    support_offer         TEXT NOT NULL,
    main_contact          TEXT NOT NULL,
    collab_tweet          TEXT DEFAULT '',
    status                TEXT DEFAULT 'pending',
    created_at            TEXT DEFAULT (datetime('now'))
  )`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { type } = req.body || {};

  const client = createClient({
    url:       process.env.TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  try {
    /* ── WHITELIST ── */
    if (type === 'whitelist') {
      const { x_handle, eth_address, community, rt_link, comment_link } = req.body;
      if (!x_handle || !eth_address)
        return res.status(400).json({ error: 'Missing required fields' });
      if (!/^0x[0-9a-fA-F]{40,}$/.test(eth_address))
        return res.status(400).json({ error: 'Invalid ETH address' });

      const handle = x_handle.toLowerCase().trim();
      const eth    = eth_address.toLowerCase().trim();

      await client.execute(CREATE_WL);
      await client.execute(CREATE_WARN);

      const dupHandle = await client.execute({
        sql: 'SELECT id FROM yc_whitelist WHERE x_handle = ? LIMIT 1', args: [handle]
      });
      if (dupHandle.rows.length > 0)
        return res.status(409).json({ error: 'Already registered' });

      const dupEth = await client.execute({
        sql: 'SELECT id FROM yc_whitelist WHERE eth_address = ? LIMIT 1', args: [eth]
      });
      if (dupEth.rows.length > 0) {
        await client.execute({
          sql: 'INSERT INTO yc_wl_warnings (eth_address, x_handle, reason) VALUES (?,?,?)',
          args: [eth, handle, 'ETH address already registered with a different X handle']
        });
        return res.status(409).json({ error: 'Already registered' });
      }

      await client.execute({
        sql:  'INSERT INTO yc_whitelist (x_handle, eth_address, community, rt_link, comment_link) VALUES (?,?,?,?,?)',
        args: [handle, eth, (community||'').trim(), (rt_link||'').trim(), (comment_link||'').trim()]
      });
      return res.status(200).json({ success: true });
    }

    /* ── COLLAB ── */
    if (type === 'collab') {
      const { twitter_link, community_description, support_offer, main_contact, collab_tweet } = req.body;
      if (!twitter_link || !community_description || !support_offer || !main_contact || !collab_tweet)
        return res.status(400).json({ error: 'All fields are required' });

      await client.execute(CREATE_COLLAB);

      await client.execute({
        sql:  'INSERT INTO yc_collab_applications (twitter_link, community_description, support_offer, main_contact, collab_tweet) VALUES (?,?,?,?,?)',
        args: [twitter_link.trim(), community_description.trim(), support_offer.trim(), main_contact.trim(), collab_tweet.trim()]
      });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid type' });

  } catch (err) {
    console.error('[wl-submit]', err);
    return res.status(500).json({ error: 'Database error' });
  }
};