// ============================================================
//  api/holder-wl.js — soumission PUBLIQUE d'un holder $YC
//  (la vue/gestion admin est dans /api/admin, action holderWL*)
//
//  Même stack que ton admin : @libsql/client + TURSO_DATABASE_URL.
//  Sécurité : le serveur ne fait pas confiance au navigateur —
//   - revérifie la signature Solana (preuve de propriété du wallet)
//   - relit le solde $YC + supply on-chain et RECALCULE les spots
//   - refuse plus d'adresses ETH que de spots obtenus
//   - solana_wallet en PK -> une seule participation par wallet
// ============================================================
import { createClient } from '@libsql/client';
import { isAddress } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

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
  const rpc = process.env.SOLANA_RPC_URL;
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

/* ---------- Vérif signature Solana ---------- */
function verifySolSig(message, signatureArr, pubkeyB58){
  try {
    const msg = new TextEncoder().encode(message);
    const sig = Uint8Array.from(signatureArr);
    return nacl.sign.detached.verify(msg, sig, bs58.decode(pubkeyB58));
  } catch { return false; }
}

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error:'method' });

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
  try { holdings = await getHoldings(solanaWallet, process.env.YC_TOKEN_MINT); }
  catch { return res.status(502).json({ error:'rpc_error' }); }
  const { pct, total: spots } = computeSpots(holdings.balance, holdings.supply);
  if (spots < 1) return res.status(403).json({ error:'not_eligible' });

  // 4) validation ETH + nombre <= spots
  const cleaned = ethAddresses.map(a => String(a).trim());
  if (cleaned.length < 1 || cleaned.length > spots) return res.status(400).json({ error:'wrong_address_count', spots });
  if (cleaned.some(a => !isAddress(a))) return res.status(400).json({ error:'invalid_eth_address' });

  // 5) insert (PK = wallet -> anti double participation)
  try {
    await db.execute({
      sql:`INSERT INTO holder_wl(solana_wallet, discord, yc_balance, supply_pct, wl_spots, eth_addresses, created_at)
           VALUES(?,?,?,?,?,?,?)`,
      args:[solanaWallet, discord.trim(), holdings.balance, pct, spots, JSON.stringify(cleaned), Date.now()]
    });
  } catch { return res.status(409).json({ error:'already_submitted' }); }

  return res.status(200).json({ ok:true, wl_spots: spots, balance: holdings.balance, supply_pct: pct });
}