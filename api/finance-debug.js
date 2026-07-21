const crypto = require('crypto');
const { isAllowedOrigin, requireSession } = require('./_gpt-auth');
const { serviceRequest, supabaseConfig } = require('./_supabase');
const { readAudit, writeAudit } = require('./_gpt-store');

const MAX_PAGE_SIZE = 100;
const SNAPSHOT_LIMIT = 10000;
const TABLES = Object.freeze({
  users: { label: 'Users', order: 'updated_at', search: ['email', 'display_name', 'role', 'department'], readOnly: true },
  songs: { label: 'Songs', order: 'updated_at', search: ['work_id', 'title', 'iswc', 'label', 'copyright_owner'] },
  recordings: { label: 'Recordings', order: 'updated_at', search: ['recording_id', 'isrc', 'version_name', 'artist_name', 'upc'] },
  payees: { label: 'Payees', order: 'updated_at', search: ['payee_code', 'name', 'email', 'country'] },
  royalty_imports: { label: 'Royalty Imports', order: 'updated_at', search: ['batch_no', 'platform', 'original_filename', 'currency', 'status'] },
  royalty_rules: { label: 'Royalty Rules', order: 'updated_at', search: ['rule_code', 'artist_name', 'payee_name', 'role', 'royalty_type', 'platform'] },
  royalty_rule_imports: { label: 'Royalty Rule Imports', order: 'updated_at', search: ['batch_no', 'original_filename', 'status', 'schema_version'] },
  royalty_rule_review_queue: { label: 'Royalty Rule Review Queue', order: 'updated_at', search: ['review_key', 'status', 'reason', 'match_method'] },
  royalty_import_rows: { label: 'Royalty Import Rows', order: 'created_at', search: ['match_status', 'match_method', 'platform', 'territory', 'currency', 'error_reason'] },
  royalty_calculation_runs: { label: 'Royalty Calculation Runs', order: 'updated_at', search: ['run_no', 'status', 'base_currency'] },
  royalty_calculation_lines: { label: 'Royalty Calculation Lines', order: 'created_at', search: ['payee_name', 'royalty_type', 'calculation_basis', 'currency', 'status'] },
  finance_exceptions: { label: 'Finance Exceptions', order: 'updated_at', search: ['exception_key', 'exception_type', 'risk_level', 'subject', 'status'] },
  hr_records: { label: 'HR Records', order: 'updated_at', search: ['employee_name', 'department', 'job_title', 'employment_status'] },
  recruitment_records: { label: 'Recruitment Records', order: 'updated_at', search: ['candidate_name', 'position', 'status'] },
  contracts: { label: 'Contracts', order: 'updated_at', search: ['contract_no', 'title', 'counterparty', 'contract_type', 'status'] },
  legal_records: { label: 'Legal Records', order: 'updated_at', search: ['title', 'record_type', 'status'] },
  gpt_chat_messages: { label: 'GPT Chat Messages', order: 'created_at', search: ['conversation_id', 'actor_name', 'actor_role', 'role'], readOnly: true },
  gpt_audit_logs: { label: 'GPT Audit Logs', order: 'created_at', search: ['actor_name', 'actor_role', 'action', 'conversation_id'], readOnly: true }
});

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(payload));
}

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function maskedDatabaseUrl(value) {
  try {
    const url = new URL(value);
    const pieces = url.hostname.split('.');
    const project = pieces[0] || '';
    const masked = project.length > 8 ? `${project.slice(0, 4)}••••${project.slice(-4)}` : '••••';
    return `${url.protocol}//${masked}.${pieces.slice(1).join('.')}`;
  } catch (_) {
    return '未配置';
  }
}

function projectId(value) {
  try { return new URL(value).hostname.split('.')[0] || 'unknown'; }
  catch (_) { return 'unknown'; }
}

