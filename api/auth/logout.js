import { clearSessionCookie } from '../lib/auth.js';

/**
 * Logout - Déconnexion de l'utilisateur
 * Supprime le cookie de session
 */
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Suppression du cookie de session
  res.setHeader('Set-Cookie', clearSessionCookie());

  // Redirection vers la page d'accueil
  res.redirect(302, '/index.html');
}