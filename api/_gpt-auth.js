const crypto = require('crypto');

const COOKIE_NAME = 'cm_gpt_session';
const SESSION_SECONDS = 60 * 60 * 12;

const ROLE_PERMISSIONS = Object.freeze({
  ceo: ['chat', 'web_search', 'internal_context', 'catalog_context', 'financial_data', 'hr_data', 'legal_data', 'file_upload', 'history', 'audit_view', 'developer_mode', 'user_admin', 'song_library_read', 'song_library_write', 'royalty_rules_read', 'royalty_rules_write', 'platform_royalty_read', 'platform_royalty_write', 'song_matching_read', 'song_matching_write', 'royalty_calculation', 'financial_reports', 'contracts_full', 'recruitment_read', 'recruitment_write'],
  finance: ['chat', 'web_search', 'internal_context', 'catalog_context', 'financial_data', 'file_upload', 'history', 'song_library_read', 'song_library_write', 'royalty_rules_read', 'royalty_rules_write', 'platform_royalty_read', 'platform_royalty_write', 'song_matching_read', 'song_matching_write', 'royalty_calculation', 'financial_reports', 'contracts_limited'],
  ar: ['chat', 'web_search', 'internal_context', 'catalog_context', 'music_data', 'file_upload', 'history', 'song_library_read', 'song_library_write', 'song_matching_read', 'song_matching_write'],
  hr: ['chat', 'web_search', 'internal_context', 'hr_data', 'file_upload', 'history', 'recruitment_read', 'recruitment_write'],
  copyright: ['chat', 'web_search', 'history'],
  distribution: ['chat', 'web_search', 'history'],
  marketing: ['chat', 'web_search', 'history'],
  legal: ['chat', 'web_search', 'internal_context', 'legal_data', 'file_upload', 'history', 'contracts_full'],
  admin: ['chat', 'web_search', 'history', 'audit_view', 'developer_mode'],
  member: ['chat', 'web_search', 'history'],
  viewer: ['chat', 'web_search', 'history']
});

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function unb64url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sessionSecret() {
  const secret = process.env.CHEERFUL_GPT_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    const error = new Error('CHEERFUL_GPT_SESSION_SECRET 尚未配置，或长度不足 32 位。');
    error.code = 'SESSION_NOT_CONFIGURED';
    throw error;
  }
  return secret;
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function issueSession(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    sub: user.id || crypto.randomUUID(),
    name: user.name || 'Cheerful User',
    email: user.email || '',
    role: ROLE_PERMISSIONS[user.role] ? user.role : 'viewer',
    iat: now,
    exp: now + SESSION_SECONDS
  }));
  return `${payload}.${sign(payload)}`;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(unb64url(payload));
    if (!data.exp || data.exp <= Math.floor(Date.now() / 1000)) return null;
    if (!ROLE_PERMISSIONS[data.role]) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((result, part) => {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return result;
  }, {});
}

function readSession(req) {
  return verifySession(parseCookies(req)[COOKIE_NAME]);
}

function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || [];
}

function requireSession(req, res, permission = 'chat') {
  let user;
  try {
    user = readSession(req);
  } catch (error) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: error.message, code: error.code }));
    return null;
  }
  if (!user) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: '请先验证 Cheerful GPT 访问身份。', code: 'UNAUTHORIZED' }));
    return null;
  }
  const permissions = permissionsFor(user.role);
  if (permission && !permissions.includes(permission)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: '当前角色没有此项权限。', code: 'FORBIDDEN' }));
    return null;
  }
  return { ...user, permissions };
}

function accessUsers() {
  const raw = process.env.CHEERFUL_GPT_ACCESS_KEYS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Object.entries(parsed).map(([code, value], index) => {
      const id = value.id || `user-${index + 1}`;
      return {
        code,
        id,
        name: value.name || `User ${index + 1}`,
        email: String(value.email || (String(id).includes('@') ? id : `${id}@cheerfulmusic.com`)).trim().toLowerCase(),
        role: ROLE_PERMISSIONS[value.role] ? value.role : 'viewer'
      };
    });
  } catch (_) {
    return [];
  }
}

function authenticateAccessCode(code) {
  if (!code) return null;
  return accessUsers().find(user => safeEqual(user.code, code)) || null;
}

function authenticateCredentials(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !password) return null;
  return accessUsers().find(user => safeEqual(user.email, normalizedEmail) && safeEqual(user.code, password)) || null;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}

function isAllowedOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  if (origin === 'https://app.cheerfulmusic.com') return true;
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

module.exports = {
  COOKIE_NAME,
  authenticateAccessCode,
  authenticateCredentials,
  clearSessionCookie,
  isAllowedOrigin,
  issueSession,
  permissionsFor,
  readSession,
  requireSession,
  setSessionCookie
};
