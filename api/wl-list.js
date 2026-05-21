// api/wl-list.js
// GET  → returns whitelist entries + warnings + collab applications
// POST → update status of whitelist OR collab entry

const { createClient } = require('@libsql/client');
const VALID = ['pending', 'approved', 'rejected'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token || token !== process.env.WL_ADMIN_TOKEN)
    return res.status(401).json({ error: 'Unauthorized' });

  const client = createClient({
    url:       process.env.TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  try {
    if (req.method === 'GET') {
      const [wl, warn, collab] = await Promise.all([
        client.execute(`SELECT id, x_handle, eth_address, community, rt_link, comment_link, status, created_at FROM yc_whitelist ORDER BY created_at DESC`),
        client.execute(`SELECT id, eth_address, x_handle, reason, created_at FROM yc_wl_warnings ORDER BY created_at DESC`),
        client.execute(`SELECT id, twitter_link, community_description, support_offer, main_contact, collab_tweet, status, created_at FROM yc_collab_applications ORDER BY created_at DESC`),
      ]);

      return res.status(200).json({
        entries:  wl.rows.map(r => ({ id:r[0], x_handle:r[1], eth_address:r[2], community:r[3], rt_link:r[4], comment_link:r[5], status:r[6], created_at:r[7] })),
        warnings: warn.rows.map(r => ({ id:r[0], eth_address:r[1], x_handle:r[2], reason:r[3], created_at:r[4] })),
        collabs:  collab.rows.map(r => ({ id:r[0], twitter_link:r[1], community_description:r[2], support_offer:r[3], main_contact:r[4], collab_tweet:r[5], status:r[6], created_at:r[7] })),
      });
    }

    if (req.method === 'POST') {
      const { id, status, table } = req.body || {};
      if (!id || !VALID.includes(status))
        return res.status(400).json({ error: 'Invalid id or status' });

      const tbl = table === 'collab' ? 'yc_collab_applications' : 'yc_whitelist';
      const r = await client.execute({ sql: `UPDATE ${tbl} SET status=? WHERE id=?`, args: [status, id] });
      if (r.rowsAffected === 0) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[wl-list]', err);
    return res.status(500).json({ error: 'Database error' });
  }
};