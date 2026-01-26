import { createToken, createSessionCookie, parseCookies } from '../../lib/auth.js';
import { initDatabase, getUserByXId, createUser, updateUser, awardBadge, isOGPeriodActive } from '../../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { code, state, error } = req.query;

    if (error) {
      console.error('OAuth error from X:', error);
      return res.redirect('/yellow.html?error=access_denied');
    }

    if (!code) {
      console.error('No authorization code received');
      return res.redirect('/yellow.html?error=no_code');
    }

    const cookies = parseCookies(req.headers.cookie);
    const storedState = cookies.oauth_state;
    const codeVerifier = cookies.code_verifier;

    if (!state || state !== storedState) {
      console.error('State mismatch - possible CSRF attack');
      return res.redirect('/yellow.html?error=invalid_state');
    }

    if (!codeVerifier) {
      console.error('Missing code verifier');
      return res.redirect('/yellow.html?error=missing_verifier');
    }

    const tokenData = await exchangeCodeForToken(code, codeVerifier);
    
    if (!tokenData || !tokenData.access_token) {
      console.error('Failed to get access token');
      return res.redirect('/yellow.html?error=token_failed');
    }

    const xUser = await getXUser(tokenData.access_token);
    
    if (!xUser || !xUser.data) {
      console.error('Failed to get X user info');
      return res.redirect('/yellow.html?error=user_failed');
    }

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

    if (isNewUser && isOGPeriodActive()) {
      await awardBadge(user.id, 'og');
      console.log(`OG badge awarded to new user: ${user.x_username}`);
    }

    const sessionToken = createToken(user);
    const sessionCookie = createSessionCookie(sessionToken);

    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    const clearStateCookie = `oauth_state=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/${secure}`;
    const clearVerifierCookie = `code_verifier=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/${secure}`;

    res.setHeader('Set-Cookie', [sessionCookie, clearStateCookie, clearVerifierCookie]);
    res.redirect('/status.html');

  } catch (error) {
    console.error('Callback error:', error);
    res.redirect('/yellow.html?error=callback_failed');
  }
}

async function exchangeCodeForToken(code, codeVerifier) {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  const redirectUri = process.env.X_REDIRECT_URI;

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const response = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      },
      body: new URLSearchParams({
        code: code,
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Token exchange failed:', response.status, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Token exchange error:', error);
    return null;
  }
}

async function getXUser(accessToken) {
  try {
    const response = await fetch('https://api.twitter.com/2/users/me?user.fields=profile_image_url', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('User fetch failed:', response.status, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('User fetch error:', error);
    return null;
  }
}