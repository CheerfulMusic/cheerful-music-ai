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
    schemaReady: false,
    tables: {
      users: false,
      songs: false,
      royaltyRules: false,
      royaltyImports: false
    }
  };

  if (!config.databaseConfigured) return json(res, 503, result);

  const checks = await Promise.allSettled([
    serviceRequest('users?select=id&limit=1'),
    serviceRequest('songs?select=id&limit=1'),
    serviceRequest('royalty_rules?select=id&limit=1'),
    serviceRequest('royalty_imports?select=id&limit=1')
  ]);
  result.tables.users = checks[0].status === 'fulfilled';
  result.tables.songs = checks[1].status === 'fulfilled';
  result.tables.royaltyRules = checks[2].status === 'fulfilled';
  result.tables.royaltyImports = checks[3].status === 'fulfilled';
  result.schemaReady = Object.values(result.tables).every(Boolean);
  result.ok = result.schemaReady;
  return json(res, result.ok ? 200 : 503, result);
};
