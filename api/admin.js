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

    // ============================================================
    // YELLOWJACK STATS
    // ============================================================
    if (action === 'yellowjackStats') {
      const totalPlayers = await db.execute('SELECT COUNT(*) as count FROM yellowjack_players');
      const blockedPlayers = await db.execute('SELECT COUNT(*) as count FROM yellowjack_players WHERE is_blocked = 1');
      const totals = await db.execute('SELECT SUM(total_won) as won, SUM(total_lost) as lost, SUM(games_played) as games FROM yellowjack_players');
      
      const topPlayers = await db.execute(`
        SELECT yj.*, u.x_username, u.avatar_url 
        FROM yellowjack_players yj
        INNER JOIN users u ON yj.user_id = u.id
        WHERE yj.is_blocked = 0
        ORDER BY yj.points DESC
        LIMIT 20
      `);
      
      const recentPlayers = await db.execute(`
        SELECT yj.*, u.x_username, u.avatar_url 
        FROM yellowjack_players yj
        INNER JOIN users u ON yj.user_id = u.id
        ORDER BY yj.last_played DESC
        LIMIT 20
      `);
      
      const blockedList = await db.execute(`
        SELECT yj.*, u.x_username, u.avatar_url 
        FROM yellowjack_players yj
        INNER JOIN users u ON yj.user_id = u.id
        WHERE yj.is_blocked = 1
      `);

      // Current season info
      let seasonInfo = null;
      try {
        const s = await db.execute("SELECT * FROM yj_season WHERE id = 1");
        if (s.rows.length > 0) {
          seasonInfo = { seasonNum: s.rows[0].season_num || 1, startTime: s.rows[0].start_time };
        }
      } catch(e) {}

      return res.status(200).json({
        totalPlayers: totalPlayers.rows[0]?.count || 0,
        blockedPlayers: blockedPlayers.rows[0]?.count || 0,
        totalWon: totals.rows[0]?.won || 0,
        totalLost: totals.rows[0]?.lost || 0,
        totalGames: totals.rows[0]?.games || 0,
        topPlayers: topPlayers.rows,
        recentPlayers: recentPlayers.rows,
        blockedList: blockedList.rows,
        seasonInfo
      });
    }

    // ============================================================
    // YELLOWJACK SEASON WINNERS — all past seasons
    // ============================================================
    if (action === 'yellowjackSeasonWinners') {
      const winners = await db.execute(`
        SELECT * FROM yj_season_winners
        ORDER BY season_num DESC, rank ASC
      `);

      // Group by season
      const seasons = {};
      for (const w of winners.rows) {
        const sn = w.season_num;
        if (!seasons[sn]) seasons[sn] = { seasonNum: sn, endedAt: w.ended_at, winners: [] };
        seasons[sn].winners.push({
          rank: w.rank,
          username: w.username,
          avatarUrl: w.avatar_url,
          points: w.points,
          volume: w.volume,
          gamesPlayed: w.games_played
        });
      }

      return res.status(200).json({ seasons: Object.values(seasons) });
    }

    // ============================================================
    // YELLOWJACK FORCE SEASON RESET (admin manual trigger)
    // ============================================================
    if (action === 'yellowjackForceReset') {
      // Save current winners first
      try {
        const s = await db.execute("SELECT * FROM yj_season WHERE id = 1");
        const currentSeason = s.rows[0]?.season_num || 1;
        
        // Get top 3
        const top3 = await db.execute(`
          SELECT yj.user_id, yj.points, yj.games_played, yj.total_won, yj.total_lost,
                 u.x_username, u.avatar_url
          FROM yellowjack_players yj
          JOIN users u ON yj.user_id = u.id
          WHERE yj.user_id > 0 AND yj.user_id < 900000 AND yj.is_blocked = 0
          ORDER BY (yj.total_won + yj.total_lost) DESC
          LIMIT 3
        `);
        
        const now = new Date().toISOString();
        for (let i = 0; i < top3.rows.length; i++) {
          const p = top3.rows[i];
          await db.execute({
            sql: `INSERT INTO yj_season_winners (season_num, rank, user_id, username, avatar_url, points, volume, games_played, ended_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [currentSeason, i + 1, p.user_id, p.x_username || 'Unknown', p.avatar_url || '', p.points || 0, (p.total_won || 0) + (p.total_lost || 0), p.games_played || 0, now]
          });
        }

        const nextSeason = currentSeason + 1;
        await db.execute("UPDATE yellowjack_players SET points = 20000, games_played = 0, total_won = 0, total_lost = 0");
        await db.execute({ sql: "UPDATE yj_season SET start_time = ?, season_num = ? WHERE id = 1", args: [now, nextSeason] });

        return res.status(200).json({ success: true, message: `Season ${currentSeason} ended. Winners saved. Season ${nextSeason} started.`, winners: top3.rows });
      } catch (err) {
        return res.status(500).json({ error: 'Reset failed: ' + err.message });
      }
    }

    // ============================================================
    // YELLOWJACK SEARCH PLAYER
    // ============================================================
    if (action === 'yellowjackSearchPlayer') {
      const clean = (body.username || '').replace(/^@/, '');
      
      const players = await db.execute({
        sql: `
          SELECT yj.*, u.x_username, u.avatar_url 
          FROM yellowjack_players yj
          INNER JOIN users u ON yj.user_id = u.id
          WHERE u.x_username LIKE ?
          LIMIT 20
        `,
        args: [`%${clean}%`]
      });

      return res.status(200).json({ players: players.rows });
    }

    // ============================================================
    // YELLOWJACK PLAYER DETAILS
    // ============================================================
    if (action === 'yellowjackPlayerDetails') {
      const { userId } = body;
      
      const player = await db.execute({
        sql: `
          SELECT yj.*, u.x_username, u.avatar_url 
          FROM yellowjack_players yj
          INNER JOIN users u ON yj.user_id = u.id
          WHERE yj.user_id = ?
        `,
        args: [userId]
      });

      return res.status(200).json({ player: player.rows[0] });
    }

    // ============================================================
    // YELLOWJACK SET POINTS
    // ============================================================
    if (action === 'yellowjackSetPoints') {
      const { userId, points } = body;
      
      await db.execute({
        sql: 'UPDATE yellowjack_players SET points = ? WHERE user_id = ?',
        args: [points, userId]
      });

      return res.status(200).json({ success: true, message: `Points set to ${points}` });
    }

    // ============================================================
    // YELLOWJACK BLOCK PLAYER
    // ============================================================
    if (action === 'yellowjackBlockPlayer') {
      const { userId } = body;
      
      await db.execute({
        sql: 'UPDATE yellowjack_players SET is_blocked = 1 WHERE user_id = ?',
        args: [userId]
      });

      return res.status(200).json({ success: true, message: 'Player blocked from YellowJack' });
    }

    // ============================================================
    // YELLOWJACK UNBLOCK PLAYER
    // ============================================================
    if (action === 'yellowjackUnblockPlayer') {
      const { userId } = body;
      
      await db.execute({
        sql: 'UPDATE yellowjack_players SET is_blocked = 0 WHERE user_id = ?',
        args: [userId]
      });

      return res.status(200).json({ success: true, message: 'Player unblocked' });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('ADMIN API ERROR:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}