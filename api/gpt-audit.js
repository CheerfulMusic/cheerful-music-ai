const { isAllowedOrigin, requireSession } = require('./_gpt-auth');
const { readAudit } = require('./_gpt-store');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
  if (!isAllowedOrigin(req)) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: '不允许的请求来源。' }));
  }
  const user = requireSession(req, res, 'audit_view');
  if (!user) return;
  const result = await readAudit(120);
  return res.end(JSON.stringify({ storage: result.configured ? 'supabase' : 'vercel_logs', events: result.data || [] }));
};
