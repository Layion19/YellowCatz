import {
  createToken,
  createSessionCookie,
  parseCookies
} from '../../lib/auth.js';

import {
  initDatabase,
  getUserByXId,
  createUser,
  updateUser,
  awardBadge,
  isOGPeriodActive
} from '../../lib/db.js';

/**
 * OAuth 2.0 Callback for X (Twitter)
 * Client confidentiel + PKCE
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { code, state, error } = req.query;

    /* ---------------------------------------------------------------------- */
    /* 1. Erreur OAuth renvoyée par X                                         */
    /* ---------------------------------------------------------------------- */
    if (error) {
      console.error('OAuth error from X:', error);
      return res.redirect('/yellow.html?error=access_denied');
    }

    if (!code) {
      console.error('Missing authorization code');
      return res.redirect('/yellow.html?error=no_code');
    }

    /* ---------------------------------------------------------------------- */
    /* 2. Lecture cookies (state + PKCE verifier)                             */
    /* ---------------------------------------------------------------------- */
    const cookies = parseCookies(req.headers.cookie || '');
    const storedState = cookies.oauth_state;
    const codeVerifier = cookies.code_verifier;

    if (!storedState || state !== storedState) {
      console.error('Invalid OAuth state - received:', state, 'expected:', storedState);
      return res.redirect('/yellow.html?error=invalid_state');
    }

    if (!codeVerifier) {
      console.error('Missing PKCE code_verifier');
      return res.redirect('/yellow.html?error=missing_verifier');
    }

    /* ---------------------------------------------------------------------- */
    /* 3. Échange code → access_token (Client confidentiel + PKCE)            */
    /* ---------------------------------------------------------------------- */
    const tokenData = await exchangeCodeForToken(code, codeVerifier);

    if (!tokenData || !tokenData.access_token) {
      console.error('Token exchange failed');
      return res.redirect('/yellow.html?error=token_failed');
    }

    /* ---------------------------------------------------------------------- */
    /* 4. Récupération du profil X                                            */
    /* ---------------------------------------------------------------------- */
    const xUser = await getXUser(tokenData.access_token);

    if (!xUser || !xUser.data) {
      console.error('Failed to fetch X user');
      return res.redirect('/yellow.html?error=user_failed');
    }

    /* ---------------------------------------------------------------------- */
    /* 5. Base de données                                                     */
    /* ---------------------------------------------------------------------- */
    await initDatabase();

    let user = await getUserByXId(xUser.data.id);
    let isNewUser = false;

    if (!user) {
      isNewUser = true;

      const userId = await createUser(
        xUser.data.id,
        xUser.data.username,
        xUser.data.profile_image_url || null
      );

      user = {
        id: userId,
        x_user_id: xUser.data.id,
        x_username: xUser.data.username,
        avatar_url: xUser.data.profile_image_url || null
      };
    } else {
      await updateUser(
        xUser.data.id,
        xUser.data.username,
        xUser.data.profile_image_url || null
      );

      user.x_username = xUser.data.username;
      user.avatar_url = xUser.data.profile_image_url || null;
    }

    /* ---------------------------------------------------------------------- */
    /* 6. Badge OG                                                            */
    /* ---------------------------------------------------------------------- */
    if (isNewUser && isOGPeriodActive()) {
      await awardBadge(user.id, 'og');
    }

    /* ---------------------------------------------------------------------- */
    /* 7. Création session utilisateur                                        */
    /* ---------------------------------------------------------------------- */
    const sessionToken = createToken(user);
    const sessionCookie = createSessionCookie(sessionToken);

    const isProd = process.env.NODE_ENV === 'production';
    const secure = isProd ? '; Secure' : '';

    const clearState = `oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
    const clearVerifier = `code_verifier=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;

    res.setHeader('Set-Cookie', [
      sessionCookie,
      clearState,
      clearVerifier
    ]);

    /* ---------------------------------------------------------------------- */
    /* 8. Succès                                                              */
    /* ---------------------------------------------------------------------- */
    return res.redirect('/status.html');

  } catch (err) {
    console.error('OAuth callback fatal error:', err);
    return res.redirect('/yellow.html?error=callback_failed');
  }
}

/* -------------------------------------------------------------------------- */
/*                                  HELPERS                                   */
/* -------------------------------------------------------------------------- */

/**
 * Échange le code d'autorisation contre un access_token
 * Utilise Basic Auth (client confidentiel) + PKCE
 */
async function exchangeCodeForToken(code, codeVerifier) {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  const redirectUri = process.env.X_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error('Missing OAuth environment variables');
    return null;
  }

  // Encodage Basic Auth pour client confidentiel
  const basicAuth = Buffer
    .from(`${clientId}:${clientSecret}`)
    .toString('base64');

  try {
    const response = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`  // ← CORRECTION: Header ajouté
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Token endpoint error:', response.status, text);
      return null;
    }

    return await response.json();

  } catch (err) {
    console.error('Token exchange exception:', err);
    return null;
  }
}

/**
 * Récupère les informations de l'utilisateur X authentifié
 */
async function getXUser(accessToken) {
  try {
    const response = await fetch(
      'https://api.twitter.com/2/users/me?user.fields=profile_image_url',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error('User fetch error:', response.status, text);
      return null;
    }

    return await response.json();

  } catch (err) {
    console.error('User fetch exception:', err);s
    return null;
  }
}  