import { initDatabase } from './lib/db.js';
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ============================================================
// ADMIN API — VERCEL SERVERLESS
// POST /api/admin
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

  const { password, action } = body;

  if (!password || !action) {
    return res.status(400).json({ error: 'Missing password or action' });
  }

  // ============================================================
  // ADMIN PASSWORD CHECK
  // ============================================================
  const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
  if (!adminPassword || password.trim() !== adminPassword) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  try {
    await initDatabase();

    // ============================================================
    // STATS
    // ============================================================
    if (action === 'stats') {
      const totalUsers = await db.execute('SELECT COUNT(*) AS count FROM users WHERE is_banned = 0');
      const bannedUsers = await db.execute('SELECT COUNT(*) AS count FROM users WHERE is_banned = 1');

      const badgeStats = await db.execute(`
        SELECT badge_id, COUNT(*) AS count
        FROM user_badges
        GROUP BY badge_id
      `);

      const recentUsers = await db.execute(`
        SELECT id, x_username, avatar_url, created_at, is_banned
        FROM users
        ORDER BY created_at DESC
        LIMIT 10
      `);

      return res.status(200).json({
        totalUsers: totalUsers.rows[0]?.count || 0,
        bannedUsers: bannedUsers.rows[0]?.count || 0,
        badgeStats: badgeStats.rows,
        recentUsers: recentUsers.rows
      });
    }

    // ============================================================
    // USERS BY BADGE
    // ============================================================
    if (action === 'usersByBadge') {
      const { badgeId } = body;

      const users = await db.execute({
        sql: `
          SELECT u.id, u.x_username, u.avatar_url, ub.unlocked_at, u.is_banned
          FROM users u
          JOIN user_badges ub ON u.id = ub.user_id
          WHERE ub.badge_id = ?
          ORDER BY ub.unlocked_at DESC
        `,
        args: [badgeId]
      });

      return res.status(200).json({ users: users.rows });
    }

    // ============================================================
    // USERS WITH X BADGES
    // ============================================================
    if (action === 'usersWithAllBadges') {
      const { minBadges = 10 } = body;

      const users = await db.execute({
        sql: `
          SELECT u.id, u.x_username, u.avatar_url, COUNT(ub.badge_id) AS total_badges, u.is_banned
          FROM users u
          JOIN user_badges ub ON u.id = ub.user_id
          GROUP BY u.id
          HAVING total_badges >= ?
          ORDER BY total_badges DESC
        `,
        args: [minBadges]
      });

      return res.status(200).json({ users: users.rows });
    }

    // ============================================================
    // ALL USERS
    // ============================================================
    if (action === 'allUsers') {
      const users = await db.execute(`
        SELECT u.id, u.x_username, u.avatar_url, u.created_at, u.is_banned,
               COUNT(ub.badge_id) AS badge_count
        FROM users u
        LEFT JOIN user_badges ub ON u.id = ub.user_id
        GROUP BY u.id
        ORDER BY u.created_at DESC
      `);

      return res.status(200).json({ users: users.rows });
    }

    // ============================================================
    // SEARCH USER
    // ============================================================
    if (action === 'searchUser') {
      const clean = (body.username || '').replace(/^@/, '');

      const users = await db.execute({
        sql: `
          SELECT id, x_username, avatar_url, created_at, is_banned
          FROM users
          WHERE x_username LIKE ?
          LIMIT 20
        `,
        args: [`%${clean}%`]
      });

      return res.status(200).json({ users: users.rows });
    }

    // ============================================================
    // USER DETAILS
    // ============================================================
    if (action === 'userDetails') {
      const { userId } = body;

      const user = await db.execute({
        sql: 'SELECT * FROM users WHERE id = ?',
        args: [userId]
      });

      if (!user.rows[0]) {
        return res.status(404).json({ error: 'User not found' });
      }

      const userBadges = await db.execute({
        sql: `
          SELECT ub.badge_id, b.badge_name
          FROM user_badges ub
          JOIN badges b ON ub.badge_id = b.badge_id
          WHERE ub.user_id = ?
        `,
        args: [userId]
      });

      const allBadges = await db.execute('SELECT badge_id, badge_name FROM badges');

      return res.status(200).json({
        user: user.rows[0],
        userBadges: userBadges.rows,
        allBadges: allBadges.rows
      });
    }

    // ============================================================
    // ADD / REMOVE BADGE
    // ============================================================
    if (action === 'addBadge' || action === 'removeBadge') {
      const { userId, badgeId } = body;

      if (action === 'addBadge') {
        await db.execute({
          sql: 'INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)',
          args: [userId, badgeId]
        });
      } else {
        await db.execute({
          sql: 'DELETE FROM user_badges WHERE user_id = ? AND badge_id = ?',
          args: [userId, badgeId]
        });
      }

      return res.status(200).json({ success: true });
    }

    // ============================================================
    // BAN / UNBAN USER
    // ============================================================
    if (action === 'banUser' || action === 'unbanUser') {
      const banned = action === 'banUser' ? 1 : 0;
      await db.execute({
        sql: 'UPDATE users SET is_banned = ? WHERE id = ?',
        args: [banned, body.userId]
      });

      return res.status(200).json({ success: true });
    }

    // ============================================================
    // BANNED USERS
    // ============================================================
    if (action === 'bannedUsers') {
      const users = await db.execute(`
        SELECT id, x_username, avatar_url, created_at
        FROM users
        WHERE is_banned = 1
        ORDER BY created_at DESC
      `);

      return res.status(200).json({ users: users.rows });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('ADMIN API ERROR:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}