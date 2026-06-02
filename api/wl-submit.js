// api/wl-submit.js — uses Turso HTTP API

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

// ── Bot detection ──────────────────────────────────────────────
const BOT_PREFIXES   = ['user_yc_', 'yellowcatz_farmer_', 'yc_user_', 'yc_wl_'];
const ORIGINAL_TWEET = '2059314295330963703';
const VOWELS         = new Set('aeiou');

function isFakeId(url) {
  return [...(url||'').matchAll(/\/status\/(\d+)/g)].some(m => {
    try { return BigInt(m[1]) > 3000000000000000000n; } catch { return false; }
  });
}

function isRandomHandle(handle) {
  const h = handle.toLowerCase().replace('@','').trim();
  const letters = h.replace(/[^a-z]/g,'');
  if (letters.length < 5) return false;
  const vowelRatio  = [...letters].filter(c => VOWELS.has(c)).length / letters.length;
  const maxConsec   = Math.max(0, ...[...letters.matchAll(/[bcdfghjklmnpqrstvwxyz]{5,}/g)].map(m => m[0].length));
  const numsMiddle  = /[a-z]{2,}\d+[a-z]{2,}/.test(h);
  const isEmail     = h.includes('.com') || handle.split('@').length > 2;
  return isEmail || maxConsec >= 5 || (vowelRatio < 0.10 && letters.length >= 6) || (numsMiddle && vowelRatio < 0.20);
}

function detectBot(handle, rt_link, comment_link) {
  const h = handle.toLowerCase().replace('@','').trim();

  // Bot username prefix
  if (BOT_PREFIXES.some(p => h.startsWith(p)))
    return 'Bot account detected';

  // Email in username
  if (handle.includes('.com') || handle.split('@').length > 2)
    return 'Invalid username format';

  // Fake tweet IDs
  if (isFakeId(rt_link) || isFakeId(comment_link))
    return 'Invalid tweet links';

  // Random/meaningless username
  if (isRandomHandle(handle))
    return 'Username does not appear to be a valid X account';

  return null; // all good
}

async function parseBody(req) {
  let raw = '';
  await new Promise(resolve => { req.on('data', c => { raw += c; }); req.on('end', resolve); });
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = await parseBody(req);
  const { type } = body;
  if (!type) return res.status(400).json({ error: 'Missing type' });

  try {
    if (type === 'whitelist') {
      const { x_handle, eth_address, community, rt_link, comment_link } = body;
      if (!x_handle || !eth_address) return res.status(400).json({ error: 'Missing required fields' });
      if (!/^0x[0-9a-fA-F]{40,}$/.test(eth_address.trim())) return res.status(400).json({ error: 'Invalid ETH address' });

      const handle = x_handle.toLowerCase().trim();
      const eth    = eth_address.toLowerCase().trim();

      // ── Bot detection (auto-reject) ──
      const botReason = detectBot(x_handle, rt_link, comment_link);
      if (botReason) return res.status(400).json({ error: botReason });

      // ── Sequential username check ──
      const base = handle.replace('@','').replace(/\d+$/, '');
      if (base.length >= 3) {
        const [similar] = await turso([{
          sql: `SELECT COUNT(*) as cnt FROM yc_whitelist WHERE LOWER(x_handle) LIKE ? AND LOWER(x_handle) != ?`,
          args: [arg(`%${base}%`), arg(handle.replace('@',''))]
        }]);
        if (parseInt(similar[0]?.cnt || 0) >= 1)
          return res.status(400).json({ error: 'Username does not appear to be a valid X account' });
      }
      await turso([
        { sql: `CREATE TABLE IF NOT EXISTS yc_whitelist (id INTEGER PRIMARY KEY AUTOINCREMENT, x_handle TEXT NOT NULL UNIQUE, eth_address TEXT NOT NULL UNIQUE, community TEXT DEFAULT '', status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))` },
        { sql: `CREATE TABLE IF NOT EXISTS yc_wl_warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, eth_address TEXT NOT NULL, x_handle TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))` },
      ]);

      // Add columns if missing (ignore errors)
      try { await turso([{ sql: `ALTER TABLE yc_whitelist ADD COLUMN rt_link TEXT DEFAULT ''` }]); } catch(e) {}
      try { await turso([{ sql: `ALTER TABLE yc_whitelist ADD COLUMN comment_link TEXT DEFAULT ''` }]); } catch(e) {}

      // Check blacklist
      const [blocked] = await turso([{ sql: `SELECT id FROM yc_blocked WHERE eth_address = ? OR LOWER(x_handle) = ? LIMIT 1`,
        args: [arg(eth), arg(handle)] }]);
      if (blocked.length > 0) return res.status(403).json({ error: 'Submission not accepted' });

      // Check duplicates
      const [dupH] = await turso([{ sql: 'SELECT id FROM yc_whitelist WHERE x_handle = ? LIMIT 1', args: [arg(handle)] }]);
      if (dupH.length > 0) return res.status(409).json({ error: 'Already registered' });

      const [dupE] = await turso([{ sql: 'SELECT id FROM yc_whitelist WHERE eth_address = ? LIMIT 1', args: [arg(eth)] }]);
      if (dupE.length > 0) {
        await turso([{ sql: 'INSERT INTO yc_wl_warnings (eth_address, x_handle, reason) VALUES (?,?,?)', args: [arg(eth), arg(handle), arg('ETH already registered with different X handle')] }]);
        return res.status(409).json({ error: 'Already registered' });
      }

      await turso([{ sql: 'INSERT INTO yc_whitelist (x_handle, eth_address, community, rt_link, comment_link) VALUES (?,?,?,?,?)', args: [arg(handle), arg(eth), arg((community||'').trim()), arg((rt_link||'').trim()), arg((comment_link||'').trim())] }]);
      return res.status(200).json({ success: true });
    }

    if (type === 'collab') {
      const { twitter_link, community_description, support_offer, main_contact, collab_tweet } = body;
      if (!twitter_link || !community_description || !support_offer || !main_contact || !collab_tweet)
        return res.status(400).json({ error: 'All fields are required' });

      await turso([{ sql: `CREATE TABLE IF NOT EXISTS yc_collab_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, twitter_link TEXT NOT NULL, community_description TEXT NOT NULL, support_offer TEXT NOT NULL, main_contact TEXT NOT NULL, collab_tweet TEXT DEFAULT '', status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))` }]);
      await turso([{ sql: 'INSERT INTO yc_collab_applications (twitter_link, community_description, support_offer, main_contact, collab_tweet) VALUES (?,?,?,?,?)', args: [arg(twitter_link.trim()), arg(community_description.trim()), arg(support_offer.trim()), arg(main_contact.trim()), arg(collab_tweet.trim())] }]);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid type' });

  } catch(err) {
    console.error('[wl-submit]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}