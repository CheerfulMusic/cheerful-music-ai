const { serviceRequest, supabaseConfig } = require('./_supabase');

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false });

  const config = supabaseConfig();
  const result = {
    ok: false,
    supabaseConfigured: config.databaseConfigured,
    authConfigured: config.authConfigured,
    schemaReady: false
  };

  if (!config.databaseConfigured) return json(res, 503, result);

  try {
    await Promise.all([
      serviceRequest('users?select=id&limit=1'),
      serviceRequest('songs?select=id&limit=1'),
      serviceRequest('royalty_rules?select=id&limit=1'),
      serviceRequest('royalty_imports?select=id&limit=1')
    ]);
    result.ok = true;
    result.schemaReady = true;
    return json(res, 200, result);
  } catch (error) {
    return json(res, 503, result);
  }
};
