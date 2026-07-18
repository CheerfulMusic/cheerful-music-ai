const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;

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
    end(value) { if (value) this.chunks.push(String(value)); resolveEnd(); },
    flushHeaders() {}
  };
}

function current(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function baseline(file) {
  return execFileSync('git', ['show', `origin/main:${file}`], { cwd: root, encoding: 'utf8' });
}

async function main() {
  await test('existing Finance modules are byte-for-byte unchanged', () => {
    ['js/finance.js', 'js/finance-workflow.js', 'js/song-library-bulk-import.js', 'js/royalty-matrix-bulk-import.js'].forEach(file => {
      assert.strictEqual(current(file), baseline(file), `${file} changed unexpectedly`);
    });
  });

  await test('index only adds isolated Cheerful GPT assets', () => {
    const stripped = current('index.html')
      .replace('<link rel="stylesheet" href="css/cheerful-gpt.css" />\n', '')
      .replace('<script src="js/cheerful-gpt.js"></script>\n', '');
    assert.strictEqual(stripped, baseline('index.html'));
  });

  await test('no OpenAI API key value is present in browser assets', () => {
    const browserCode = [current('index.html'), current('js/cheerful-gpt.js'), current('css/cheerful-gpt.css')].join('\n');
    assert(!/sk-[A-Za-z0-9_-]{20,}/.test(browserCode));
    assert(!browserCode.includes('process.env.OPENAI_API_KEY'));
  });

  process.env.CHEERFUL_GPT_SESSION_SECRET = 'test-session-secret-that-is-longer-than-thirty-two-characters';
  process.env.CHEERFUL_GPT_ACCESS_KEYS = JSON.stringify({
    'admin-code': { id: 'admin', name: 'Admin', role: 'admin' },
    'finance-code': { id: 'finance', name: 'Finance', role: 'finance' },
    'ceo-code': { id: 'ceo', name: 'CEO', role: 'ceo' },
    'member-code': { id: 'member', name: 'Member', role: 'member' }
  });
  process.env.OPENAI_API_KEY = 'test-only-server-key';
  process.env.OPENAI_MODEL = 'gpt-5.6-luna';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const auth = require('./api/_gpt-auth');
  const chat = require('./api/chat');

  await test('role permissions restrict financial data to Finance and CEO', () => {
    assert(auth.permissionsFor('finance').includes('financial_data'));
    assert(auth.permissionsFor('ceo').includes('financial_data'));
    assert(!auth.permissionsFor('admin').includes('financial_data'));
    assert(!auth.permissionsFor('member').includes('financial_data'));
    assert(auth.permissionsFor('admin').includes('audit_view'));
  });

  await test('access code creates an HttpOnly secure session cookie', async () => {
    const session = require('./api/gpt-session');
    const req = { method: 'POST', headers: { origin: 'https://app.cheerfulmusic.com' }, body: { accessCode: 'ceo-code' } };
    const res = responseMock();
    await session(req, res);
    const cookie = res.headers['set-cookie'];
    assert(cookie.includes('HttpOnly'));
    assert(cookie.includes('Secure'));
    assert(cookie.includes('SameSite=Strict'));
    assert(!res.chunks.join('').includes('ceo-code'));
  });

  async function runChat(role, webSearch) {
    const user = { id: role, name: role.toUpperCase(), role };
    const token = auth.issueSession(user);
    let captured;
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      if (url === 'https://api.openai.com/v1/responses') {
        captured = { url, options, body: JSON.parse(options.body) };
        const stream = [
          'data: {"type":"response.output_text.delta","delta":"测试回答"}\n\n',
          'data: {"type":"response.completed","response":{"output":[]}}\n\n',
          'data: [DONE]\n\n'
        ].join('');
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const req = {
      method: 'POST',
      headers: { origin: 'https://app.cheerfulmusic.com', cookie: `cm_gpt_session=${encodeURIComponent(token)}`, 'x-forwarded-for': `10.0.0.${role.length}` },
      body: {
        conversationId: `conversation-${role}`,
        messages: [{ role: 'user', content: '请分析内部数据' }],
        webSearch,
        includeContext: true,
        businessContext: {
          generatedAt: new Date().toISOString(),
          summary: { recordingCount: 6200, royaltyRuleCount: 777 },
          recordings: [{ id: 'CM-R-1', workTitle: '测试歌曲', artist: '测试艺人', isrc: 'TESTISRC1' }],
          royaltyRules: [{ id: 'RULE-1', payee: 'SECRET-PAYEE', percentage: 47.25 }],
          relevantCalculations: [{ royaltyAmount: 987654.32 }]
        }
      }
    };
    const res = responseMock();
    await chat(req, res);
    await res.ended;
    global.fetch = originalFetch;
    return { captured, output: res.chunks.join('') };
  }

  await test('Member requests cannot send royalty rules, split rates, or amounts to OpenAI', async () => {
    const result = await runChat('member', true);
    const body = JSON.stringify(result.captured.body);
    assert(body.includes('测试歌曲'));
    assert(!body.includes('SECRET-PAYEE'));
    assert(!body.includes('47.25'));
    assert(!body.includes('987654.32'));
    assert(result.captured.body.tools.some(tool => tool.type === 'web_search'));
  });

  await test('Finance requests can use royalty rules and amounts', async () => {
    const result = await runChat('finance', false);
    const body = JSON.stringify(result.captured.body);
    assert(body.includes('SECRET-PAYEE'));
    assert(body.includes('47.25'));
    assert(body.includes('987654.32'));
    assert(!result.captured.body.tools);
    assert(result.output.includes('测试回答'));
  });

  await test('file upload uses server Authorization and never returns the API key', async () => {
    const fileHandler = require('./api/gpt-file');
    const token = auth.issueSession({ id: 'member', name: 'Member', role: 'member' });
    const originalFetch = global.fetch;
    let authorization;
    global.fetch = async (url, options) => {
      assert.strictEqual(url, 'https://api.openai.com/v1/files');
      authorization = options.headers.Authorization;
      return new Response(JSON.stringify({ id: 'file-test123' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const req = {
      method: 'POST',
      headers: { origin: 'https://app.cheerfulmusic.com', cookie: `cm_gpt_session=${encodeURIComponent(token)}` },
      body: { name: 'contract.pdf', type: 'application/pdf', data: Buffer.from('test pdf').toString('base64') }
    };
    const res = responseMock();
    await fileHandler(req, res);
    global.fetch = originalFetch;
    assert.strictEqual(authorization, 'Bearer test-only-server-key');
    assert(!res.chunks.join('').includes('test-only-server-key'));
    assert(res.chunks.join('').includes('file-test123'));
  });

  console.log('\nAll Cheerful GPT checks passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
