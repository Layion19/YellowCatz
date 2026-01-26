import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export async function initDatabase() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      x_user_id TEXT UNIQUE NOT NULL,
      x_username TEXT NOT NULL,
      avatar_url TEXT,
      first_login_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      badge_id TEXT UNIQUE NOT NULL,
      badge_name TEXT NOT NULL,
      description TEXT,
      is_time_limited INTEGER DEFAULT 0,
      start_date DATETIME,
      end_date DATETIME
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      badge_id TEXT NOT NULL,
      unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, badge_id)
    )
  `);

  const defaultBadges = [
    { badge_id: 'og', badge_name: 'OG', description: 'First 24 hours founder', is_time_limited: 1 },
    { badge_id: 'badge_2', badge_name: '???', description: 'Mystery badge 2', is_time_limited: 0 },
    { badge_id: 'badge_3', badge_name: '???', description: 'Mystery badge 3', is_time_limited: 0 },
    { badge_id: 'badge_4', badge_name: '???', description: 'Mystery badge 4', is_time_limited: 0 },
    { badge_id: 'badge_5', badge_name: '???', description: 'Mystery badge 5', is_time_limited: 0 },
    { badge_id: 'badge_6', badge_name: '???', description: 'Mystery badge 6', is_time_limited: 0 },
    { badge_id: 'badge_7', badge_name: '???', description: 'Mystery badge 7', is_time_limited: 0 },
    { badge_id: 'badge_8', badge_name: '???', description: 'Mystery badge 8', is_time_limited: 0 },
    { badge_id: 'badge_9', badge_name: '???', description: 'Mystery badge 9', is_time_limited: 0 },
    { badge_id: 'badge_10', badge_name: '???', description: 'Mystery badge 10', is_time_limited: 0 },
  ];

  for (const badge of defaultBadges) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO badges (badge_id, badge_name, description, is_time_limited) VALUES (?, ?, ?, ?)`,
      args: [badge.badge_id, badge.badge_name, badge.description, badge.is_time_limited]
    });
  }
}

export async function getUserByXId(xUserId) {
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE x_user_id = ?',
    args: [xUserId]
  });
  return result.rows[0] || null;
}

export async function createUser(xUserId, xUsername, avatarUrl) {
  const result = await db.execute({
    sql: 'INSERT INTO users (x_user_id, x_username, avatar_url) VALUES (?, ?, ?)',
    args: [xUserId, xUsername, avatarUrl]
  });
  return result.lastInsertRowid;
}

export async function updateUser(xUserId, xUsername, avatarUrl) {
  await db.execute({
    sql: 'UPDATE users SET x_username = ?, avatar_url = ? WHERE x_user_id = ?',
    args: [xUsername, avatarUrl, xUserId]
  });
}

export async function getUserBadges(userId) {
  const result = await db.execute({
    sql: `SELECT ub.badge_id, ub.unlocked_at, b.badge_name, b.description 
          FROM user_badges ub 
          JOIN badges b ON ub.badge_id = b.badge_id 
          WHERE ub.user_id = ?`,
    args: [userId]
  });
  return result.rows;
}

export async function awardBadge(userId, badgeId) {
  try {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)',
      args: [userId, badgeId]
    });
    return true;
  } catch (error) {
    console.error('Error awarding badge:', error);
    return false;
  }
}

export function isOGPeriodActive() {
  const launchDate = process.env.YELLOW_WORLD_LAUNCH_DATE;
  if (!launchDate) return false;
  
  const launch = new Date(launchDate);
  const now = new Date();
  const hoursSinceLaunch = (now - launch) / (1000 * 60 * 60);
  
  return hoursSinceLaunch >= 0 && hoursSinceLaunch <= 24;
}

export default db;