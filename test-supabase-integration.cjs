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
        ['/users?', '/songs?', '/royalty_rules?', '/royalty_imports?'].some(part => url.includes(part)),
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
        tables: {
          users: true,
          songs: true,
          royaltyRules: true,
          royaltyImports: true
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
      assert.strictEqual(payload.tables.length, 13);
      assert(payload.tables.some(table => table.name === 'songs'));
      assert(payload.tables.some(table => table.name === 'royalty_import_rows'));
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

  await test('database migration enables RLS for every sensitive department table', () => {
    const sql = fs.readFileSync(path.join(__dirname, 'supabase/cheerful-os.sql'), 'utf8');
    ['users', 'songs', 'recordings', 'royalty_rules', 'royalty_imports', 'royalty_import_rows', 'hr_records', 'recruitment_records', 'contracts', 'legal_records'].forEach(table => {
      assert(sql.includes(`alter table public.${table} enable row level security;`), `${table} missing RLS`);
    });
    assert(sql.includes("in ('ceo', 'finance')"));
    assert(sql.includes("in ('ceo', 'hr')"));
    assert(sql.includes("in ('ceo', 'finance', 'ar')"));
  });

  console.log('\nAll Supabase integration checks passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
