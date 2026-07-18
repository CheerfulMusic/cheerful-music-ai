const {
  authenticateAccessCode,
  authenticateCredentials,
  clearSessionCookie,
  isAllowedOrigin,
  issueSession,
  permissionsFor,
  readSession,
  setSessionCookie
} = require('./_gpt-auth');
const { writeAudit } = require('./_gpt-store');
const { signInWithPassword } = require('./_supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!isAllowedOrigin(req)) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: '不允许的请求来源。' }));
  }

  if (req.method === 'GET') {
    try {
      const user = readSession(req);
      return res.end(JSON.stringify(user ? {
        authenticated: true,
        user: { id: user.sub, name: user.name, email: user.email || '', role: user.role, permissions: permissionsFor(user.role) }
      } : { authenticated: false }));
    } catch (error) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: error.message, code: error.code }));
    }
  }

  if (req.method === 'DELETE') {
    clearSessionCookie(res);
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  const body = req.body || {};
  const code = String(body.accessCode || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  let user = null;
  if (email) {
    try {
      const supabaseAuth = await signInWithPassword(email, password);
      user = supabaseAuth.user || authenticateCredentials(email, password);
    } catch (error) {
      console.error(JSON.stringify({ type: 'cheerful_supabase_auth_error', message: error.message }));
      user = authenticateCredentials(email, password);
    }
  } else {
    user = authenticateAccessCode(code);
  }
  if (!user) {
    res.statusCode = 401;
    await writeAudit({ actorId: 'anonymous', actorName: 'Unknown', actorRole: 'none', action: 'session.denied' });
    return res.end(JSON.stringify({ error: email ? '邮箱或密码错误。' : '访问码无效。' }));
  }

  try {
    setSessionCookie(res, issueSession(user));
  } catch (error) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: error.message, code: error.code }));
  }
  await writeAudit({ actorId: user.id, actorName: user.name, actorRole: user.role, action: 'session.created' });
  return res.end(JSON.stringify({
    authenticated: true,
    user: { id: user.id, name: user.name, email: user.email || '', role: user.role, permissions: permissionsFor(user.role) }
  }));
};
