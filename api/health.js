const { serviceRequest, supabaseConfig } = require('./_supabase');

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function safeFailureCode(reason) {
  const message = String(reason && reason.message || reason || '');
  if (/Supabase 401\b/.test(message)) return 'secret_key_rejected';
  if (/Supabase 403\b/.test(message)) return 'secret_key_forbidden';
  if (/Supabase 404\b/.test(message)) return 'rest_endpoint_or_schema_not_found';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) return 'project_url_unreachable';
  return 'database_request_failed';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false });

  const config = supabaseConfig();
  const result = {
    ok: false,
    supabaseConfigured: config.databaseConfigured,
    authConfigured: config.authConfigured,
    schemaReady: false,
    financeWorkflowReady: false,
    tables: {
      users: false,
      songs: false,
      royaltyRules: false,
      royaltyImports: false,
      royaltyImportRows: false,
      royaltyCalculationRuns: false,
      royaltyCalculationLines: false,
      financeExceptions: false
    }
  };

  if (!config.databaseConfigured) return json(res, 503, result);

  const checks = await Promise.allSettled([
    serviceRequest('users?select=id&limit=1'),
    serviceRequest('songs?select=id&limit=1'),
    serviceRequest('royalty_rules?select=id&limit=1'),
    serviceRequest('royalty_imports?select=id&limit=1'),
    serviceRequest('royalty_import_rows?select=id&limit=1'),
    serviceRequest('royalty_calculation_runs?select=id&limit=1'),
    serviceRequest('royalty_calculation_lines?select=id&limit=1'),
    serviceRequest('finance_exceptions?select=id&limit=1')
  ]);
  result.tables.users = checks[0].status === 'fulfilled';
  result.tables.songs = checks[1].status === 'fulfilled';
  result.tables.royaltyRules = checks[2].status === 'fulfilled';
  result.tables.royaltyImports = checks[3].status === 'fulfilled';
  result.tables.royaltyImportRows = checks[4].status === 'fulfilled';
  result.tables.royaltyCalculationRuns = checks[5].status === 'fulfilled';
  result.tables.royaltyCalculationLines = checks[6].status === 'fulfilled';
  result.tables.financeExceptions = checks[7].status === 'fulfilled';
  result.schemaReady = ['users', 'songs', 'royaltyRules', 'royaltyImports', 'royaltyImportRows'].every(key => result.tables[key]);
  result.financeWorkflowReady = ['royaltyCalculationRuns', 'royaltyCalculationLines', 'financeExceptions'].every(key => result.tables[key]);
  result.ok = result.schemaReady && result.financeWorkflowReady;
  if (!result.ok) {
    const firstFailure = checks.find(check => check.status === 'rejected');
    result.failureCode = safeFailureCode(firstFailure && firstFailure.reason);
  }
  return json(res, result.ok ? 200 : 503, result);
};