function safeSearch(value) {
  return text(value, 120).replace(/[^\p{L}\p{N}\s@._-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tableConfiguration(name) {
  const key = text(name, 80);
  if (!TABLES[key]) throw Object.assign(new Error('Unknown or protected table'), { statusCode: 404 });
  return { name: key, ...TABLES[key] };
}

function queryString(entries) {
  const params = new URLSearchParams();
  Object.entries(entries).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  });
  return params.toString();
}

async function audit(user, action, metadata) {
  await writeAudit({ actorId: user.sub, actorName: user.name, actorRole: user.role, action, metadata: metadata || {} });
}

async function tableState(name) {
  const config = tableConfiguration(name);
  const params = queryString({ select: config.order, order: `${config.order}.desc`, limit: 1 });
  const result = await serviceRequest(`${config.name}?${params}`, { headers: { Prefer: 'count=exact' } });
  const row = Array.isArray(result.data) ? result.data[0] : null;
  return {
    name: config.name,
    label: config.label,
    rowCount: Number.isFinite(result.count) ? result.count : 0,
    lastUpdated: row && row[config.order] || null,
    readOnly: Boolean(config.readOnly)
  };
}

async function allTableStates() {
  return Promise.all(Object.keys(TABLES).map(async name => {
    try { return await tableState(name); }
    catch (error) {
      return { name, label: TABLES[name].label, rowCount: null, lastUpdated: null, readOnly: Boolean(TABLES[name].readOnly), error: text(error.message) };
    }
  }));
}

async function readTable(name, options = {}) {
  const config = tableConfiguration(name);
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(options.pageSize) || 50));
  const search = safeSearch(options.search);
  const params = {
    select: '*',
    order: `${config.order}.desc`,
    offset: (page - 1) * pageSize,
    limit: pageSize
  };
  if (search && config.search.length) {
    params.or = `(${config.search.map(column => `${column}.ilike.*${search}*`).join(',')})`;
  }
  const result = await serviceRequest(`${config.name}?${queryString(params)}`, { headers: { Prefer: 'count=exact' } });
  return {
    table: config.name,
    data: Array.isArray(result.data) ? result.data : [],
    total: Number.isFinite(result.count) ? result.count : 0,
    page,
    pageSize,
    readOnly: Boolean(config.readOnly)
  };
}

function sanitizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Record must be a JSON object'), { statusCode: 400 });
  const output = {};
  Object.entries(value).slice(0, 100).forEach(([key, item]) => {
    if (/^[a-z][a-z0-9_]{0,62}$/i.test(key) && key !== 'created_at' && key !== 'updated_at') output[key] = item;
  });
  if (!Object.keys(output).length) throw Object.assign(new Error('No writable fields were provided'), { statusCode: 400 });
  return output;
}

async function runCrud(user, body) {
  const started = Date.now();
  const operation = text(body.operation, 20).toLowerCase();
  const config = tableConfiguration(body.table);
  if (config.readOnly && operation !== 'read') throw Object.assign(new Error(`${config.name} is read-only in Developer Console`), { statusCode: 403 });
  let result;
  if (operation === 'read') {
    result = await readTable(config.name, body);
  } else if (operation === 'insert') {
    result = await serviceRequest(config.name, {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(sanitizeRecord(body.record))
    });
    result = { data: result.data || [] };
  } else if (operation === 'update') {
    const id = text(body.id, 120);
    if (!id) throw Object.assign(new Error('Update requires a record ID'), { statusCode: 400 });
    result = await serviceRequest(`${config.name}?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(sanitizeRecord(body.record || body.changes))
    });
    result = { data: result.data || [] };
  } else if (operation === 'delete') {
    const id = text(body.id, 120);
    if (!id) throw Object.assign(new Error('Delete requires a record ID'), { statusCode: 400 });
    result = await serviceRequest(`${config.name}?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { Prefer: 'return=representation' }
    });
    result = { data: result.data || [] };
  } else {
    throw Object.assign(new Error('Operation must be read, insert, update, or delete'), { statusCode: 400 });
  }
  const executionMs = Date.now() - started;
  await audit(user, 'developer.crud.executed', { table: config.name, operation, executionMs, affected: Array.isArray(result.data) ? result.data.length : result.total || 0 });
  return { success: true, operation, table: config.name, executionMs, result };
}

