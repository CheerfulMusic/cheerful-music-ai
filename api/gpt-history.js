const { isAllowedOrigin, requireSession } = require('./_gpt-auth');
const { readMessages } = require('./_gpt-store');

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
  const user = requireSession(req, res, 'history');
  if (!user) return;
  const result = await readMessages(user.sub, 160);
  return res.end(JSON.stringify({ storage: result.configured ? 'supabase' : 'local', messages: result.data || [] }));
};
