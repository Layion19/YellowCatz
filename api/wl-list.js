import { createClient } from '@libsql/client';

const VALID = ['pending', 'approved', 'rejected'];

async function parseBody(req) {
  let raw = '';
  await new Promise(r => { req.on('data', c => { raw += c; }); req.on('end', r); });
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token || token !== process.env.WL_ADMIN_TOKEN)
    return res.status(401).json({ error: 'Unauthorized' });

  const db = createClient({
    url:       process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  try {
    /* ── GET ── */
    if (req.method === 'GET') {
      const [wl, warn, collab] = await Promise.all([
        db.execute('SELECT id, x_handle, eth_address, community, rt_link, comment_link, status, created_at FROM yc_whitelist ORDER BY created_at DESC'),
        db.execute('SELECT id, eth_address, x_handle, reason, created_at FROM yc_wl_warnings ORDER BY created_at DESC'),
        db.execute('SELECT id, twitter_link, community_description, support_offer, main_contact, collab_tweet, status, created_at FROM yc_collab_applications ORDER BY created_at DESC'),
      ]);
      return res.status(200).json({
        entries:  wl.rows.map(r => ({ id:r.id, x_handle:r.x_handle, eth_address:r.eth_address, community:r.community, rt_link:r.rt_link, comment_link:r.comment_link, status:r.status, created_at:r.created_at })),
        warnings: warn.rows.map(r => ({ id:r.id, eth_address:r.eth_address, x_handle:r.x_handle, reason:r.reason, created_at:r.created_at })),
        collabs:  collab.rows.map(r => ({ id:r.id, twitter_link:r.twitter_link, community_description:r.community_description, support_offer:r.support_offer, main_contact:r.main_contact, collab_tweet:r.collab_tweet, status:r.status, created_at:r.created_at })),
      });
    }

    /* ── POST ── */
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const { id, status, table } = body;
      if (!id || !VALID.includes(status))
        return res.status(400).json({ error: 'Invalid id or status' });
      const tbl = table === 'collab' ? 'yc_collab_applications' : 'yc_whitelist';
      await db.execute({ sql: `UPDATE ${tbl} SET status = ? WHERE id = ?`, args: [status, id] });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch(e) {
    console.error('[wl-list]', e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    db.close();
  }
}