function createdBy(user) {
  return /^[0-9a-f-]{36}$/i.test(String(user.sub || '')) ? user.sub : null;
}

async function insertTestSong(user, suffix = 'TEST-001') {
  const workId = suffix === 'TEST-001' ? 'DEV-W-TEST-001' : `DEV-W-${suffix}`;
  const recordingId = suffix === 'TEST-001' ? 'DEV-R-TEST-001' : `DEV-R-${suffix}`;
  const creator = createdBy(user);
  const songs = await serviceRequest('songs?on_conflict=work_id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ work_id: workId, title: suffix === 'TEST-001' ? 'Test Song' : `Fake Song ${suffix}`, status: 'unreleased', notes: '[DEV TEST] Developer Console', ...(creator ? { created_by: creator } : {}) })
  });
  const song = Array.isArray(songs.data) ? songs.data[0] : null;
  if (!song || !song.id) throw new Error('Test song work record was not returned');
  const recordings = await serviceRequest('recordings?on_conflict=recording_id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ recording_id: recordingId, song_id: song.id, artist_name: 'Developer', version_name: 'Test', version_type: 'Test', isrc: suffix === 'TEST-001' ? 'TEST-001' : `DEV-${suffix}`, status: 'unreleased', notes: '[DEV TEST] Developer Console', ...(creator ? { created_by: creator } : {}) })
  });
  const recording = Array.isArray(recordings.data) ? recordings.data[0] : null;
  if (!recording || !recording.id) throw new Error('Test recording was not returned');
  await audit(user, 'developer.test_song.inserted', { workId, recordingId, songId: song.id, recordingUuid: recording.id });
  return { song, recording };
}

async function insertTestRoyalty(user) {
  const test = await insertTestSong(user);
  const creator = createdBy(user);
  const result = await serviceRequest('royalty_rules?on_conflict=rule_code', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      rule_code: 'DEV-RULE-TEST-001', song_id: test.song.id, recording_id: test.recording.id,
      artist_name: 'Developer', payee_name: 'Developer', role: 'Artist', royalty_type: 'Artist Royalty',
      share_percentage: 25, calculation_basis: 'Net Receipts', effective_date: '2026-01-01', territory: 'Worldwide',
      platform: 'All', status: 'active', notes: '[DEV TEST] Developer Console', ...(creator ? { created_by: creator } : {})
    })
  });
  await audit(user, 'developer.test_royalty.inserted', { ruleCode: 'DEV-RULE-TEST-001' });
  return Array.isArray(result.data) ? result.data[0] : null;
}

async function generateFakeSongLibrary(user) {
  const records = [];
  for (let index = 1; index <= 5; index += 1) records.push(await insertTestSong(user, `FAKE-${String(index).padStart(3, '0')}`));
  await audit(user, 'developer.fake_song_library.generated', { count: records.length });
  return records;
}

