import { getUserFromRequest } from '../lib/auth.js';
import { initDatabase, getUserByXId, getUserBadges, isOGPeriodActive } from '../lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tokenUser = getUserFromRequest(req);
    
    if (!tokenUser) {
      return res.status(401).json({ 
        error: 'Not authenticated',
        redirect: '/yellow.html'
      });
    }

    await initDatabase();

    const user = await getUserByXId(tokenUser.xUserId);
    
    if (!user) {
      return res.status(404).json({ 
        error: 'User not found',
        redirect: '/yellow.html'
      });
    }

    const badges = await getUserBadges(user.id);
    const unlockedBadgeIds = badges.map(b => b.badge_id);

    const response = {
      user: {
        username: `@${user.x_username}`,
        avatarUrl: user.avatar_url,
        joinDate: user.first_login_date || user.created_at
      },
      badges: unlockedBadgeIds,
      ogPeriodActive: isOGPeriodActive(),
      allBadges: [
        { id: 'og', name: 'OG', description: 'First 24 hours', unlocked: unlockedBadgeIds.includes('og') },
        { id: 'badge_2', name: '???', description: '???', unlocked: unlockedBadgeIds.includes('badge_2') },
        { id: 'badge_3', name: '???', description: '???', unlocked: unlockedBadgeIds.includes('badge_3') },
        { id: 'badge_4', name: '???', description: '???', unlocked: unlockedBadgeIds.includes('badge_4') },
        { id: 'badge_5', name: '???', description: '???', unlocked: unlockedBadgeIds.includes('badge_5') },
        { id: 'badge_6', name: '???', description: '???', unlocked: unlockedBadgeIds.includes('badge_6') },
        { id: 'badge_7', name: '???', description: '???', unlocked: unlockedBadgeIds.includes('badge_7') },
        { id: 'badge_8', name: '???', description: '???', unlocked: unlockedBadgeIds.includes('badge_8') },
        { id: 'badge_9', name: '???', description: '???', unlocked: unlockedBadgeIds.includes('badge_9') },
        { id: 'badge_10', name: '???', description: '???', unlocked: unlockedBadgeIds.includes('badge_10') }
      ]
    };

    return res.status(200).json(response);

  } catch (error) {
    console.error('Status API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}