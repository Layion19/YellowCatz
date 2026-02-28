import { getUserFromRequest } from './lib/auth.js';
import {
  initDatabase,
  getUserByXId,
  awardBadge,
  getUserBadges,
  isUserBanned,
  isOGPeriodActive
} from './lib/db.js';

/**
 * Badge API - Claim badges
 * POST /api/badge
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1️⃣ Vérifier l'authentification
    const tokenUser = getUserFromRequest(req);

    if (!tokenUser) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // 2️⃣ Initialiser la DB et récupérer l'utilisateur
    await initDatabase();
    const user = await getUserByXId(tokenUser.xUserId);

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // 3️⃣ Vérifier si l'utilisateur est banni
    const banned = await isUserBanned(user.id);
    if (banned) {
      return res.status(403).json({ error: 'User is banned' });
    }

    // 4️⃣ Récupérer le badgeId de la requête
    const { badgeId } = req.body;

    if (!badgeId) {
      return res.status(400).json({ error: 'Missing badgeId' });
    }

    // 5️⃣ OG badge — vérifier la fenêtre 24h
    if (badgeId === 'og') {
      if (!isOGPeriodActive()) {
        return res.status(400).json({ error: 'OG badge period has ended. You missed it.' });
      }
    }

    // 6️⃣ Liste des badges claimables via cette API
    const claimableBadges = ['og', 'badge_2', 'badge_3', 'badge_4', 'badge_5', 'badge_6', 'badge_7', 'badge_8'];

    if (!claimableBadges.includes(badgeId)) {
      return res.status(400).json({ error: 'This badge cannot be claimed here' });
    }

    // 7️⃣ Vérifier si l'utilisateur a déjà ce badge
    const userBadges = await getUserBadges(user.id);
    const alreadyHasBadge = userBadges.some(b => b.badge_id === badgeId);

    if (alreadyHasBadge) {
      return res.status(400).json({ error: 'Badge already claimed' });
    }

    // 8️⃣ Attribuer le badge
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