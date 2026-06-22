// ============================================================
//  api/holder-wl.js — soumission PUBLIQUE d'un holder $YC
//  (la vue/gestion admin est dans /api/admin, action holderWL*)
//
//  ZÉRO dépendance externe hors @libsql/client (déjà dans ton repo) :
//   - vérif signature Solana = crypto natif Node (ed25519) + base58 maison
//   - validation ETH = regex
//  Sécurité : le serveur ne fait pas confiance au navigateur —
//   - revérifie la signature Solana (preuve de propriété du wallet)
//   - relit le solde $YC + supply on-chain et RECALCULE les spots
//   - refuse plus d'adresses ETH que de spots obtenus
//   - solana_wallet en PK -> une seule participation par wallet
// ============================================================
import { createClient } from '@libsql/client';
import crypto from 'crypto';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// mint $YC (adresse publique fixe) — surchargée par YC_TOKEN_MINT / WHEEL_TOKEN_ADDRESS si présents
const YC_MINT_DEFAULT = '9zcYAff5kaZfVDkEv3DzD2ojvocYyoRL2pFEko53pump';
const getRpcUrl = () => process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC;
const getMint   = () => process.env.YC_TOKEN_MINT || process.env.WHEEL_TOKEN_ADDRESS || YC_MINT_DEFAULT;

/* ---------- Validation adresse ETH (sans ethers) ---------- */
function isEthAddress(a){ return /^0x[0-9a-fA-F]{40}$/.test(String(a).trim()); }

/* ---------- Décodeur base58 (sans bs58) ---------- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58decode(str){
  const map = {}; for (let i=0;i<B58.length;i++) map[B58[i]] = i;
  const bytes = [];
  for (const ch of str){
    let carry = map[ch];
    if (carry === undefined) throw new Error('bad base58 char');
    for (let j=0;j<bytes.length;j++){
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0){ bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k=0; k<str.length && str[k]===B58[0]; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

/* ---------- Vérif signature Solana (ed25519 via crypto natif) ---------- */
function verifySolSig(message, signatureArr, pubkeyB58){
  try {
    const msg = Buffer.from(new TextEncoder().encode(message));
    const sig = Buffer.from(Uint8Array.from(signatureArr));
    const pub = base58decode(pubkeyB58);
    if (pub.length !== 32 || sig.length !== 64) return false;
    // SubjectPublicKeyInfo DER pour ed25519 = préfixe fixe (12 octets) + clé brute (32 octets)
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100','hex'), Buffer.from(pub)]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, msg, key, sig);
  } catch (e) { console.error('verifySolSig error:', e); return false; }
}

/* ---------- Calcul des spots ---------- */
const BONUS_THRESHOLD = 20000000, BONUS_SPOTS = 5;
function computeSpots(balance, supply){
  const pct = supply > 0 ? (balance / supply) * 100 : 0;
  let base = 0;
  if (pct >= 1) base = 10; else if (pct >= 0.5) base = 5; else if (pct >= 0.1) base = 1;
  const bonus = balance >= BONUS_THRESHOLD ? BONUS_SPOTS : 0;
  return { pct, total: base + bonus };
}

/* ---------- Lecture solde $YC + supply on-chain ---------- */
async function getHoldings(owner, mint){
  const rpc = getRpcUrl();
  const call = (method, params) => fetch(rpc, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params })
  }).then(r => r.json());

  const accs = await call('getTokenAccountsByOwner', [owner, { mint }, { encoding:'jsonParsed' }]);
  let balance = 0;
  for (const a of accs.result?.value || [])
    balance += a.account.data.parsed.info.tokenAmount.uiAmount || 0;

  const sup = await call('getTokenSupply', [mint]);
  const supply = sup.result?.value?.uiAmount || 0;
  return { balance, supply };
}

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error:'method' });

  try {
    // garde-fou config
    if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN)
      return res.status(500).json({ error:'config_missing', detail:'TURSO_DATABASE_URL / TURSO_AUTH_TOKEN absents' });
    if (!getRpcUrl())
      return res.status(500).json({ error:'config_missing', detail:'SOLANA_RPC_URL ou SOLANA_RPC absent' });

    // body parsing manuel (comme tes autres endpoints)
    let raw=''; await new Promise(r=>{ req.on('data',c=>raw+=c); req.on('end',r); });
    let body; try { body = JSON.parse(raw || '{}'); } catch { return res.status(400).json({ error:'invalid_json' }); }

    const { solanaWallet, signature, message, discord, ethAddresses } = body;
    if (!solanaWallet || !signature || !message || !discord || !Array.isArray(ethAddresses))
      return res.status(400).json({ error:'missing_fields' });

    // table (idempotent)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS holder_wl (
        solana_wallet TEXT PRIMARY KEY,
        discord       TEXT NOT NULL,
        yc_balance    REAL NOT NULL,
        supply_pct    REAL NOT NULL,
        wl_spots      INTEGER NOT NULL,
        eth_addresses TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      )
    `);

    // 1) signature + fraîcheur (anti-rejeu, fenêtre 10 min)
    if (!message.includes(solanaWallet)) return res.status(400).json({ error:'message_mismatch' });
    const tMatch = message.match(/Time:\s*(.+)$/m);
    const ts = tMatch ? Date.parse(tMatch[1]) : NaN;
    if (!ts || Math.abs(Date.now() - ts) > 10 * 60 * 1000) return res.status(400).json({ error:'signature_expired' });
    if (!verifySolSig(message, signature, solanaWallet)) return res.status(401).json({ error:'bad_signature' });

    // 2) déjà soumis ?
    const existing = await db.execute({ sql:'SELECT 1 FROM holder_wl WHERE solana_wallet = ?', args:[solanaWallet] });
    if (existing.rows.length) return res.status(409).json({ error:'already_submitted' });

    // 3) relecture on-chain + recalcul (jamais les chiffres du client)
    let holdings;
    try { holdings = await getHoldings(solanaWallet, getMint()); }
    catch (e) { console.error('rpc error:', e); return res.status(502).json({ error:'rpc_error' }); }
    const { pct, total: spots } = computeSpots(holdings.balance, holdings.supply);
    if (spots < 1) return res.status(403).json({ error:'not_eligible' });

    // 4) validation ETH + nombre <= spots
    const cleaned = ethAddresses.map(a => String(a).trim());
    if (cleaned.length < 1 || cleaned.length > spots) return res.status(400).json({ error:'wrong_address_count', spots });
    if (cleaned.some(a => !isEthAddress(a))) return res.status(400).json({ error:'invalid_eth_address' });

    // 5) insert (PK = wallet -> anti double participation)
    try {
      await db.execute({
        sql:`INSERT INTO holder_wl(solana_wallet, discord, yc_balance, supply_pct, wl_spots, eth_addresses, created_at)
             VALUES(?,?,?,?,?,?,?)`,
        args:[solanaWallet, discord.trim(), holdings.balance, pct, spots, JSON.stringify(cleaned), Date.now()]
      });
    } catch (e) {
      if (String(e?.message || e).toLowerCase().includes('unique') || String(e?.code||'').includes('CONSTRAINT'))
        return res.status(409).json({ error:'already_submitted' });
      console.error('insert error:', e);
      return res.status(500).json({ error:'db_insert_failed', detail:String(e?.message || e) });
    }

    return res.status(200).json({ ok:true, wl_spots: spots, balance: holdings.balance, supply_pct: pct });

  } catch (e) {
    console.error('holder-wl fatal:', e);
    return res.status(500).json({ error:'server_error', detail:String(e?.message || e) });
  }
}