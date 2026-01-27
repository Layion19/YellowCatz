import { initDatabase } from '../lib/db.js';
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

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

    // Stats globales
    if (action === 'stats') {
      const totalUsers = await db.execute('SELECT COUNT(*) as count FROM users');
      
      const badgeStats = await db.execute(`
        SELECT badge_id, COUNT(*) as count 
        FROM user_badges 
        GROUP BY badge_id
      `);

      const recentUsers = await db.execute(`
        SELECT x_username, avatar_url, created_at 
        FROM users 
        ORDER BY created_at DESC 
        LIMIT 10
      `);

      return res.status(200).json({
        totalUsers: totalUsers.rows[0].count,
        badgeStats: badgeStats.rows,
        recentUsers: recentUsers.rows
      });
    }

    // Users par badge
    if (action === 'usersByBadge') {
      const { badgeId } = req.body;
      
      const users = await db.execute({
        sql: `
          SELECT u.x_username, u.avatar_url, ub.unlocked_at
          FROM users u
          JOIN user_badges ub ON u.id = ub.user_id
          WHERE ub.badge_id = ?
          ORDER BY ub.unlocked_at DESC
        `,
        args: [badgeId]
      });

      return res.status(200).json({ users: users.rows });
    }

    // Users avec tous les badges (ou X badges)
    if (action === 'usersWithAllBadges') {
      const { minBadges } = req.body;
      
      const users = await db.execute({
        sql: `
          SELECT u.x_username, u.avatar_url, COUNT(ub.badge_id) as total_badges
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

    // Liste complète des users
    if (action === 'allUsers') {
      const users = await db.execute(`
        SELECT 
          u.id,
          u.x_username, 
          u.avatar_url, 
          u.created_at,
          COUNT(ub.badge_id) as badge_count
        FROM users u
        LEFT JOIN user_badges ub ON u.id = ub.user_id
        GROUP BY u.id
        ORDER BY u.created_at DESC
      `);

      return res.status(200).json({ users: users.rows });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (error) {
    console.error('Admin API error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
}