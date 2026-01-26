import { getUserFromRequest } from '../lib/auth.js';
import {
  initDatabase,
  getUserByXId,
  getUserBadges,
  isOGPeriodActive
} from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1️⃣ Lire la session
    const tokenUser = getUserFromRequest(req);

    // ❌ Pas connecté
    if (!tokenUser) {
      return res.status(200).json({
        authenticated: false
      });
    }

    // 2️⃣ DB
    await initDatabase();

    const user = await getUserByXId(tokenUser.xUserId);

    if (!user) {
      return res.status(200).json({
        authenticated: false
      });
    }

    // 3️⃣ Badges
    const badges = await getUserBadges(user.id);
    const unlockedBadgeIds = badges.map(b => b.badge_id);

    // 4️⃣ Réponse clean
    return res.status(200).json({
      authenticated: true,

      user: {
        username: `@${user.x_username}`,
        avatarUrl: user.avatar_url,
        joinDate: user.first_login_date || user.created_at
      },

      ogPeriodActive: isOGPeriodActive(),

      badges: [
        { id: 'og', unlocked: unlockedBadgeIds.includes('og') },
        { id: 'badge_2', unlocked: unlockedBadgeIds.includes('badge_2') },
        { id: 'badge_3', unlocked: unlockedBadgeIds.includes('badge_3') },
        { id: 'badge_4', unlocked: unlockedBadgeIds.includes('badge_4') },
        { id: 'badge_5', unlocked: unlockedBadgeIds.includes('badge_5') },
        { id: 'badge_6', unlocked: unlockedBadgeIds.includes('badge_6') },
        { id: 'badge_7', unlocked: unlockedBadgeIds.includes('badge_7') },
        { id: 'badge_8', unlocked: unlockedBadgeIds.includes('badge_8') },
        { id: 'badge_9', unlocked: unlockedBadgeIds.includes('badge_9') },
        { id: 'badge_10', unlocked: unlockedBadgeIds.includes('badge_10') }
      ]
    });

  } catch (err) {
    console.error('Status API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
