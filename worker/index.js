export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === '/api/ping') {
        return new Response(JSON.stringify({ok:true, now: Date.now()}), { headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/auth/google/start') {
        // Start OAuth2 flow for Google
        const state = crypto.randomUUID();
        // Store state temporarily in KV with short TTL (not implemented: KV has no TTL here) — for demo we just return the URL
        const clientId = env.GOOGLE_CLIENT_ID;
        const redirect = url.origin + '/auth/google/callback';
        const scope = encodeURIComponent('openid email profile https://www.googleapis.com/auth/drive.readonly');
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
        return Response.redirect(authUrl, 302);
      }

      if (pathname === '/auth/google/callback') {
        const reqUrl = new URL(request.url);
        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');
        if (!code) return new Response('Missing code', { status: 400 });

        // Exchange code for tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: url.origin + '/auth/google/callback',
            grant_type: 'authorization_code'
          })
        });
        const tokenJson = await tokenRes.json();
        if (tokenJson.error) return new Response(JSON.stringify(tokenJson), { status: 500, headers: { 'Content-Type': 'application/json' } });

        // Get userinfo to identify the account (email)
        const accessToken = tokenJson.access_token;
        const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
        const userJson = await userRes.json();
        const email = userJson.email || userJson.sub || 'unknown';

        // Store tokens in KV under key google:{email}
        const save = {
          email,
          access_token: tokenJson.access_token,
          refresh_token: tokenJson.refresh_token,
          scope: tokenJson.scope,
          expires_in: tokenJson.expires_in,
          obtained_at: Date.now()
        };

        if (env.TOKENS) {
          await env.TOKENS.put(`google:${email}`, JSON.stringify(save));
        }

        // Create a session id and map session:{id} -> email in KV
        const sessionId = crypto.randomUUID();
        if (env.TOKENS) {
          await env.TOKENS.put(`session:${sessionId}`, email);
        }

        // Return an HTML page that notifies the opener and closes the popup, and sets a secure HttpOnly cookie
        const cookie = `ca_session=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*30}`;
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Auth complete</title></head><body>
        <script>
          try {
            window.opener.postMessage({ type: 'cloudassistant:gauth', email: ${JSON.stringify(email)} }, '*');
          } catch(e) {}
          document.write('Authentication successful for ${email}. You can close this window.');
          setTimeout(()=>window.close(), 1200);
        </script>
        </body></html>`;

        return new Response(html, { headers: { 'Content-Type': 'text/html', 'Set-Cookie': cookie } });
      }

      if (pathname.startsWith('/api/drive/list')) {
        // Prefer session cookie. If absent, allow ?email= fallback for backward compatibility.
        let email = null;
        const cookie = request.headers.get('Cookie') || '';
        const match = cookie.match(/(?:^|; )ca_session=([^;]+)/);
        if (match) {
          const sessionId = match[1];
          if (env.TOKENS) {
            email = await env.TOKENS.get(`session:${sessionId}`);
          }
        }

        if (!email) {
          email = url.searchParams.get('email');
        }
        if (!email) return new Response('Missing authenticated session or email param', { status: 401 });

        const tokenRaw = env.TOKENS && await env.TOKENS.get(`google:${email}`);
        if (!tokenRaw) return new Response('No tokens for this user. Authenticate first.', { status: 401 });
        let token = JSON.parse(tokenRaw);

        // Try to call Drive API; if unauthorized, attempt refresh
        let filesRes = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=20&fields=files(id,name,mimeType,modifiedTime)', { headers: { Authorization: `Bearer ${token.access_token}` } });
        if (filesRes.status === 401 && token.refresh_token) {
          try {
            const refreshed = await refreshGoogleToken(token.refresh_token, env, url.origin + '/auth/google/callback');
            // persist refreshed token (keep refresh_token)
            const updated = Object.assign({}, token, {
              access_token: refreshed.access_token,
              expires_in: refreshed.expires_in,
              obtained_at: Date.now(),
              refresh_token: refreshed.refresh_token || token.refresh_token
            });
            if (env.TOKENS) await env.TOKENS.put(`google:${email}`, JSON.stringify(updated));
            token = updated;
            filesRes = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=20&fields=files(id,name,mimeType,modifiedTime)', { headers: { Authorization: `Bearer ${token.access_token}` } });
          } catch (e) {
            return new Response('Failed to refresh Google token: ' + String(e), { status: 500 });
          }
        }

        const filesJson = await filesRes.json();

        return new Response(JSON.stringify(filesJson), { headers: { 'Content-Type': 'application/json' } });
      }
      }

      if (pathname === '/api/chat/gemini' && request.method === 'POST') {
        // Proxy a chat request to Gemini. Accepts JSON { prompt }.
        // The request is authenticated via session cookie set at OAuth callback.
        const body = await request.json().catch(()=>({}));
        const prompt = body.prompt || '';

        // Determine email via session cookie if available
        let email = null;
        const cookie = request.headers.get('Cookie') || '';
        const match = cookie.match(/(?:^|; )ca_session=([^;]+)/);
        if (match && env.TOKENS) {
          email = await env.TOKENS.get(`session:${match[1]}`);
        }

        // Optionally enrich prompt with Drive file metadata and small snippets
        let enrichment = '';
        if (email && env.TOKENS) {
          const tokenRaw = await env.TOKENS.get(`google:${email}`);
          if (tokenRaw) {
            const tok = JSON.parse(tokenRaw);
            try {
              const filesRes = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=5&fields=files(id,name,mimeType)', { headers: { Authorization: `Bearer ${tok.access_token}` } });
              const files = await filesRes.json();
              const list = (files.files || []).map(f=>`- ${f.name} (${f.mimeType})`).join('\n');
              enrichment = '\n\n[User Drive files]\n' + list;

              // Try to fetch small snippets for text-like files (first 2)
              const snippets = [];
              for (let i=0;i<Math.min(2, (files.files||[]).length); i++){
                const f = files.files[i];
                try{
                  let content = '';
                  if (f.mimeType === 'application/vnd.google-apps.document'){
                    // export Google Doc as plain text
                    const exp = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
                    content = await exp.text().catch(()=>'');
                  } else {
                    const down = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
                    content = await down.text().catch(()=>'');
                  }
                  if (content) snippets.push({name:f.name, text: content.slice(0, 800)});
                }catch(e){/* ignore snippet fetch errors */}
              }
              if (snippets.length) {
                enrichment += '\n\n[File snippets]\n' + snippets.map(s=>`--- ${s.name} ---\n${s.text}\n`).join('\n');
              }
            } catch (e) {
              // ignore enrichment failures
            }
          }
        }

        const finalPrompt = prompt + enrichment;

        // Proxy to Gemini API (user must provide GEMINI_API_URL and GEMINI_API_KEY as secrets)
        if (!env.GEMINI_API_URL || !env.GEMINI_API_KEY) return new Response('Gemini API not configured on this Worker (set GEMINI_API_URL and GEMINI_API_KEY).', { status: 500 });

        const gRes = await fetch(env.GEMINI_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GEMINI_API_KEY}` },
          body: JSON.stringify({ prompt: finalPrompt })
        });
        const gText = await gRes.text();
        return new Response(gText, { headers: { 'Content-Type': 'application/json' } });
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return new Response('Worker error: ' + String(err), { status: 500 });
    }
  }
};

async function refreshGoogleToken(refreshToken, env, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const json = await res.json();
  if (json.error) throw new Error('Refresh failed: ' + JSON.stringify(json));
  // we don't know the user email here — caller must handle storing updated token
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || refreshToken,
    expires_in: json.expires_in,
    obtained_at: Date.now()
  };
}
