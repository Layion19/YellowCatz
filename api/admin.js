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

      return res.status(200).json({
        totalPlayers: totalPlayers.rows[0]?.count || 0,
        blockedPlayers: blockedPlayers.rows[0]?.count || 0,
        totalWon: totals.rows[0]?.won || 0,
        totalLost: totals.rows[0]?.lost || 0,
        totalGames: totals.rows[0]?.games || 0,
        topPlayers: topPlayers.rows,
        recentPlayers: recentPlayers.rows,
        blockedList: blockedList.rows
      });
    }

    // ============================================================
    // YELLOWJACK SEASON WINNERS
    // ============================================================
    if (action === 'yellowjackSeasonWinners') {
      try {
        // Get all season winners grouped by season
        const winners = await db.execute(`
          SELECT season_num, rank, user_id, username, avatar_url, points, volume, games_played, ended_at
          FROM yj_season_winners
          ORDER BY season_num DESC, rank ASC
        `);
        
        // Group by season
        const seasonsMap = {};
        for (const w of winners.rows) {
          if (!seasonsMap[w.season_num]) {
            seasonsMap[w.season_num] = {
              season_num: w.season_num,
              ended_at: w.ended_at,
              winners: []
            };
          }
          seasonsMap[w.season_num].winners.push({
            rank: w.rank,
            user_id: w.user_id,
            username: w.username,
            avatar_url: w.avatar_url || '',
            points: w.points || 0,
            volume: w.volume || 0,
            games_played: w.games_played || 0
          });
        }
        
        // Convert to array sorted by season (newest first)
        const seasons = Object.values(seasonsMap).sort((a, b) => b.season_num - a.season_num);
        
        return res.status(200).json({ seasons });
      } catch (err) {
        console.error('yellowjackSeasonWinners error:', err);
        return res.status(200).json({ seasons: [] });
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

    // ============================================================
    // YELLOW CARDS: STATS
    // ============================================================
    if (action === 'yellowcardStats') {
      // Ensure tables exist
      await db.execute(`
        CREATE TABLE IF NOT EXISTS yellowcard_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          wallet TEXT NOT NULL UNIQUE,
          card_type TEXT NOT NULL,
          card_number TEXT NOT NULL,
          entry_number INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS yellowcard_config (
          id INTEGER PRIMARY KEY,
          gold_entry INTEGER NOT NULL,
          emperor_entry INTEGER NOT NULL,
          initial_shuffle TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS yellowcard_pending (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          card_type TEXT NOT NULL,
          card_number TEXT NOT NULL,
          entry_number INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const total = await db.execute('SELECT COUNT(*) as count FROM yellowcard_entries');
      const pendingCount = await db.execute('SELECT COUNT(*) as count FROM yellowcard_pending');
      const byType = await db.execute(`
        SELECT card_type, COUNT(*) as count 
        FROM yellowcard_entries 
        GROUP BY card_type
      `);

      // Get Gold holder
      const goldHolder = await db.execute(`
        SELECT username, entry_number, created_at 
        FROM yellowcard_entries 
        WHERE card_type = 'gold'
      `);

      // Get Emperor holder
      const emperorHolder = await db.execute(`
        SELECT username, entry_number, created_at 
        FROM yellowcard_entries 
        WHERE card_type = 'emperor'
      `);

      // Get config to show which entry numbers are assigned to Gold/Emperor
      let config = null;
      try {
        const configResult = await db.execute('SELECT * FROM yellowcard_config WHERE id = 1');
        if (configResult.rows.length > 0) {
          config = {
            goldEntry: configResult.rows[0].gold_entry,
            emperorEntry: configResult.rows[0].emperor_entry
          };
        }
      } catch (e) {}

      // Recent entries
      const recent = await db.execute(`
        SELECT username, card_type, card_number, entry_number, wallet, qrt_link, comment_link, created_at 
        FROM yellowcard_entries 
        ORDER BY id DESC 
        LIMIT 20
      `);

      // Card distribution for commons
      const distribution = await db.execute(`
        SELECT card_number, COUNT(*) as count 
        FROM yellowcard_entries 
        WHERE card_type = 'common'
        GROUP BY card_number
        ORDER BY CAST(card_number AS INTEGER)
      `);

      const completedCount = total.rows[0]?.count || 0;
      const pending = pendingCount.rows[0]?.count || 0;

      return res.status(200).json({
        success: true,
        totalEntries: completedCount,
        pendingEntries: pending,
        maxSlots: 500,
        remaining: 500 - completedCount - pending,
        byType: byType.rows,
        goldHolder: goldHolder.rows[0] || null,
        emperorHolder: emperorHolder.rows[0] || null,
        config,
        recentEntries: recent.rows,
        distribution: distribution.rows
      });
    }

    // ============================================================
    // YELLOW CARDS: SEARCH
    // ============================================================
    if (action === 'yellowcardSearch') {
      const { query } = body;
      
      if (!query) {
        return res.status(200).json({ entries: [] });
      }

      const results = await db.execute({
        sql: `SELECT entry_number, username, wallet, card_type, card_number, created_at 
              FROM yellowcard_entries 
              WHERE username LIKE ? OR wallet LIKE ?
              ORDER BY entry_number ASC
              LIMIT 50`,
        args: [`%${query}%`, `%${query}%`]
      });

      return res.status(200).json({
        success: true,
        entries: results.rows
      });
    }

    // ============================================================
    // YELLOW CARDS: EXPORT
    // ============================================================
    if (action === 'yellowcardExport') {
      const all = await db.execute(`
        SELECT entry_number, username, wallet, card_type, card_number, created_at 
        FROM yellowcard_entries 
        ORDER BY entry_number ASC
      `);

      return res.status(200).json({
        success: true,
        entries: all.rows
      });
    }

    // ============================================================
    // YELLOW CARDS: DELETE ENTRY
    // ============================================================
    if (action === 'yellowcardDelete') {
      const { entryNumber } = body;
      
      if (!entryNumber) {
        return res.status(200).json({ error: 'Entry number required' });
      }

      await db.execute({
        sql: 'DELETE FROM yellowcard_entries WHERE entry_number = ?',
        args: [entryNumber]
      });

      return res.status(200).json({ success: true, message: 'Entry deleted' });
    }

    // ============================================================
    // YELLOW CARDS: FULL RESET
    // ============================================================
    if (action === 'yellowcardReset') {
      // Delete all entries
      await db.execute('DELETE FROM yellowcard_entries');
      
      // Delete all pending
      await db.execute('DELETE FROM yellowcard_pending');
      
      // Delete config (gold/emperor will be re-randomized)
      await db.execute('DELETE FROM yellowcard_config');

      return res.status(200).json({ 
        success: true, 
        message: 'Yellow Cards reset complete. Gold & Emperor slots will be re-randomized on next entry.' 
      });
    }

    // ============================================================
    // BADGE 10 — LIST SUBMISSIONS
    // ============================================================
    if (action === 'badge10Submissions') {
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

      const submissions = await db.execute(`
        SELECT s.id, s.user_id, s.username, s.wallet, s.status, s.created_at,
               u.avatar_url
        FROM badge10_submissions s
        LEFT JOIN users u ON s.user_id = u.id
        ORDER BY
          CASE s.status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,
          s.created_at DESC
      `);

      return res.status(200).json({ success: true, submissions: submissions.rows });
    }

    // ============================================================
    // BADGE 10 — APPROVE (award badge)
    // ============================================================
    if (action === 'badge10Approve') {
      const { submissionId, userId } = body;

      await db.execute({
        sql: 'UPDATE badge10_submissions SET status = ? WHERE id = ?',
        args: ['approved', submissionId]
      });

      await db.execute({
        sql: 'INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)',
        args: [userId, 'badge_10']
      });

      return res.status(200).json({ success: true, message: 'Badge 10 awarded to user' });
    }

    // ============================================================
    // BADGE 10 — REJECT
    // ============================================================
    if (action === 'badge10Reject') {
      const { submissionId } = body;

      await db.execute({
        sql: 'UPDATE badge10_submissions SET status = ? WHERE id = ?',
        args: ['rejected', submissionId]
      });

      return res.status(200).json({ success: true, message: 'Submission rejected — user can resubmit' });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('ADMIN API ERROR:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}