async function generateFakeRoyaltyReport(user) {
  const test = await insertTestSong(user);
  const batchNo = `DEV-IMP-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  const uploader = createdBy(user);
  const imports = await serviceRequest('royalty_imports', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ batch_no: batchNo, platform: 'Developer DSP', original_filename: 'developer-fake-report.csv', currency: 'USD', status: 'ready', total_rows: 2, imported_rows: 2, total_amount: 15.75, metadata: { testData: true }, ...(uploader ? { uploaded_by: uploader } : {}) })
  });
  const batch = Array.isArray(imports.data) ? imports.data[0] : null;
  if (!batch || !batch.id) throw new Error('Fake royalty import was not returned');
  const rows = [
    {
      import_id: batch.id,
      source_row_number: 1,
      raw_data: { title: 'Test Song', artist: 'Developer', isrc: 'TEST-001' },
      song_id: test.song.id,
      recording_id: test.recording.id,
      match_status: 'matched',
      match_method: 'ISRC',
      confidence: 1,
      platform: 'Developer DSP',
      territory: null,
      usage_date: '2026-01-01',
      currency: 'USD',
      gross_amount: 10,
      fees: 0.5,
      tax_amount: 0,
      net_amount: 9.5,
      error_reason: null
    },
    {
      import_id: batch.id,
      source_row_number: 2,
      raw_data: { title: 'Unknown Song', artist: 'Unknown Artist', isrc: '' },
      song_id: null,
      recording_id: null,
      match_status: 'review',
      match_method: null,
      confidence: 0,
      platform: 'Developer DSP',
      territory: null,
      usage_date: '2026-01-01',
      currency: 'USD',
      gross_amount: 6.25,
      fees: 0,
      tax_amount: 0,
      net_amount: 6.25,
      error_reason: 'Developer review test'
    }
  ];
  await serviceRequest('royalty_import_rows', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(rows) });
  await audit(user, 'developer.fake_royalty_report.generated', { batchNo, rows: rows.length });
  return { batchNo, rows: rows.length };
}

async function deleteTestData(user) {
  const deletions = [];
  const devSongsResult = await serviceRequest('songs?work_id=like.DEV-*&select=id');
  const devSongIds = (Array.isArray(devSongsResult.data) ? devSongsResult.data : []).map(item => item.id).filter(Boolean);
  const linkedFilters = devSongIds.length
    ? [
        ['royalty_rules', `song_id=in.(${devSongIds.join(',')})`],
        ['recordings', `song_id=in.(${devSongIds.join(',')})`]
      ]
    : [];
  for (const [table, filter] of [
    // Delete imports first so their calculation runs, lines, import rows and
    // exceptions cascade before rules and recordings referenced by those rows.
    ['royalty_imports', 'batch_no=like.DEV-*'],
    ['royalty_rules', 'rule_code=like.DEV-*'],
    // UI-created test recordings receive the normal CM-R identifier, so clean
    // them by their DEV work relationship as well as by a DEV recording code.
    ...linkedFilters,
    ['recordings', 'recording_id=like.DEV-*'],
    ['songs', 'work_id=like.DEV-*']
  ]) {
    const result = await serviceRequest(`${table}?${filter}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
    deletions.push({ table, deleted: Array.isArray(result.data) ? result.data.length : 0 });
  }
  await audit(user, 'developer.test_data.deleted', { deletions });
  return deletions;
}

async function monitorPayload(user, config) {
  const [messages, audits] = await Promise.all([
    serviceRequest('gpt_chat_messages?select=role,content,created_at&order=created_at.desc&limit=20').catch(() => ({ data: [] })),
    readAudit(200)
  ]);
  const messageRows = Array.isArray(messages.data) ? messages.data : [];
  const auditRows = Array.isArray(audits.data) ? audits.data : [];
  const completed = auditRows.find(item => item.action === 'chat.completed');
  const lastError = auditRows.find(item => /chat\.(failed|error)$/.test(item.action || ''));
  return {
    supabase: {
      connected: config.databaseConfigured,
      currentUser: { name: user.name, email: user.email, role: user.role },
      currentRole: user.role,
      projectId: projectId(config.url),
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
      databaseUrl: maskedDatabaseUrl(config.url),
      realtimeStatus: config.databaseConfigured ? 'Available · not subscribed on this page' : 'Unavailable',
      timestamp: new Date().toISOString()
    },
    openai: {
      model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      apiStatus: process.env.OPENAI_API_KEY ? 'Configured' : 'Not configured',
      quotaStatus: 'Not exposed by the OpenAI API',
      lastPrompt: messageRows.find(item => item.role === 'user') || null,
      lastResponse: messageRows.find(item => item.role === 'assistant') || null,
      lastError: lastError || null,
      tokenUsage: completed && completed.metadata && completed.metadata.usage || null
    },
    errors: auditRows.filter(item => /(failed|denied|error)/i.test(item.action || '')).slice(0, 100),
    activity: auditRows.slice(0, 200)
  };
}

