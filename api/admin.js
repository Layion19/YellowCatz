import { initDatabase } from './lib/db.js';
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/**
 * Admin API - All admin actions
 * POST /api/admin
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { password, action } = req.body;

    // Vérification mot de passe admin
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    await initDatabase();

    // ============================================================
    // STATS GLOBALES
    // ============================================================
    if (action === 'stats') {
      const totalUsers = await db.execute('SELECT COUNT(*) as count FROM users WHERE is_banned = 0');
      const bannedUsers = await db.execute('SELECT COUNT(*) as count FROM users WHERE is_banned = 1');
      
      const badgeStats = await db.execute(`
        SELECT badge_id, COUNT(*) as count 
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
        totalUsers: totalUsers.rows[0].count,
        bannedUsers: bannedUsers.rows[0].count,
        badgeStats: badgeStats.rows,
        recentUsers: recentUsers.rows
      });
    }

    // ============================================================
    // USERS PAR BADGE
    // ============================================================
    if (action === 'usersByBadge') {
      const { badgeId } = req.body;
      
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
    // USERS AVEC X BADGES
    // ============================================================
    if (action === 'usersWithAllBadges') {
      const { minBadges } = req.body;
      
      const users = await db.execute({
        sql: `
          SELECT u.id, u.x_username, u.avatar_url, COUNT(ub.badge_id) as total_badges, u.is_banned
          FROM users u
          JOIN user_badges ub ON u.id = ub.user_id
          GROUP BY u.id
          HAVING total_badges >= ?
          ORDER BY total_badges DESC
        `,
        args: [minBadges || 10]
      });

      return res.status(200).json({ users: users.rows });
    }

    // ============================================================
    // TOUS LES USERS
    // ============================================================
    if (action === 'allUsers') {
      const users = await db.execute(`
        SELECT 
          u.id,
          u.x_username, 
          u.avatar_url, 
          u.created_at,
          u.is_banned,
          COUNT(ub.badge_id) as badge_count
        FROM users u
        LEFT JOIN user_badges ub ON u.id = ub.user_id
        GROUP BY u.id
        ORDER BY u.created_at DESC
      `);

      return res.status(200).json({ users: users.rows });
    }

    // ============================================================
    // CHERCHER UN USER
    // ============================================================
    if (action === 'searchUser') {
      const { username } = req.body;
      const cleanUsername = username.replace(/^@/, '');
      
      const users = await db.execute({
        sql: `
          SELECT 
            u.id,
            u.x_username, 
            u.avatar_url, 
            u.created_at,
            u.is_banned
          FROM users u
          WHERE u.x_username LIKE ?
          LIMIT 20
        `,
        args: [`%${cleanUsername}%`]
      });

      return res.status(200).json({ users: users.rows });
    }

    // ============================================================
    // DÉTAILS D'UN USER (avec ses badges)
    // ============================================================
    if (action === 'userDetails') {
      const { userId } = req.body;
      
      const user = await db.execute({
        sql: 'SELECT * FROM users WHERE id = ?',
        args: [userId]
      });

      if (!user.rows[0]) {
        return res.status(404).json({ error: 'User not found' });
      }

      const badges = await db.execute({
        sql: `
          SELECT ub.badge_id, ub.unlocked_at, b.badge_name, b.description
          FROM user_badges ub
          JOIN badges b ON ub.badge_id = b.badge_id
          WHERE ub.user_id = ?
        `,
        args: [userId]
      });

      const allBadges = await db.execute('SELECT badge_id, badge_name FROM badges');

      return res.status(200).json({ 
        user: user.rows[0],
        userBadges: badges.rows,
        allBadges: allBadges.rows
      });
    }

    // ============================================================
    // AJOUTER UN BADGE À UN USER
    // ============================================================
    if (action === 'addBadge') {
      const { userId, badgeId } = req.body;
      
      await db.execute({
        sql: 'INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)',
        args: [userId, badgeId]
      });

      return res.status(200).json({ success: true, message: `Badge ${badgeId} added to user ${userId}` });
    }

    // ============================================================
    // RETIRER UN BADGE À UN USER
    // ============================================================
    if (action === 'removeBadge') {
      const { userId, badgeId } = req.body;
      
      await db.execute({
        sql: 'DELETE FROM user_badges WHERE user_id = ? AND badge_id = ?',
        args: [userId, badgeId]
      });

      return res.status(200).json({ success: true, message: `Badge ${badgeId} removed from user ${userId}` });
    }

    // ============================================================
    // BANNIR UN USER
    // ============================================================
    if (action === 'banUser') {
      const { userId } = req.body;
      
      await db.execute({
        sql: 'UPDATE users SET is_banned = 1 WHERE id = ?',
        args: [userId]
      });

      return res.status(200).json({ success: true, message: `User ${userId} banned` });
    }

    // ============================================================
    // DÉBANNIR UN USER
    // ============================================================
    if (action === 'unbanUser') {
      const { userId } = req.body;
      
      await db.execute({
        sql: 'UPDATE users SET is_banned = 0 WHERE id = ?',
        args: [userId]
      });

      return res.status(200).json({ success: true, message: `User ${userId} unbanned` });
    }

    // ============================================================
    // LISTE DES USERS BANNIS
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

  } catch (error) {
    console.error('Admin API error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
}