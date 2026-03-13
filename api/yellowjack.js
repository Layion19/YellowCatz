import { initDatabase } from './lib/db.js';
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ============================================================
// YELLOWJACK API — VERCEL SERVERLESS
// POST /api/yellowjack
// ============================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ============================================================
  // MANUAL BODY PARSING (REQUIRED)
  // ============================================================
  let rawBody = '';
  await new Promise((resolve) => {
    req.on('data', chunk => {
      rawBody += chunk;
    });
    req.on('end', resolve);
  });

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { action } = body;

  if (!action) {
    return res.status(400).json({ error: 'Missing action' });
  }

  // ============================================================
  // GET USER FROM SESSION
  // ============================================================
  const sessionToken = req.cookies?.session_token;
  if (!sessionToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    await initDatabase();

    // Ensure yellowjack_players table exists
    await db.execute(`
      CREATE TABLE IF NOT EXISTS yellowjack_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        points INTEGER DEFAULT 10000,
        games_played INTEGER DEFAULT 0,
        total_won INTEGER DEFAULT 0,
        total_lost INTEGER DEFAULT 0,
        is_blocked INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_played DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Get user from session
    const sessionResult = await db.execute({
      sql: 'SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime("now")',
      args: [sessionToken]
    });

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const userId = sessionResult.rows[0].user_id;

    // Check if user is blocked from YellowJack
    const blockCheck = await db.execute({
      sql: 'SELECT is_blocked FROM yellowjack_players WHERE user_id = ?',
      args: [userId]
    });

    if (blockCheck.rows.length > 0 && blockCheck.rows[0].is_blocked === 1) {
      return res.status(200).json({ blocked: true });
    }

    // ============================================================
    // GET PLAYER
    // ============================================================
    if (action === 'getPlayer') {
      const result = await db.execute({
        sql: 'SELECT * FROM yellowjack_players WHERE user_id = ?',
        args: [userId]
      });

      if (result.rows.length === 0) {
        // Create new player
        await db.execute({
          sql: 'INSERT INTO yellowjack_players (user_id, points) VALUES (?, 10000)',
          args: [userId]
        });
        return res.status(200).json({ 
          player: { points: 10000, games_played: 0, total_won: 0, total_lost: 0 } 
        });
      }

      return res.status(200).json({ player: result.rows[0] });
    }

    // ============================================================
    // UPDATE POINTS
    // ============================================================
    if (action === 'updatePoints') {
      const { points } = body;
      
      await db.execute({
        sql: `INSERT INTO yellowjack_players (user_id, points, last_played) 
              VALUES (?, ?, datetime("now"))
              ON CONFLICT(user_id) DO UPDATE SET 
              points = ?, last_played = datetime("now")`,
        args: [userId, points, points]
      });

      return res.status(200).json({ success: true });
    }

    // ============================================================
    // RECORD GAME
    // ============================================================
    if (action === 'recordGame') {
      const { won, lost } = body;

      await db.execute({
        sql: `UPDATE yellowjack_players 
              SET games_played = games_played + 1,
                  total_won = total_won + ?,
                  total_lost = total_lost + ?,
                  last_played = datetime("now")
              WHERE user_id = ?`,
        args: [won || 0, lost || 0, userId]
      });

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('YELLOWJACK API ERROR:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}