async function databaseSnapshot() {
  const snapshot = {};
  for (const name of Object.keys(TABLES)) {
    const config = tableConfiguration(name);
    try {
      const result = await serviceRequest(`${name}?${queryString({ select: '*', order: `${config.order}.desc`, limit: SNAPSHOT_LIMIT })}`);
      snapshot[name] = Array.isArray(result.data) ? result.data : [];
    } catch (error) {
      snapshot[name] = { error: text(error.message) };
    }
  }
  return { generatedAt: new Date().toISOString(), maxRowsPerTable: SNAPSHOT_LIMIT, tables: snapshot };
}

module.exports = async function handler(req, res) {
  if (!isAllowedOrigin(req)) return json(res, 403, { error: '不允许的请求来源。' });
  const user = requireSession(req, res, 'developer_mode');
  if (!user) return;
  if (!['ceo', 'admin'].includes(user.role)) return json(res, 403, { error: 'Developer Console 仅限 CEO 或管理员。', code: 'FORBIDDEN' });
  const config = supabaseConfig();
  if (!config.databaseConfigured) return json(res, 503, { error: 'Supabase 尚未连接。' });
  const action = text((req.query && req.query.action) || (req.body && req.body.action) || 'status', 80);

  try {
    if (req.method === 'GET' && action === 'status') return json(res, 200, (await monitorPayload(user, config)).supabase);
    if (req.method === 'GET' && action === 'tables') {
      const tables = await allTableStates();
      await audit(user, 'developer.database_explorer.queried', { tables: tables.length });
      return json(res, 200, { tables });
    }
    if (req.method === 'GET' && action === 'table') {
      const result = await readTable(req.query && req.query.table, req.query || {});
      await audit(user, 'developer.table.queried', { table: result.table, page: result.page, count: result.data.length });
      return json(res, 200, result);
    }
    if (req.method === 'GET' && ['songs', 'royalty_rules', 'royalty_imports'].includes(action)) {
      const table = action;
      return json(res, 200, await readTable(table, { page: 1, pageSize: action === 'songs' ? 50 : 100 }));
    }
    if (req.method === 'GET' && action === 'monitors') return json(res, 200, await monitorPayload(user, config));
    if (req.method === 'GET' && action === 'logs') {
      const data = await monitorPayload(user, config);
      return json(res, 200, { activity: data.activity, errors: data.errors });
    }
    if (req.method === 'GET' && action === 'snapshot') {
      await audit(user, 'developer.database_snapshot.requested');
      return json(res, 200, await databaseSnapshot());
    }
    if (req.method === 'POST' && action === 'crud') return json(res, 200, await runCrud(user, req.body || {}));
    if (req.method === 'POST' && action === 'insert-test-song') return json(res, 201, { ok: true, record: await insertTestSong(user) });
    if (req.method === 'POST' && action === 'insert-test-royalty') return json(res, 201, { ok: true, record: await insertTestRoyalty(user) });
    if (req.method === 'POST' && action === 'delete-test-data') return json(res, 200, { ok: true, result: await deleteTestData(user) });
    if (req.method === 'POST' && action === 'generate-fake-royalty-report') return json(res, 201, { ok: true, result: await generateFakeRoyaltyReport(user) });
    if (req.method === 'POST' && action === 'generate-fake-song-library') return json(res, 201, { ok: true, result: await generateFakeSongLibrary(user) });
    if (req.method === 'POST' && ['health', 'reload-schema', 'refresh-database'].includes(action)) {
      const tables = await allTableStates();
      await audit(user, `developer.${action}.completed`, { ready: tables.every(item => !item.error) });
      return json(res, 200, { ok: tables.every(item => !item.error), action, tables, timestamp: new Date().toISOString() });
    }
    return json(res, 405, { error: 'Unsupported developer action' });
  } catch (error) {
    await audit(user, 'developer.query.failed', { action, error: text(error.message) });
    return json(res, error.statusCode || 500, { error: 'Developer Console operation failed', detail: text(error.message), success: false });
  }
};
