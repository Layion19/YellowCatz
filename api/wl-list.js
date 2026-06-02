import { createClient } from '@libsql/client';

const VALID = ['pending', 'approved', 'rejected'];
const ORIGINAL_TWEET = '2059314295330963703';
const BOT_PREFIXES = ['user_yc_', 'yellowcatz_farmer_', 'yc_user_', 'yc_wl_'];
const MAX_REAL_ID = 3_000_000_000_000_000_000n; // fake if > 3e18
const VOWELS = new Set('aeiou');

function isRandom(handle) {
  const h = handle.toLowerCase().replace('@','').trim();
  const letters = h.replace(/[^a-z]/g,'');
  if (letters.length < 5) return false;
  const vowelRatio = [...letters].filter(c => VOWELS.has(c)).length / letters.length;
  const maxConsec = Math.max(0, ...[...letters.matchAll(/[bcdfghjklmnpqrstvwxyz]{5,}/g)].map(m => m[0].length));
  const isEmail = h.includes('.com') || handle.split('@').length > 2;
  const numsMiddle = /[a-z]{2,}\d+[a-z]{2,}/.test(h);
  return isEmail || maxConsec >= 5 || (vowelRatio < 0.10 && letters.length >= 6) || (numsMiddle && vowelRatio < 0.20);
}

function isFakeId(url) {
  return [...(url||'').matchAll(/\/status\/(\d+)/g)].some(m => {
    try { return BigInt(m[1]) > MAX_REAL_ID; } catch { return false; }
  });
}

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

  const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

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

    if (req.method === 'POST') {
      const body = await parseBody(req);

      /* ── PURGE BOTS ── */
      if (body.action === 'purge_bots') {
        let deleted = 0;

        // PHASE 1 — SQL level (fast, handles bulk)
        for (const p of BOT_PREFIXES) {
          const r = await db.execute({ sql: `DELETE FROM yc_whitelist WHERE LOWER(x_handle) LIKE ?`, args: [`${p}%`] });
          deleted += r.rowsAffected || 0;
        }
        const r2 = await db.execute(`DELETE FROM yc_whitelist WHERE rt_link = comment_link AND rt_link != '' AND rt_link IS NOT NULL`);
        deleted += r2.rowsAffected || 0;
        const r3 = await db.execute({ sql: `DELETE FROM yc_whitelist WHERE comment_link LIKE ?`, args: [`%${ORIGINAL_TWEET}%`] });
        deleted += r3.rowsAffected || 0;
        // Email addresses
        const r4 = await db.execute(`DELETE FROM yc_whitelist WHERE x_handle LIKE '%.com%' OR x_handle LIKE '%@%.%'`);
        deleted += r4.rowsAffected || 0;

        // PHASE 2 — App level (fake IDs + sequential + random)
        const all = await db.execute('SELECT id, x_handle, rt_link, comment_link FROM yc_whitelist');
        const toDelete = new Set();

        // Fake tweet IDs
        for (const r of all.rows) {
          if (isFakeId(r.rt_link) || isFakeId(r.comment_link)) toDelete.add(r.id);
        }

        // Sequential usernames (2+ with same base)
        const baseGroups = {};
        for (const r of all.rows) {
          const base = (r.x_handle||'').toLowerCase().replace('@','').replace(/\d+$/, '');
          if (base.length >= 3) {
            if (!baseGroups[base]) baseGroups[base] = [];
            baseGroups[base].push(r.id);
          }
        }
        for (const ids of Object.values(baseGroups)) {
          if (ids.length >= 2) ids.forEach(id => toDelete.add(id));
        }

        // Random/meaningless usernames
        for (const r of all.rows) {
          if (isRandom(r.x_handle)) toDelete.add(r.id);
        }

        // Batch delete (300 per query to stay fast)
        const idList = Array.from(toDelete);
        for (let i = 0; i < idList.length; i += 300) {
          const batch = idList.slice(i, i + 300);
          const ph = batch.map(() => '?').join(',');
          const r = await db.execute({ sql: `DELETE FROM yc_whitelist WHERE id IN (${ph})`, args: batch });
          deleted += r.rowsAffected || 0;
        }

        // Clear warnings
        await db.execute('DELETE FROM yc_wl_warnings');

        return res.status(200).json({ success: true, deleted });
      }

      /* ── UPDATE STATUS ── */
      const { id, status, table } = body;
      if (!id || !VALID.includes(status)) return res.status(400).json({ error: 'Invalid id or status' });
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