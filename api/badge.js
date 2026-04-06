import { getUserFromRequest } from './lib/auth.js';
import {
  initDatabase,
  getUserByXId,
  awardBadge,
  getUserBadges,
  isUserBanned,
  isOGPeriodActive
} from './lib/db.js';
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/**
 * Badge API - Claim badges
 * POST /api/badge
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Auth
    const tokenUser = getUserFromRequest(req);
    if (!tokenUser) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // 2. Init DB + get user
    await initDatabase();
    const user = await getUserByXId(tokenUser.xUserId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // 3. Ban check
    const banned = await isUserBanned(user.id);
    if (banned) {
      return res.status(403).json({ error: 'User is banned' });
    }

    // 4. Parse body
    const { badgeId, wallet } = req.body || {};
    if (!badgeId) {
      return res.status(400).json({ error: 'Missing badgeId' });
    }

    // ============================================================
    // BADGE 10 — LEGEND: wallet submission for manual review
    // ============================================================
    if (badgeId === 'badge_10') {
      if (!wallet || wallet.trim().length < 32) {
        return res.status(400).json({ error: 'Invalid Solana wallet address' });
      }

      const cleanWallet = wallet.trim();

      // Already has badge?
      const userBadges = await getUserBadges(user.id);
      if (userBadges.some(b => b.badge_id === 'badge_10')) {
        return res.status(400).json({ error: 'Badge already unlocked' });
      }

      // Create table if needed
      await db.execute(`
        CREATE TABLE IF NOT EXISTS badge10_submissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          username TEXT NOT NULL,
          wallet TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Check existing submission
      const existing = await db.execute({
        sql: 'SELECT id, status FROM badge10_submissions WHERE user_id = ?',
        args: [user.id]
      });

      if (existing.rows.length > 0) {
        const st = existing.rows[0].status;
        if (st === 'pending') {
          return res.status(200).json({ success: true, pending: true, message: 'Wallet already submitted — under review.' });
        }
        if (st === 'rejected') {
          // Allow resubmission
          await db.execute({
            sql: 'UPDATE badge10_submissions SET wallet = ?, status = ?, created_at = CURRENT_TIMESTAMP WHERE user_id = ?',
            args: [cleanWallet, 'pending', user.id]
          });
          return res.status(200).json({ success: true, pending: true, message: 'Wallet resubmitted — under review.' });
        }
      }

      // New submission
      await db.execute({
        sql: 'INSERT INTO badge10_submissions (user_id, username, wallet) VALUES (?, ?, ?)',
        args: [user.id, user.x_username, cleanWallet]
      });

      return res.status(200).json({
        success: true,
        pending: true,
        message: 'Wallet submitted! We will verify your $YELLOWCATZ holdings manually.'
      });
    }

    // ============================================================
    // STANDARD BADGES
    // ============================================================

    // OG badge — 24h window
    if (badgeId === 'og') {
      if (!isOGPeriodActive()) {
        return res.status(400).json({ error: 'OG badge period has ended. You missed it.' });
      }
    }

    // Claimable badges list
    const claimableBadges = ['og', 'badge_2', 'badge_3', 'badge_4', 'badge_5', 'badge_6', 'badge_7', 'badge_8'];
    if (!claimableBadges.includes(badgeId)) {
      return res.status(400).json({ error: 'This badge cannot be claimed here' });
    }

    // Already has badge?
    const userBadges = await getUserBadges(user.id);
    if (userBadges.some(b => b.badge_id === badgeId)) {
      return res.status(400).json({ error: 'Badge already claimed' });
    }

    // Award
    await awardBadge(user.id, badgeId);

    return res.status(200).json({
      success: true,
      message: `Badge ${badgeId} unlocked!`,
      badgeId
    });

  } catch (error) {
    console.error('Badge claim error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
}