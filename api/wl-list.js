// api/wl-list.js — uses Turso HTTP API (no WebSocket, no connection pool issues)

const VALID = ['pending', 'approved', 'rejected'];

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
  if (typeof v === 'number') return { type: 'integer', value: String(v) };
  return { type: 'text', value: String(v) };
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

  /* ── GET ── */
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

  /* ── POST ── */
  if (req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { id, status, table } = body;
      if (!id || !VALID.includes(status))
        return res.status(400).json({ error: 'Invalid id or status' });
      const tbl = table === 'collab' ? 'yc_collab_applications' : 'yc_whitelist';
      await turso([{ sql: `UPDATE ${tbl} SET status = ? WHERE id = ?`, args: [arg(status), arg(id)] }]);
      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}