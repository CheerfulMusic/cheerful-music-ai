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
