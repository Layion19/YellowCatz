import {
  generateState,
  generateCodeVerifier,
  generateCodeChallenge,
  createToken,
  createSessionCookie,
  clearSessionCookie,
  parseCookies
} from './lib/auth.js';

import {
  initDatabase,
  getUserByXId,
  createUser,
  updateUser,
  awardBadge,
  isOGPeriodActive
} from './lib/db.js';

/**
 * Consolidated Auth Handler
 * Routes: /api/auth?action=login|callback|logout
 */
export default async function handler(req, res) {
  const { action } = req.query;

  switch (action) {
    case 'login':
      return handleLogin(req, res);
    case 'callback':
      return handleCallback(req, res);
    case 'logout':
      return handleLogout(req, res);
    default:
      return res.status(400).json({ error: 'Invalid action. Use ?action=login|callback|logout' });
  }
}

/* ============================================================================
   LOGIN - Initie la connexion X (Twitter) avec PKCE
   ============================================================================ */
async function handleLogin(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const clientId = process.env.X_CLIENT_ID;
    const redirectUri = process.env.X_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      console.error('Missing X_CLIENT_ID or X_REDIRECT_URI');
      return res.redirect('/yellow.html?error=config_error');
    }

    // Génération des paramètres PKCE et state
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Configuration des cookies
    const isProd = process.env.NODE_ENV === 'production';
    const cookieOpts = [
      'HttpOnly',
      'Path=/',
      'Max-Age=600',
      isProd ? 'Secure' : '',
      isProd ? 'SameSite=None' : 'SameSite=Lax'
    ].filter(Boolean).join('; ');

    // Stockage du state et code_verifier dans des cookies sécurisés
    res.setHeader('Set-Cookie', [
      `oauth_state=${state}; ${cookieOpts}`,
      `code_verifier=${codeVerifier}; ${cookieOpts}`
    ]);

    // Construction de l'URL d'autorisation Twitter
    const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'users.read tweet.read');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    // Redirection vers Twitter
    return res.redirect(authUrl.toString());

  } catch (error) {
    console.error('OAuth login error:', error);
    return res.redirect('/yellow.html?error=login_failed');
  }
}

/* ============================================================================
   CALLBACK - OAuth 2.0 Callback pour X (Twitter)
   ============================================================================ */
async function handleCallback(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { code, state, error } = req.query;

    // Erreur OAuth renvoyée par X
    if (error) {
      console.error('OAuth error from X:', error);
      return res.redirect('/yellow.html?error=access_denied');
    }

    if (!code) {
      console.error('Missing authorization code');
      return res.redirect('/yellow.html?error=no_code');
    }

    // Lecture cookies (state + PKCE verifier)
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

    // Échange code → access_token
    const tokenData = await exchangeCodeForToken(code, codeVerifier);

    if (!tokenData || !tokenData.access_token) {
      console.error('Token exchange failed');
      return res.redirect('/yellow.html?error=token_failed');
    }

    // Récupération du profil X
    const xUser = await getXUser(tokenData.access_token);

    if (!xUser || !xUser.data) {
      console.error('Failed to fetch X user');
      return res.redirect('/yellow.html?error=user_failed');
    }

    // Base de données
    await initDatabase();

    const existingUser = await getUserByXId(xUser.data.id);
    let user;
    let isNewUser = false;

    if (!existingUser) {
      // Nouvel utilisateur
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
      // Utilisateur existant - mise à jour
      await updateUser(
        xUser.data.id,
        xUser.data.username,
        xUser.data.profile_image_url || null
      );

      user = {
        ...existingUser,
        x_username: xUser.data.username,
        avatar_url: xUser.data.profile_image_url || null
      };
    }

    // Badge OG
    if (isNewUser && isOGPeriodActive()) {
      await awardBadge(user.id, 'og');
    }

    // Création session utilisateur
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

    // Succès
    return res.redirect('/status.html');

  } catch (err) {
    console.error('OAuth callback fatal error:', err);
    return res.redirect('/yellow.html?error=callback_failed');
  }
}

/* ============================================================================
   LOGOUT - Déconnexion de l'utilisateur
   ============================================================================ */
async function handleLogout(req, res) {
  // Suppression du cookie de session
  res.setHeader('Set-Cookie', clearSessionCookie());
  
  // Redirection vers la page d'accueil
  res.redirect(302, '/index.html');
}

/* ============================================================================
   HELPERS
   ============================================================================ */

/**
 * Échange le code d'autorisation contre un access_token
 */
async function exchangeCodeForToken(code, codeVerifier) {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  const redirectUri = process.env.X_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error('Missing OAuth environment variables');
    return null;
  }

  const basicAuth = Buffer
    .from(`${clientId}:${clientSecret}`)
    .toString('base64');

  try {
    const response = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
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
    console.error('User fetch exception:', err);
    return null;
  }
}