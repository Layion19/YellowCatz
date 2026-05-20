// api/wl-list.js
// GET  /api/wl-list  → retourne entries + warnings (admin)
// POST /api/wl-list  → met à jour le status d'une entrée

const { createClient } = require('@libsql/client');

const VALID = ['pending', 'approved', 'rejected'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth — token distinct de NFT_ADMIN_TOKEN
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token || token !== process.env.WL_ADMIN_TOKEN)
    return res.status(401).json({ error: 'Unauthorized' });

  const client = createClient({
    url:       process.env.TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  try {
    /* ── GET: list everything ── */
    if (req.method === 'GET') {
      const [eRes, wRes] = await Promise.all([
        client.execute(
          `SELECT id, x_handle, eth_address, community, rt_link, comment_link, status, created_at
           FROM yc_whitelist ORDER BY created_at DESC`
        ),
        client.execute(
          `SELECT id, eth_address, x_handle, reason, created_at
           FROM yc_wl_warnings ORDER BY created_at DESC`
        ),
      ]);

      const entries = eRes.rows.map(r => ({
        id:           r[0],
        x_handle:     r[1],
        eth_address:  r[2],
        community:    r[3],
        rt_link:      r[4],
        comment_link: r[5],
        status:       r[6],
        created_at:   r[7],
      }));

      const warnings = wRes.rows.map(r => ({
        id:          r[0],
        eth_address: r[1],
        x_handle:    r[2],
        reason:      r[3],
        created_at:  r[4],
      }));

      return res.status(200).json({ entries, warnings });
    }

    /* ── POST: update status ── */
    if (req.method === 'POST') {
      const { id, status } = req.body || {};
      if (!id || !VALID.includes(status))
        return res.status(400).json({ error: 'Invalid id or status' });

      const r = await client.execute({
        sql:  'UPDATE yc_whitelist SET status = ? WHERE id = ?',
        args: [status, id],
      });

      if (r.rowsAffected === 0)
        return res.status(404).json({ error: 'Entry not found' });

      return res.status(200).json({ success: true, id, status });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[wl-list]', err);
    return res.status(500).json({ error: 'Database error' });
  }
};