// api/wl-list.js — Turso HTTP API (no WebSocket, no connection pool issues)

const VALID = ['pending', 'approved', 'rejected'];
const ORIGINAL_TWEET = '2059314295330963703';
const BOT_PREFIXES = ['user_yc_', 'yellowcatz_farmer_', 'yc_user_', 'yc_wl_'];
const MAX_REAL_ID = 3_000_000_000_000_000_000n;
const VOWELS = new Set('aeiou');

// ── Turso HTTP helper ──────────────────────────────────────────
async function turso(statements) {
  const baseUrl = (process.env.TURSO_DATABASE_URL || '').replace('libsql://', 'https://');
  const res = await fetch(`${baseUrl}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.TURSO_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        ...statements.map(s => ({ type: 'execute', stmt: s })),
        { type: 'close' }
      ]
    })
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
  if (typeof v === 'number' || typeof v === 'bigint') return { type: 'integer', value: String(v) };
  return { type: 'text', value: String(v) };
}

async function tursoExec(sql, args = []) {
  const baseUrl = (process.env.TURSO_DATABASE_URL || '').replace('libsql://', 'https://');
  const res = await fetch(`${baseUrl}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.TURSO_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        { type: 'execute', stmt: { sql, args } },
        { type: 'close' }
      ]
    })
  });
  const data = await res.json();
  if (data.results[0].type === 'error') throw new Error(data.results[0].error?.message);
  return data.results[0].response.result;
}

// ── Bot detection helpers ──────────────────────────────────────
function isFakeId(url) {
  return [...(url||'').matchAll(/\/status\/(\d+)/g)].some(m => {
    try { return BigInt(m[1]) > MAX_REAL_ID; } catch { return false; }
  });
}

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

// ── Body parser ────────────────────────────────────────────────
async function parseBody(req) {
  let raw = '';
  await new Promise(r => { req.on('data', c => { raw += c; }); req.on('end', r); });
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

// ── Handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token || token !== process.env.WL_ADMIN_TOKEN)
    return res.status(401).json({ error: 'Unauthorized' });

  /* ── GET — list all ── */
  if (req.method === 'GET') {
    try {
      const [wl, warn, collab] = await turso([
        { sql: 'SELECT id, x_handle, eth_address, community, rt_link, comment_link, status, created_at FROM yc_whitelist ORDER BY created_at DESC' },
        { sql: 'SELECT id, eth_address, x_handle, reason, created_at FROM yc_wl_warnings ORDER BY created_at DESC' },
        { sql: 'SELECT id, twitter_link, community_description, support_offer, main_contact, collab_tweet, status, created_at FROM yc_collab_applications ORDER BY created_at DESC' },
      ]);
      return res.status(200).json({ entries: wl, warnings: warn, collabs: collab });
    } catch(e) {
      console.error('[wl-list GET]', e.message);
      return res.status(200).json({ entries: [], warnings: [], collabs: [] });
    }
  }

  if (req.method === 'POST') {
    const body = await parseBody(req);

    /* ── PURGE BOTS ── */
    if (body.action === 'purge_bots') {
      try {
        let deleted = 0;

        // PHASE 1 — SQL level
        for (const p of BOT_PREFIXES) {
          const r = await tursoExec(`DELETE FROM yc_whitelist WHERE LOWER(x_handle) LIKE ?`, [arg(`${p}%`)]);
          deleted += r.rows_affected || 0;
        }
        const r2 = await tursoExec(`DELETE FROM yc_whitelist WHERE rt_link = comment_link AND rt_link != '' AND rt_link IS NOT NULL`);
        deleted += r2.rows_affected || 0;

        const r3 = await tursoExec(`DELETE FROM yc_whitelist WHERE comment_link LIKE ?`, [arg(`%${ORIGINAL_TWEET}%`)]);
        deleted += r3.rows_affected || 0;

        const r4 = await tursoExec(`DELETE FROM yc_whitelist WHERE x_handle LIKE '%.com%' OR x_handle LIKE '%@%@%'`);
        deleted += r4.rows_affected || 0;

        // PHASE 2 — App level
        const [all] = await turso([{ sql: 'SELECT id, x_handle, rt_link, comment_link FROM yc_whitelist' }]);
        const toDelete = new Set();

        for (const r of all) {
          if (isFakeId(r.rt_link) || isFakeId(r.comment_link)) toDelete.add(r.id);
        }

        const baseGroups = {};
        for (const r of all) {
          const base = (r.x_handle||'').toLowerCase().replace('@','').replace(/\d+$/, '');
          if (base.length >= 3) {
            if (!baseGroups[base]) baseGroups[base] = [];
            baseGroups[base].push(r.id);
          }
        }
        for (const ids of Object.values(baseGroups)) {
          if (ids.length >= 2) ids.forEach(id => toDelete.add(id));
        }

        for (const r of all) {
          if (isRandom(r.x_handle)) toDelete.add(r.id);
        }

        // Batch delete 300 at a time
        const idList = Array.from(toDelete);
        for (let i = 0; i < idList.length; i += 300) {
          const batch = idList.slice(i, i + 300);
          const ph = batch.map(() => '?').join(',');
          const r = await tursoExec(`DELETE FROM yc_whitelist WHERE id IN (${ph})`, batch.map(arg));
          deleted += r.rows_affected || 0;
        }

        await tursoExec('DELETE FROM yc_wl_warnings');

        return res.status(200).json({ success: true, deleted });
      } catch(e) {
        console.error('[purge_bots]', e.message);
        return res.status(500).json({ error: e.message });
      }
    }

    /* ── UPDATE STATUS ── */
    try {
      const { id, status, table } = body;
      if (!id || !VALID.includes(status)) return res.status(400).json({ error: 'Invalid id or status' });
      const tbl = table === 'collab' ? 'yc_collab_applications' : 'yc_whitelist';
      await tursoExec(`UPDATE ${tbl} SET status = ? WHERE id = ?`, [arg(status), arg(id)]);
      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}