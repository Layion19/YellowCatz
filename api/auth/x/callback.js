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
 * OAuth callback for X (Twitter) – PKCE
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { code, state, error } = req.query;

    // 1️⃣ Erreur renvoyée par X
    if (error) {
      console.error('OAuth error from X:', error);
      return res.redirect('/yellow.html?error=access_denied');
    }

    // 2️⃣ Code manquant
    if (!code) {
      console.error('No authorization code received');
      return res.redirect('/yellow.html?error=no_code');
    }

    // 3️⃣ Lecture cookies (PKCE + CSRF)
    const cookies = parseCookies(req.headers.cookie || '');
    const storedState = cookies.oauth_state;
    const codeVerifier = cookies.code_verifier;

    if (!state || state !== storedState) {
      console.error('Invalid OAuth state');
      return res.redirect('/yellow.html?error=invalid_state');
    }

    if (!codeVerifier) {
      console.error('Missing code_verifier');
      return res.redirect('/yellow.html?error=missing_verifier');
    }

    // 4️⃣ Échange code → access_token (PKCE, SANS client_secret)
    const tokenData = await exchangeCodeForToken(code, codeVerifier);

    if (!tokenData || !tokenData.access_token) {
      console.error('Failed to obtain access token');
      return res.redirect('/yellow.html?error=token_failed');
    }

    // 5️⃣ Récupération utilisateur X
    const xUser = await getXUser(tokenData.access_token);

    if (!xUser || !xUser.data) {
      console.error('Failed to fetch X user');
      return res.redirect('/yellow.html?error=user_failed');
    }

    // 6️⃣ DB
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

    // 7️⃣ Badge OG
    if (isNewUser && isOGPeriodActive()) {
      await awardBadge(user.id, 'og');
    }

    // 8️⃣ Session
    const sessionToken = createToken(user);
    const sessionCookie = createSessionCookie(sessionToken);

    // Nettoyage cookies OAuth
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    const clearState = `oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
    const clearVerifier = `code_verifier=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;

    res.setHeader('Set-Cookie', [sessionCookie, clearState, clearVerifier]);

    // 9️⃣ Succès
    return res.redirect('/status.html');

  } catch (err) {
    console.error('Callback fatal error:', err);
    return res.redirect('/yellow.html?error=callback_failed');
  }
}

/* -------------------------------------------------------------------------- */
/*                                   HELPERS                                  */
/* -------------------------------------------------------------------------- */

async function exchangeCodeForToken(code, codeVerifier) {
  const clientId = process.env.X_CLIENT_ID;
  const redirectUri = process.env.X_REDIRECT_URI;

  try {
    const response = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Token exchange failed:', response.status, text);
      return null;
    }

    return await response.json();
  } catch (err) {
    console.error('Token exchange error:', err);
    return null;
  }
}

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
      console.error('User fetch failed:', response.status, text);
      return null;
    }

    return await response.json();
  } catch (err) {
    console.error('User fetch error:', err);
    return null;
  }
}
