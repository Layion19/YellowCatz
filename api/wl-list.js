// api/wl-list.js — Turso HTTP API

const VALID = ['pending', 'approved', 'rejected'];
const ORIGINAL_TWEET = '2059314295330963703';
const BOT_PREFIXES = ['user_yc_', 'yellowcatz_farmer_', 'yc_user_', 'yc_wl_'];
const VOWELS = new Set('aeiou');

async function tursoHttp(statements) {
  const url = (process.env.TURSO_DATABASE_URL || '').replace('libsql://', 'https://');
  const res = await fetch(`${url}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.TURSO_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [...statements.map(s => ({ type: 'execute', stmt: s })), { type: 'close' }] })
  });
  const data = await res.json();
  return data.results.slice(0, statements.length).map(r => {
    if (r.type === 'error') throw new Error(r.error?.message || 'DB error');
    const cols = r.response.result.cols.map(c => c.name);
    return r.response.result.rows.map(row => {
      const obj = {};
      cols.forEach((col, i) => { obj[col] = row[i]?.value ?? null; });
      return obj;
    });
  });
}

function arg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return { type: 'integer', value: String(v) };
  return { type: 'text', value: String(v) };
}

function isFakeId(url) {
  const matches = [...(url||'').matchAll(/\/status\/(\d+)/g)];
  return matches.some(m => {
    try { return BigInt(m[1]) > 3000000000000000000n; } catch { return false; }
  });
}

function isRandom(handle) {
  const h = handle.toLowerCase().replace('@','');
  const letters = h.replace(/[^a-z]/g,'');
  if (letters.length < 5) return false;
  const vowelRatio = [...letters].filter(c => VOWELS.has(c)).length / letters.length;
  const maxConsec = Math.max(0, ...[...letters.matchAll(/[bcdfghjklmnpqrstvwxyz]{5,}/g)].map(m => m[0].length));
  const numsMiddle = /[a-z]{2,}\d+[a-z]{2,}/.test(h);
  return maxConsec >= 5 || (vowelRatio < 0.10 && letters.length >= 6) || (numsMiddle && vowelRatio < 0.20);
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

  /* ── GET — limited to 500 most recent for fast login ── */
  if (req.method === 'GET') {
    try {
      const [wl, warn, collab, counts] = await tursoHttp([
        { sql: 'SELECT id, x_handle, eth_address, community, rt_link, comment_link, status, created_at FROM yc_whitelist ORDER BY created_at DESC LIMIT 500' },
        { sql: 'SELECT id, eth_address, x_handle, reason, created_at FROM yc_wl_warnings ORDER BY created_at DESC LIMIT 200' },
        { sql: 'SELECT id, twitter_link, community_description, support_offer, main_contact, collab_tweet, status, created_at FROM yc_collab_applications ORDER BY created_at DESC LIMIT 500' },
        { sql: 'SELECT (SELECT COUNT(*) FROM yc_whitelist) as wl_total, (SELECT COUNT(*) FROM yc_collab_applications) as collab_total' },
      ]);
      return res.status(200).json({
        entries: wl, warnings: warn, collabs: collab,
        totalWL: counts[0]?.wl_total || 0,
        totalCollab: counts[0]?.collab_total || 0,
      });
    } catch(e) {
      console.error('[wl-list GET]', e.message);
      return res.status(200).json({ entries: [], warnings: [], collabs: [], totalWL: 0, totalCollab: 0 });
    }
  }

  if (req.method === 'POST') {
    const body = await parseBody(req);

    /* ── PURGE BOTS — SQL only, completes in < 2s ── */
    if (body.action === 'purge_bots') {
      try {
        let deleted = 0;
        const rules = [
          ...BOT_PREFIXES.map(p => ({ sql: `DELETE FROM yc_whitelist WHERE LOWER(x_handle) LIKE ?`, args: [arg(`${p}%`)] })),
          { sql: `DELETE FROM yc_whitelist WHERE rt_link = comment_link AND rt_link != '' AND rt_link IS NOT NULL` },
          { sql: `DELETE FROM yc_whitelist WHERE comment_link LIKE ?`, args: [arg(`%${ORIGINAL_TWEET}%`)] },
          { sql: `DELETE FROM yc_whitelist WHERE x_handle LIKE '%.com%' OR instr(x_handle, '@') > 1` },
          { sql: `DELETE FROM yc_whitelist WHERE LOWER(x_handle) REGEXP '^@?[^aeiou]{6,}$'` },
        ];
        for (const rule of rules) {
          try {
            const url = (process.env.TURSO_DATABASE_URL || '').replace('libsql://', 'https://');
            const r = await fetch(`${url}/v2/pipeline`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${process.env.TURSO_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ requests: [{ type: 'execute', stmt: rule }, { type: 'close' }] })
            });
            const d = await r.json();
            deleted += d.results?.[0]?.response?.result?.rows_affected || 0;
          } catch(e) { /* ignore individual rule errors */ }
        }
        await tursoHttp([{ sql: 'DELETE FROM yc_wl_warnings' }]);
        return res.status(200).json({ success: true, deleted });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    /* ── BLOCK ENTRY (delete + blacklist) ── */
    if (body.action === 'block_entry') {
      try {
        const { id, table } = body;
        const tbl = table === 'collab' ? 'yc_collab_applications' : 'yc_whitelist';

        // Create blacklist table if needed
        await tursoHttp([{ sql: `CREATE TABLE IF NOT EXISTS yc_blocked (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          eth_address TEXT,
          x_handle TEXT,
          reason TEXT DEFAULT 'blocked_by_admin',
          created_at TEXT DEFAULT (datetime('now'))
        )` }]);

        // Get entry data before deleting
        const [rows] = await tursoHttp([{ sql: `SELECT * FROM ${tbl} WHERE id = ?`, args: [arg(id)] }]);
        if (rows.length > 0) {
          const entry = rows[0];
          const eth = entry.eth_address || null;
          const handle = entry.x_handle || entry.twitter_link || null;
          // Add to blacklist
          await tursoHttp([{ sql: `INSERT OR IGNORE INTO yc_blocked (eth_address, x_handle) VALUES (?, ?)`,
            args: [arg(eth), arg(handle)] }]);
        }

        // Delete entry
        await tursoHttp([{ sql: `DELETE FROM ${tbl} WHERE id = ?`, args: [arg(id)] }]);
        return res.status(200).json({ success: true });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }
    if (body.action === 'delete_entry') {
      try {
        const { id, table } = body;
        const tbl = table === 'collab' ? 'yc_collab_applications' : 'yc_whitelist';
        await tursoHttp([{ sql: `DELETE FROM ${tbl} WHERE id = ?`, args: [arg(id)] }]);
        return res.status(200).json({ success: true });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    /* ── UPDATE STATUS ── */
    try {
      const { id, status, table } = body;
      if (!id || !VALID.includes(status)) return res.status(400).json({ error: 'Invalid' });
      const tbl = table === 'collab' ? 'yc_collab_applications' : 'yc_whitelist';
      await tursoHttp([{ sql: `UPDATE ${tbl} SET status = ? WHERE id = ?`, args: [arg(status), arg(id)] }]);
      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}