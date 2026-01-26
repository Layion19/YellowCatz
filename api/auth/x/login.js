import {
  generateState,
  generateCodeVerifier,
  generateCodeChallenge
} from '../../lib/auth.js';

export default async function handler(req, res) {
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

    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    const cookieOpts = `HttpOnly; SameSite=Lax; Max-Age=600; Path=/${secure}`;

    res.setHeader('Set-Cookie', [
      `oauth_state=${state}; ${cookieOpts}`,
      `code_verifier=${codeVerifier}; ${cookieOpts}`
    ]);

    const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set(
      'scope',
      'users.read tweet.read offline.access' // 🔥 OBLIGATOIRE
    );
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return res.redirect(authUrl.toString());

  } catch (err) {
    console.error('OAuth login error:', err);
    return res.redirect('/yellow.html?error=login_failed');
  }
}
