const assert = require('assert');
const fs = require('fs');
const path = require('path');

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`));
}

function responseMock() {
  let resolveEnd;
  const ended = new Promise(resolve => { resolveEnd = resolve; });
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    write(value) { this.chunks.push(String(value)); },
    end(value) { if (value) this.chunks.push(String(value)); resolveEnd(); }
  };
}

async function main() {
  process.env.SUPABASE_URL = 'https://cheerful-test.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.CHEERFUL_GPT_SESSION_SECRET = 'test-session-secret-that-is-longer-than-thirty-two-characters';

  const supabase = require('./api/_supabase');
  const auth = require('./api/_gpt-auth');

  await test('health endpoint confirms configuration and required database tables without exposing secrets', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      assert.ok(
        ['/users?', '/songs?', '/royalty_rules?', '/royalty_imports?', '/royalty_import_rows?', '/royalty_calculation_runs?', '/royalty_calculation_lines?', '/finance_exceptions?'].some(part => url.includes(part)),
        `Unexpected health-check URL: ${url}`
      );
      return new Response('[]', { status: 200 });
    };
    try {
      const health = require('./api/health');
      const req = { method: 'GET', headers: {} };
      const res = responseMock();
      await health(req, res);
      const payload = JSON.parse(res.chunks.join(''));
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(payload, {
        ok: true,
        supabaseConfigured: true,
        authConfigured: true,
        schemaReady: true,
        financeWorkflowReady: true,
        tables: {
          users: true,
          songs: true,
          royaltyRules: true,
          royaltyImports: true,
          royaltyImportRows: true,
          royaltyCalculationRuns: true,
          royaltyCalculationLines: true,
          financeExceptions: true
        }
      });
      assert.ok(!res.chunks.join('').includes(process.env.SUPABASE_URL));
      assert.ok(!res.chunks.join('').includes(process.env.SUPABASE_SECRET_KEY));
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('health endpoint reports only a safe failure category when the secret key is rejected', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response('{"message":"Invalid API key"}', { status: 401 });
    try {
      const health = require('./api/health');
      const req = { method: 'GET', headers: {} };
      const res = responseMock();
      await health(req, res);
      const payload = JSON.parse(res.chunks.join(''));
      assert.strictEqual(res.statusCode, 503);
      assert.strictEqual(payload.failureCode, 'secret_key_rejected');
      assert.ok(!res.chunks.join('').includes('Invalid API key'));
      assert.ok(!res.chunks.join('').includes(process.env.SUPABASE_SECRET_KEY));
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('new Supabase publishable and secret keys are supported without browser exposure', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/auth/v1/token')) {
        return new Response(JSON.stringify({ user: { id: '11111111-1111-4111-8111-111111111111', email: 'finance@cheerfulmusic.com' } }), { status: 200 });
      }
      return new Response(JSON.stringify([{
        id: '11111111-1111-4111-8111-111111111111',
        email: 'finance@cheerfulmusic.com',
        display_name: 'Finance',
        role: 'finance',
        department: 'Finance',
        active: true
      }]), { status: 200 });
    };
    try {
      const result = await supabase.signInWithPassword('finance@cheerfulmusic.com', 'test-password');
      assert.strictEqual(result.user.role, 'finance');
      assert.strictEqual(calls[0].options.headers.apikey, 'sb_publishable_test');
      assert.strictEqual(calls[1].options.headers.apikey, 'sb_secret_test');
      assert.strictEqual(calls[0].options.headers.Authorization, undefined);
      assert.strictEqual(calls[1].options.headers.Authorization, undefined);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('server business context reads only Finance-authorized Supabase tables', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      calls.push(url);
      return new Response('[]', { status: 200 });
    };
    try {
      const { readAuthorizedBusinessContext } = require('./api/_business-context');
      const finance = { role: 'finance', permissions: auth.permissionsFor('finance') };
      const result = await readAuthorizedBusinessContext(finance, 'Spotify 版税');
      assert.strictEqual(result.configured, true);
      assert(calls.some(url => url.includes('/rpc/search_music_catalog')));
      assert(calls.some(url => url.includes('/royalty_rules?')));
      assert(!calls.some(url => url.includes('/hr_records?')));
      assert(!calls.some(url => url.includes('/contracts?')));
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('A&R cannot call the royalty-rules data API', async () => {
    const handler = require('./api/os-data');
    const token = auth.issueSession({ id: 'ar-user', name: 'A&R', role: 'ar' });
    const req = {
      method: 'GET',
      query: { resource: 'royalty_rules' },
      headers: { origin: 'https://app.cheerfulmusic.com', cookie: `cm_gpt_session=${encodeURIComponent(token)}` }
    };
    const res = responseMock();
    await handler(req, res);
    const payload = JSON.parse(res.chunks.join(''));
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(payload.code, 'FORBIDDEN');
  });

  await test('Song Library pagination reads all 6,200 recordings instead of stopping at the Supabase 1,000-row limit', async () => {
    const allRows = Array.from({ length: 6200 }, (_, index) => ({
      id: `record-${index + 1}`,
      recording_id: `CM-R-${String(index + 1).padStart(6, '0')}`,
      songs: { work_id: `CM-W-${String(index + 1).padStart(6, '0')}`, title: `Song ${index + 1}` }
    }));
    let pageCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      if (url.includes('/gpt_audit_logs') && options.method === 'POST') return new Response('', { status: 201 });
      if (url.includes('/recordings?select=')) {
        pageCalls += 1;
        const parsed = new URL(url);
        const offset = Number(parsed.searchParams.get('offset') || 0);
        const limit = Number(parsed.searchParams.get('limit') || 1000);
        return new Response(JSON.stringify(allRows.slice(offset, offset + limit)), { status: 200 });
      }
      throw new Error(`Unexpected pagination URL: ${url}`);
    };
    try {
      const handler = require('./api/os-data');
      const token = auth.issueSession({ id: 'ar-pagination-user', name: 'A&R', role: 'ar' });
      const req = { method: 'GET', query: { resource: 'catalog' }, headers: { origin: 'https://app.cheerfulmusic.com', cookie: `cm_gpt_session=${encodeURIComponent(token)}` } };
      const res = responseMock(); await handler(req, res);
      const payload = JSON.parse(res.chunks.join(''));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(payload.data.length, 6200);
      assert.strictEqual(pageCalls, 7);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('A&R catalog sync writes separate works and recordings through server validation', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      if (url.includes('/songs?')) {
        return new Response(JSON.stringify([{ id: '22222222-2222-4222-8222-222222222222', work_id: 'CM-W-1' }]), { status: 200 });
      }
      if (url.includes('/recordings?')) {
        return new Response(JSON.stringify([{ id: '33333333-3333-4333-8333-333333333333', recording_id: 'CM-R-1' }]), { status: 200 });
      }
      if (url.includes('/gpt_audit_logs')) return new Response('', { status: 201 });
      throw new Error(`Unexpected Supabase URL: ${url}`);
    };
    try {
      const handler = require('./api/os-data');
      const token = auth.issueSession({ id: 'ar-user', name: 'A&R', role: 'ar' });
      const req = {
        method: 'POST',
        query: { resource: 'catalog' },
        headers: { origin: 'https://app.cheerfulmusic.com', cookie: `cm_gpt_session=${encodeURIComponent(token)}` },
        body: { resource: 'catalog', records: [{ id: 'CM-R-1', workId: 'CM-W-1', workTitle: '测试歌曲', artist: '测试艺人', isrc: 'TEST-ISRC-1' }] }
      };
      const res = responseMock();
      await handler(req, res);
      const payload = JSON.parse(res.chunks.join(''));
      assert.strictEqual(payload.ok, true);
      assert.strictEqual(calls[0].body[0].work_id, 'CM-W-1');
      assert.strictEqual(calls[1].body[0].recording_id, 'CM-R-1');
      assert.strictEqual(calls[1].body[0].song_id, '22222222-2222-4222-8222-222222222222');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('Song Library completes create, read, update, delete, and refresh persistence through Supabase', async () => {
    const state = { songs: [], recordings: [] };
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const method = options.method || 'GET';
      if (url.includes('/gpt_audit_logs') && method === 'POST') return new Response('', { status: 201 });
      if (url.includes('/songs?on_conflict=work_id') && method === 'POST') {
        const inputs = JSON.parse(options.body); const rows = Array.isArray(inputs) ? inputs : [inputs];
        const output = rows.map(row => {
          const existing = state.songs.find(item => item.work_id === row.work_id);
          if (existing) return Object.assign(existing, row, { updated_at: '2026-07-20T00:00:00Z' });
          const created = Object.assign({ id: '55555555-5555-4555-8555-' + String(state.songs.length + 1).padStart(12, '0'), created_at: '2026-07-20T00:00:00Z' }, row);
          state.songs.push(created); return created;
        });
        return new Response(JSON.stringify(output), { status: 201 });
      }
      if (url.includes('/recordings?on_conflict=recording_id') && method === 'POST') {
        const inputs = JSON.parse(options.body); const rows = Array.isArray(inputs) ? inputs : [inputs];
        const output = rows.map(row => {
          const existing = state.recordings.find(item => item.recording_id === row.recording_id);
          if (existing) return Object.assign(existing, row, { updated_at: '2026-07-20T00:00:00Z' });
          const created = Object.assign({ id: '66666666-6666-4666-8666-' + String(state.recordings.length + 1).padStart(12, '0'), created_at: '2026-07-20T00:00:00Z' }, row);
          state.recordings.push(created); return created;
        });
        return new Response(JSON.stringify(output), { status: 201 });
      }
      if (url.includes('/recordings?select=id,recording_id,isrc')) {
        const nested = state.recordings.map(recording => Object.assign({}, recording, { songs: state.songs.find(song => song.id === recording.song_id) || null }));
        return new Response(JSON.stringify(nested), { status: 200 });
      }
      if (url.includes('/recordings?recording_id=in.') && method === 'GET') {
        return new Response(JSON.stringify(state.recordings.map(item => ({ song_id: item.song_id }))), { status: 200 });
      }
      if (url.includes('/recordings?recording_id=in.') && method === 'DELETE') {
        const deleted = state.recordings.splice(0, state.recordings.length);
        return new Response(JSON.stringify(deleted), { status: 200 });
      }
      if (url.includes('/recordings?song_id=eq.') && method === 'GET') return new Response('[]', { status: 200 });
      if (url.includes('/songs?id=eq.') && method === 'DELETE') {
        state.songs.splice(0, state.songs.length); return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected Supabase URL: ${url} (${method})`);
    };
    try {
      const handler = require('./api/os-data');
      const token = auth.issueSession({ id: 'finance-user', name: 'Finance', role: 'finance' });
      const headers = { origin: 'https://app.cheerfulmusic.com', cookie: `cm_gpt_session=${encodeURIComponent(token)}` };
      async function call(method, body) {
        const req = { method, query: { resource: 'catalog' }, headers, body: body || {} };
        const res = responseMock(); await handler(req, res); return { status: res.statusCode, body: JSON.parse(res.chunks.join('') || '{}') };
      }
      let result = await call('POST', { records: [{ id: 'CM-R-E2E', workId: 'CM-W-E2E', workTitle: 'Persistent Song', artist: 'Artist One', versionName: 'Original', isrc: 'E2E-001' }] });
      assert.strictEqual(result.body.ok, true);
      result = await call('GET');
      assert.strictEqual(result.body.data.length, 1);
      assert.strictEqual(result.body.data[0].songs.title, 'Persistent Song');
      result = await call('POST', { records: [{ id: 'CM-R-E2E', workId: 'CM-W-E2E', workTitle: 'Persistent Song Updated', artist: 'Artist One', versionName: 'Remix', isrc: 'E2E-001' }] });
      assert.strictEqual(result.body.ok, true);
      result = await call('GET');
      assert.strictEqual(result.body.data[0].songs.title, 'Persistent Song Updated');
      assert.strictEqual(result.body.data[0].version_name, 'Remix');
      result = await call('DELETE', { codes: ['CM-R-E2E'] });
      assert.strictEqual(result.body.result.deleted, 1);
      result = await call('GET');
      assert.strictEqual(result.body.data.length, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('AI Finance persists complete import rows, matching, calculation lines, exceptions, and review state', async () => {
    const ids = {
      import: '70000000-0000-4000-8000-000000000001',
      song: '70000000-0000-4000-8000-000000000002',
      recording: '70000000-0000-4000-8000-000000000003',
      rule: '70000000-0000-4000-8000-000000000004',
      run: '70000000-0000-4000-8000-000000000005'
    };
    const state = {
      imports: [], rows: [], runs: [], lines: [], exceptions: [],
      recordings: [{ id: ids.recording, recording_id: 'CM-R-WF', song_id: ids.song }],
      rules: [{ id: ids.rule, rule_code: 'CM-RULE-WF', recording_id: ids.recording, payee_id: null, payee_name: 'Workflow Artist', royalty_type: 'Artist Royalty', share_percentage: 25, calculation_basis: 'Net Receipts', effective_date: '2026-01-01', end_date: null, territory: 'Worldwide', platform: 'All', currency: 'USD', contract_no: 'WF-CONTRACT' }]
    };
    let sequence = 10;
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      if (url.includes('/gpt_audit_logs') && method === 'POST') return new Response('', { status: 201 });
      if (url.includes('/royalty_imports?on_conflict=batch_no') && method === 'POST') {
        const records = Array.isArray(body) ? body : [body];
        const output = records.map(record => {
          const existing = state.imports.find(item => item.batch_no === record.batch_no);
          if (existing) return Object.assign(existing, record);
          const created = Object.assign({ id: ids.import, created_at: '2026-07-21T00:00:00Z' }, record); state.imports.push(created); return created;
        });
        return new Response(JSON.stringify(output), { status: 201 });
      }
      if (url.includes('/royalty_imports?batch_no=in.') && method === 'GET') return new Response(JSON.stringify(state.imports), { status: 200 });
      if (url.includes('/royalty_imports?batch_no=eq.') && method === 'GET') return new Response(JSON.stringify(state.imports), { status: 200 });
      if (url.includes('/recordings?recording_id=in.') && method === 'GET') return new Response(JSON.stringify(state.recordings), { status: 200 });
      if (url.includes('/royalty_import_rows?on_conflict=import_id%2Csource_row_number') && method === 'POST') {
        const records = Array.isArray(body) ? body : [body];
        const output = records.map(record => {
          const existing = state.rows.find(item => item.import_id === record.import_id && item.source_row_number === record.source_row_number);
          if (existing) return Object.assign(existing, record);
          const created = Object.assign({ id: `70000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`, created_at: '2026-07-21T00:00:00Z' }, record); state.rows.push(created); return created;
        });
        return new Response(JSON.stringify(output), { status: 201 });
      }
      if (url.includes('/royalty_import_rows?import_id=eq.') && method === 'GET') {
        const rows = url.includes('offset=1000') ? [] : state.rows.map(row => Object.assign({}, row, { recordings: state.recordings.find(item => item.id === row.recording_id) || null }));
        return new Response(JSON.stringify(rows), { status: 200 });
      }
      if (url.includes('/royalty_rules?status=eq.active') && method === 'GET') return new Response(JSON.stringify(url.includes('offset=1000') ? [] : state.rules), { status: 200 });
      if (url.endsWith('/royalty_calculation_runs') && method === 'POST') {
        const runId = state.runs.length ? `70000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}` : ids.run;
        const created = Object.assign({ id: runId, created_at: `2026-07-21T00:00:0${state.runs.length}Z`, updated_at: '2026-07-21T00:00:00Z' }, body); state.runs.push(created);
        return new Response(JSON.stringify([created]), { status: 201 });
      }
      if (url.includes('/royalty_calculation_runs?status=neq.superseded') && method === 'GET') {
        const active = state.runs.filter(run => run.status !== 'superseded').sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
        return new Response(JSON.stringify(url.includes('offset=1000') ? [] : active.map(run => ({ id: run.id, import_id: run.import_id, created_at: run.created_at }))), { status: 200 });
      }
      if (url.includes('/royalty_calculation_runs?') && method === 'PATCH') {
        const target = /[?&]id=eq\./.test(url) ? state.runs.find(item => url.includes(encodeURIComponent(item.id))) : null;
        if (target) Object.assign(target, body);
        else if (url.includes('id=neq.')) state.runs.filter(item => !url.includes(encodeURIComponent(item.id)) && item.status !== 'superseded').forEach(item => Object.assign(item, body));
        return new Response(JSON.stringify(target ? [target] : []), { status: 200 });
      }
      if (url.endsWith('/royalty_calculation_lines') && method === 'POST') {
        const records = Array.isArray(body) ? body : [body];
        const output = records.map(record => Object.assign({ id: `71000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`, created_at: '2026-07-21T00:00:00Z' }, record));
        state.lines.push(...output); return new Response(JSON.stringify(output), { status: 201 });
      }
      if (url.includes('/finance_exceptions?on_conflict=exception_key') && method === 'POST') {
        const records = Array.isArray(body) ? body : [body];
        const output = records.map(record => {
          const existing = state.exceptions.find(item => item.exception_key === record.exception_key);
          if (existing) return Object.assign(existing, record);
          const created = Object.assign({ id: `72000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`, created_at: '2026-07-21T00:00:00Z', updated_at: '2026-07-21T00:00:00Z' }, record); state.exceptions.push(created); return created;
        });
        return new Response(JSON.stringify(output), { status: 201 });
      }
      if (url.includes('/finance_exceptions?id=eq.') && method === 'PATCH') {
        const target = state.exceptions.find(item => url.includes(encodeURIComponent(item.id))); Object.assign(target, body, { updated_at: '2026-07-21T01:00:00Z' });
        return new Response(JSON.stringify([target]), { status: 200 });
      }
      if (url.includes('/royalty_calculation_lines?') && url.includes('&select=') && method === 'GET') {
        const selectedRunIds = state.runs.filter(run => run.status !== 'superseded').map(run => run.id);
        const output = url.includes('offset=1000') ? [] : state.lines.filter(line => selectedRunIds.includes(line.run_id)).map(line => Object.assign({}, line, {
          royalty_calculation_runs: Object.assign({}, state.runs.find(run => run.id === line.run_id), { royalty_imports: state.imports[0] }),
          royalty_import_rows: { source_row_number: 1, raw_data: { title: 'Matched Song' } }, royalty_rules: state.rules[0], recordings: state.recordings[0]
        }));
        return new Response(JSON.stringify(output), { status: 200 });
      }
      if (url.includes('/finance_exceptions?') && url.includes('&select=') && method === 'GET') {
        const selectedRunIds = state.runs.filter(run => run.status !== 'superseded').map(run => run.id);
        const output = url.includes('offset=1000') ? [] : state.exceptions.filter(item => selectedRunIds.includes(item.calculation_run_id)).map(item => Object.assign({}, item, { royalty_imports: state.imports[0], royalty_calculation_runs: state.runs.find(run => run.id === item.calculation_run_id) }));
        return new Response(JSON.stringify(output), { status: 200 });
      }
      throw new Error(`Unexpected workflow Supabase URL: ${url} (${method})`);
    };
    try {
      const handler = require('./api/os-data');
      const token = auth.issueSession({ id: 'finance-workflow-user', name: 'Finance', role: 'finance' });
      const headers = { origin: 'https://app.cheerfulmusic.com', cookie: `cm_gpt_session=${encodeURIComponent(token)}` };
      async function call(resource, method, body = {}) {
        const req = { method, query: { resource }, headers, body: Object.assign({ resource }, body) };
        const res = responseMock(); await handler(req, res); return { status: res.statusCode, body: JSON.parse(res.chunks.join('') || '{}') };
      }
      let result = await call('royalty_imports', 'POST', { records: [{ id: 'CM-IMP-WF', platform: 'spotify', fileName: 'workflow.csv', currency: 'USD', period: '2026 Q1', rowCount: 2, revenue: 150 }] });
      assert.strictEqual(result.body.ok, true);
      result = await call('import_rows', 'POST', { records: [
        { batchId: 'CM-IMP-WF', rowIndex: 0, title: 'Matched Song', artist: 'Workflow Artist', isrc: 'WF-001', grossAmount: 120, fees: 20, netAmount: 100, currency: 'USD', period: '2026 Q1', rawData: { custom: 'preserved' } },
        { batchId: 'CM-IMP-WF', rowIndex: 1, title: 'Unknown Song', artist: 'Unknown', isrc: '', revenue: 50, currency: 'USD', period: '2026 Q1' }
      ] });
      assert.strictEqual(result.body.result.saved, 2);
      assert.strictEqual(state.rows[0].raw_data.custom, 'preserved');
      result = await call('matching_queue', 'POST', { records: [
        { batchId: 'CM-IMP-WF', rowIndex: 0, title: 'Matched Song', artist: 'Workflow Artist', isrc: 'WF-001', recordingId: 'CM-R-WF', confidence: 100, reason: 'ISRC 精确匹配', revenue: 100, currency: 'USD', period: '2026 Q1' },
        { batchId: 'CM-IMP-WF', rowIndex: 1, title: 'Unknown Song', artist: 'Unknown', isrc: '', recordingId: '', confidence: 0, reason: '未找到可靠的歌曲版本', revenue: 50, currency: 'USD', period: '2026 Q1' }
      ] });
      assert.strictEqual(result.body.result.saved, 2);
      assert.strictEqual(state.rows[0].gross_amount, 120, 'matching must preserve original gross revenue');
      assert.strictEqual(state.rows[0].fees, 20, 'matching must preserve original fees');
      assert.strictEqual(state.rows[0].net_amount, 100, 'matching must preserve original net revenue');
      result = await call('calculations', 'POST', { batchId: 'CM-IMP-WF' });
      assert.strictEqual(result.body.ok, true);
      assert.strictEqual(result.body.result.lines, 1);
      assert(result.body.result.exceptions >= 1);
      assert.strictEqual(state.lines[0].royalty_amount, 25);
      result = await call('calculations', 'POST', { batchId: 'CM-IMP-WF' });
      assert.strictEqual(result.body.ok, true);
      assert.strictEqual(state.runs.filter(run => run.status !== 'superseded').length, 1, 'only the newest calculation run may remain active');
      result = await call('calculations', 'GET');
      assert.strictEqual(result.body.data.length, 1);
      result = await call('exceptions', 'GET');
      assert(result.body.data.length >= 1);
      const exceptionId = state.exceptions[0].id;
      result = await call('exceptions', 'PATCH', { id: exceptionId, status: 'resolved', notes: '财务已核对' });
      assert.strictEqual(result.body.exception.status, 'resolved');
      assert.strictEqual(result.body.exception.resolution_notes, '财务已核对');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('Developer Console API is denied to Finance and available to CEO', async () => {
    const developer = require('./api/finance-debug');
    const financeToken = auth.issueSession({ id: 'finance-user', name: 'Finance', role: 'finance' });
    const deniedReq = {
      method: 'GET', query: { action: 'status' },
      headers: { origin: 'https://app.cheerfulmusic.com', cookie: `cm_gpt_session=${encodeURIComponent(financeToken)}` }
    };
    const deniedRes = responseMock();
    await developer(deniedReq, deniedRes);
    assert.strictEqual(deniedRes.statusCode, 403);

    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      if (url.includes('/gpt_audit_logs') && options.method === 'POST') return new Response('', { status: 201 });
      return new Response('[]', { status: 200, headers: { 'Content-Range': '0-0/0' } });
    };
    try {
      const ceoToken = auth.issueSession({ id: 'ceo-user', name: 'CEO', role: 'ceo' });
      const req = {
        method: 'GET', query: { action: 'tables' },
        headers: { origin: 'https://app.cheerfulmusic.com', cookie: `cm_gpt_session=${encodeURIComponent(ceoToken)}` }
      };
      const res = responseMock();
      await developer(req, res);
      const payload = JSON.parse(res.chunks.join(''));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(payload.tables.length, 16);
      assert(payload.tables.some(table => table.name === 'songs'));
      assert(payload.tables.some(table => table.name === 'royalty_import_rows'));
      assert(payload.tables.some(table => table.name === 'royalty_calculation_runs'));
      assert(payload.tables.some(table => table.name === 'royalty_calculation_lines'));
      assert(payload.tables.some(table => table.name === 'finance_exceptions'));
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('Developer CRUD tester inserts through the protected server API and reports execution time', async () => {
    const developer = require('./api/finance-debug');
    const token = auth.issueSession({ id: 'admin-user', name: 'Admin', role: 'admin' });
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      if (url.includes('/songs') && options.method === 'POST') {
        return new Response(JSON.stringify([{ id: '44444444-4444-4444-8444-444444444444', work_id: 'DEV-W-CRUD', title: 'CRUD Song' }]), { status: 201 });
      }
      if (url.includes('/gpt_audit_logs')) return new Response('', { status: 201 });
      throw new Error(`Unexpected Supabase URL: ${url}`);
    };
    try {
      const req = {
        method: 'POST', query: {},
        headers: { origin: 'https://app.cheerfulmusic.com', cookie: `cm_gpt_session=${encodeURIComponent(token)}` },
        body: { action: 'crud', operation: 'insert', table: 'songs', record: { work_id: 'DEV-W-CRUD', title: 'CRUD Song' } }
      };
      const res = responseMock();
      await developer(req, res);
      const payload = JSON.parse(res.chunks.join(''));
      assert.strictEqual(payload.success, true);
      assert.strictEqual(payload.operation, 'insert');
      assert.strictEqual(payload.table, 'songs');
      assert(Number.isFinite(payload.executionMs));
      assert.strictEqual(payload.result.data[0].work_id, 'DEV-W-CRUD');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('Developer test cleanup deletes imports before referenced royalty rules', async () => {
    const developer = require('./api/finance-debug');
    const token = auth.issueSession({ id: 'admin-user', name: 'Admin', role: 'admin' });
    const originalFetch = global.fetch;
    const deleteOrder = [];
    global.fetch = async (url, options = {}) => {
      if (url.includes('/gpt_audit_logs') && options.method === 'POST') return new Response('', { status: 201 });
      if (url.includes('/songs?work_id=like.DEV-*') && (!options.method || options.method === 'GET')) {
        return new Response(JSON.stringify([{ id: '44444444-4444-4444-8444-444444444444' }]), { status: 200 });
      }
      if (options.method === 'DELETE') {
        const match = String(url).match(/\/rest\/v1\/([^?]+)/);
        deleteOrder.push(match && match[1]);
        return new Response('[]', { status: 200 });
      }
      throw new Error(`Unexpected Supabase URL: ${url}`);
    };
    try {
      const req = {
        method: 'POST', query: {},
        headers: { origin: 'https://app.cheerfulmusic.com', cookie: `cm_gpt_session=${encodeURIComponent(token)}` },
        body: { action: 'delete-test-data' }
      };
      const res = responseMock();
      await developer(req, res);
      const payload = JSON.parse(res.chunks.join(''));
      assert.strictEqual(payload.ok, true);
      assert.deepStrictEqual(deleteOrder, ['royalty_imports', 'royalty_rules', 'royalty_rules', 'recordings', 'recordings', 'songs']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('database migration enables RLS for every sensitive department table', () => {
    const sql = fs.readFileSync(path.join(__dirname, 'supabase/cheerful-os.sql'), 'utf8');
    const financeSql = fs.readFileSync(path.join(__dirname, 'supabase/finance-workflow-v2.sql'), 'utf8');
    ['users', 'songs', 'recordings', 'royalty_rules', 'royalty_imports', 'royalty_import_rows', 'hr_records', 'recruitment_records', 'contracts', 'legal_records'].forEach(table => {
      assert(sql.includes(`alter table public.${table} enable row level security;`), `${table} missing RLS`);
    });
    assert(sql.includes("in ('ceo', 'finance')"));
    assert(sql.includes("in ('ceo', 'hr')"));
    assert(sql.includes("in ('ceo', 'finance', 'ar')"));
    ['royalty_calculation_runs', 'royalty_calculation_lines', 'finance_exceptions'].forEach(table => {
      assert(financeSql.includes(`alter table public.${table} enable row level security;`), `${table} missing RLS`);
    });
  });

  await test('finance browser modules enforce import limits, duplicate checks, safe CSV exports, and confirmed developer deletion', () => {
    const finance = fs.readFileSync(path.join(__dirname, 'js/finance.js'), 'utf8');
    const songBulk = fs.readFileSync(path.join(__dirname, 'js/song-library-bulk-import.js'), 'utf8');
    const matrixBulk = fs.readFileSync(path.join(__dirname, 'js/royalty-matrix-bulk-import.js'), 'utf8');
    const developer = fs.readFileSync(path.join(__dirname, 'js/developer-console.js'), 'utf8');
    assert(finance.includes('100000'), 'platform import row cap is missing');
    assert(finance.includes('fileChecksum'), 'platform import checksum is missing');
    assert(finance.includes('收入金额字段'), 'platform import revenue mapping validation is missing');
    assert(songBulk.includes('/^[=+\\-@\\t\\r]/'), 'Song Library error export does not neutralize spreadsheet formulas');
    assert(matrixBulk.includes('/^[=+\\-@\\t\\r]/'), 'Royalty Matrix error export does not neutralize spreadsheet formulas');
    assert(developer.includes("operation === 'delete' && !window.confirm"), 'Developer Console deletion lacks confirmation');
  });

  await test('production headers prevent framing and unsafe content sniffing without changing the UI', () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'vercel.json'), 'utf8'));
    const headers = Object.fromEntries(config.headers[0].headers.map(item => [item.key, item.value]));
    assert.strictEqual(headers['X-Frame-Options'], 'DENY');
    assert.strictEqual(headers['X-Content-Type-Options'], 'nosniff');
    assert.strictEqual(headers['Referrer-Policy'], 'no-referrer');
  });

  console.log('\nAll Supabase integration checks passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
