(function () {
  'use strict';

  var section = 'database';
  var tables = [];
  var tableView = null;
  var monitors = null;
  var serverLogs = { activity: [], errors: [] };
  var runtimeErrors = [];
  var crudResult = null;
  var busy = false;
  var apiLog = window.__cheerfulApiLog || [];
  window.__cheerfulApiLog = apiLog;

  var sections = [
    ['database', 'Database Explorer'],
    ['crud', 'Database CRUD Tester'],
    ['api', 'API Monitor'],
    ['supabase', 'Supabase Monitor'],
    ['openai', 'OpenAI Monitor'],
    ['errors', 'Error Center'],
    ['activity', 'Activity Log'],
    ['tools', 'Development Tools'],
    ['finance', 'AI Finance Debug'],
    ['tests', 'Test Center']
  ];

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function truncate(value, max) {
    var output = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return String(output == null ? '' : output).slice(0, max || 12000);
  }

  function redact(value) {
    if (value == null) return value;
    if (typeof value === 'string') {
      if (/Bearer\s+[A-Za-z0-9._-]+/i.test(value)) return value.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
      try { return redact(JSON.parse(value)); } catch (_) { return value.slice(0, 12000); }
    }
    if (Array.isArray(value)) return value.slice(0, 100).map(redact);
    if (typeof value === 'object') {
      var output = {};
      Object.entries(value).slice(0, 100).forEach(function (entry) {
        output[entry[0]] = /(password|secret|token|key|authorization|cookie)/i.test(entry[0]) ? '[REDACTED]' : redact(entry[1]);
      });
      return output;
    }
    return value;
  }

  function recordApi(entry) {
    apiLog.unshift(entry);
    if (apiLog.length > 250) apiLog.length = 250;
  }

  function installApiMonitor() {
    if (window.__cheerfulFetchMonitored) return;
    window.__cheerfulFetchMonitored = true;
    var originalFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      var started = performance.now();
      var method = String(init && init.method || input && input.method || 'GET').toUpperCase();
      var url = String(input && input.url || input || '');
      var requestBody = redact(init && init.body || null);
      try {
        var response = await originalFetch(input, init);
        var entry = {
          id: Date.now() + '-' + Math.random().toString(16).slice(2),
          method: method,
          url: url,
          status: response.status,
          responseTime: Math.round(performance.now() - started),
          requestBody: requestBody,
          responseBody: '[stream or empty]',
          timestamp: new Date().toISOString()
        };
        recordApi(entry);
        response.clone().text().then(function (body) {
          entry.responseBody = redact(body);
        }).catch(function () {});
        return response;
      } catch (error) {
        recordApi({
          id: Date.now() + '-' + Math.random().toString(16).slice(2),
          method: method,
          url: url,
          status: 'ERROR',
          responseTime: Math.round(performance.now() - started),
          requestBody: requestBody,
          responseBody: error.message,
          timestamp: new Date().toISOString()
        });
        throw error;
      }
    };
  }

  window.addEventListener('error', function (event) {
    runtimeErrors.unshift({ source: 'Frontend', message: event.message, file: event.filename, line: event.lineno, timestamp: new Date().toISOString() });
    runtimeErrors = runtimeErrors.slice(0, 100);
  });
  window.addEventListener('unhandledrejection', function (event) {
    runtimeErrors.unshift({ source: 'Frontend Promise', message: String(event.reason && event.reason.message || event.reason), timestamp: new Date().toISOString() });
    runtimeErrors = runtimeErrors.slice(0, 100);
  });

  async function request(action, options, query) {
    var params = new URLSearchParams(Object.assign({ action: action }, query || {}));
    var response = await fetch('/api/finance-debug?' + params.toString(), Object.assign({
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }
    }, options || {}));
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.detail || data.error || 'Developer Console request failed (' + response.status + ')');
    return data;
  }

  function injectStyles() {
    if (document.getElementById('developerConsoleStyles')) return;
    var style = document.createElement('style');
    style.id = 'developerConsoleStyles';
    style.textContent = [
      '.dev-console{display:block}.dev-nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}.dev-nav button{border:1px solid var(--line);background:#111319;color:#b8bcc6;border-radius:10px;padding:9px 12px;font-size:11px;cursor:pointer}.dev-nav button.active{border-color:rgba(249,56,34,.55);background:rgba(249,56,34,.12);color:#ff8678}',
      '.dev-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}.dev-toolbar-actions{display:flex;gap:8px;flex-wrap:wrap}.dev-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.dev-card{border:1px solid var(--line);background:#0d0f13;border-radius:14px;padding:16px;min-width:0}.dev-card h3,.dev-card h4{margin:0 0 8px}.dev-card p{color:var(--muted);font-size:11px;margin:4px 0}.dev-card .value{font-size:18px;font-weight:800;margin:8px 0}.dev-ok{color:#6ee788}.dev-warn{color:#ffb76e}.dev-error{color:#ff7d70}.dev-muted{color:var(--muted)}',
      '.dev-table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}.dev-table{width:100%;border-collapse:collapse;font-size:10px;min-width:760px}.dev-table th,.dev-table td{padding:9px;border-bottom:1px solid #22252c;text-align:left;vertical-align:top;max-width:260px;word-break:break-word}.dev-table th{position:sticky;top:0;background:#15181e;color:#aeb3be;z-index:1}.dev-table pre{white-space:pre-wrap;margin:0;max-height:160px;overflow:auto;color:#cfd3dc}',
      '.dev-input,.dev-select,.dev-textarea{width:100%;border:1px solid var(--line);background:#090b0f;color:#f4f5f7;border-radius:10px;padding:10px 11px;font:inherit}.dev-textarea{min-height:150px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}.dev-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.dev-form .full{grid-column:1/-1}.dev-label{display:block;color:#aeb2bd;font-size:10px;margin:0 0 6px}.dev-result{background:#080a0d;border:1px solid var(--line);border-radius:12px;padding:14px;white-space:pre-wrap;overflow:auto;max-height:360px;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#d9dce3}.dev-stack{display:grid;gap:12px}.dev-pill{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:5px 8px;font-size:10px;color:#c5c9d2}.dev-pagination{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:10px;color:var(--muted);font-size:11px}.dev-button{border:1px solid var(--line);background:#171a20;color:#e7e9ed;border-radius:10px;padding:9px 12px;cursor:pointer}.dev-button.primary{border-color:var(--red);background:var(--red);color:white}.dev-button.danger{border-color:#6a2b2b;color:#ff8b7d}.dev-button:disabled{opacity:.45;cursor:not-allowed}.dev-tools{display:flex;gap:10px;flex-wrap:wrap}.dev-empty{padding:30px;text-align:center;color:var(--muted)}',
      '@media(max-width:1100px){.dev-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.dev-grid,.dev-form{grid-template-columns:1fr}.dev-form .full{grid-column:auto}}'
    ].join('');
    document.head.appendChild(style);
  }

  function authorized() {
    var role = window.cheerfulCurrentUser && window.cheerfulCurrentUser.role;
    return role === 'ceo' || role === 'admin';
  }

  function loading(label) {
    return '<div class="dev-empty">' + esc(label || '正在读取…') + '</div>';
  }

  function human(value) {
    if (value == null || value === '') return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function dataTable(payload) {
    if (!payload || !Array.isArray(payload.data) || !payload.data.length) return '<div class="dev-empty">暂无记录</div>';
    var keys = Array.from(new Set(payload.data.slice(0, 20).flatMap(function (row) { return Object.keys(row); }))).slice(0, 14);
    return '<div class="dev-table-wrap"><table class="dev-table"><thead><tr>' +
      keys.map(function (key) { return '<th>' + esc(key) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + payload.data.map(function (row) {
        return '<tr>' + keys.map(function (key) { return '<td>' + esc(human(row[key])) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="dev-pagination"><button class="dev-button" ' + (payload.page <= 1 ? 'disabled' : '') + ' onclick="devTablePage(' + (payload.page - 1) + ')">上一页</button><span>第 ' + payload.page + ' 页 · 共 ' + Number(payload.total || 0).toLocaleString() + ' 条</span><button class="dev-button" ' + (payload.page * payload.pageSize >= payload.total ? 'disabled' : '') + ' onclick="devTablePage(' + (payload.page + 1) + ')">下一页</button></div>';
  }

  function renderDatabase() {
    var cards = tables.length ? tables.map(function (table) {
      return '<div class="dev-card"><span class="dev-pill">' + esc(table.name) + '</span><h3 style="margin-top:10px">' + esc(table.label) + '</h3><div class="value">' + (table.rowCount == null ? 'Error' : Number(table.rowCount).toLocaleString()) + '</div><p>Last Updated: ' + esc(table.lastUpdated || '—') + '</p>' + (table.error ? '<p class="dev-error">' + esc(table.error) + '</p>' : '') + '<button class="dev-button" onclick="devOpenTable(\'' + esc(table.name) + '\')">Open Table</button></div>';
    }).join('') : loading('正在读取 Supabase 表…');
    var viewer = tableView ? '<div class="dev-card" style="margin-top:16px"><div class="dev-toolbar"><div><h3>' + esc(tableView.table) + '</h3><p>最新记录，单页最多 100 条</p></div><div class="dev-toolbar-actions"><input id="devTableSearch" class="dev-input" style="width:220px" placeholder="Search" value="' + esc(tableView.search || '') + '"><button class="dev-button" onclick="devSearchTable()">Search</button><button class="dev-button" onclick="devOpenTable(\'' + esc(tableView.table) + '\',' + tableView.page + ')">Refresh</button></div></div>' + dataTable(tableView) + '</div>' : '';
    return '<div class="dev-toolbar"><div><h2>Database Explorer</h2><p class="dev-muted">浏览当前 Cheerful OS 的全部业务表。</p></div><button class="dev-button primary" onclick="devRefreshDatabase()">Refresh</button></div><div class="dev-grid">' + cards + '</div>' + viewer;
  }

  function renderCrud() {
    var options = tables.map(function (table) { return '<option value="' + esc(table.name) + '">' + esc(table.name) + (table.readOnly ? ' (read-only)' : '') + '</option>'; }).join('');
    return '<div class="dev-toolbar"><div><h2>Database CRUD Tester</h2><p class="dev-muted">通过受保护服务器接口执行结构化 Read / Insert / Update / Delete；不开放任意 SQL。</p></div></div>' +
      '<div class="dev-card"><div class="dev-form"><div><label class="dev-label">Table</label><select id="devCrudTable" class="dev-select">' + options + '</select></div><div><label class="dev-label">Operation</label><select id="devCrudOperation" class="dev-select"><option>read</option><option>insert</option><option>update</option><option>delete</option></select></div><div class="full"><label class="dev-label">Record ID（Update / Delete）</label><input id="devCrudId" class="dev-input" placeholder="UUID"></div><div class="full"><label class="dev-label">JSON Record（Insert / Update）</label><textarea id="devCrudRecord" class="dev-textarea">{\n  \n}</textarea></div></div><div class="dev-toolbar" style="margin-top:12px"><span class="dev-muted">结果会显示执行时间、成功状态和返回数据。</span><button class="dev-button primary" onclick="devRunCrud()">Run</button></div>' + (crudResult ? '<pre class="dev-result">' + esc(JSON.stringify(crudResult, null, 2)) + '</pre>' : '') + '</div>';
  }

  function renderApi() {
    return '<div class="dev-toolbar"><div><h2>API Monitor</h2><p class="dev-muted">本浏览器会话中的 API 请求；密码、Token、Cookie 和密钥会自动隐藏。</p></div><div class="dev-toolbar-actions"><button class="dev-button" onclick="devRefreshSection()">Refresh</button><button class="dev-button danger" onclick="devClearApiLog()">Clear</button></div></div>' +
      '<div class="dev-table-wrap"><table class="dev-table"><thead><tr><th>Method</th><th>URL</th><th>Status</th><th>Response Time</th><th>Request Body</th><th>Response Body</th><th>Time</th></tr></thead><tbody>' +
      (apiLog.length ? apiLog.map(function (item) { return '<tr><td>' + esc(item.method) + '</td><td>' + esc(item.url) + '</td><td>' + esc(item.status) + '</td><td>' + esc(item.responseTime) + ' ms</td><td><pre>' + esc(truncate(item.requestBody, 3000)) + '</pre></td><td><pre>' + esc(truncate(item.responseBody, 3000)) + '</pre></td><td>' + esc(item.timestamp) + '</td></tr>'; }).join('') : '<tr><td colspan="7" class="dev-empty">暂无 API 请求</td></tr>') +
      '</tbody></table></div>';
  }

  function monitorCards(items) {
    return '<div class="dev-grid">' + items.map(function (item) {
      var value = human(item[1]);
      var tone = /connected|configured|available|true/i.test(value) ? 'dev-ok' : (/error|unavailable|false|not configured/i.test(value) ? 'dev-error' : '');
      return '<div class="dev-card"><p>' + esc(item[0]) + '</p><div class="value ' + tone + '">' + esc(value) + '</div></div>';
    }).join('') + '</div>';
  }

  function renderSupabase() {
    var data = monitors && monitors.supabase;
    if (!data) return loading('正在读取 Supabase 状态…');
    return '<div class="dev-toolbar"><div><h2>Supabase Monitor</h2><p class="dev-muted">连接、身份和环境状态。</p></div><button class="dev-button" onclick="devLoadMonitors()">Refresh</button></div>' + monitorCards([
      ['Supabase Connected', data.connected], ['Current User', data.currentUser && (data.currentUser.name + ' · ' + data.currentUser.email)], ['Current Role', data.currentRole], ['Project ID', data.projectId], ['Current Environment', data.environment], ['Realtime Status', data.realtimeStatus], ['Database URL', data.databaseUrl], ['Current Timestamp', data.timestamp]
    ]);
  }

  function renderOpenAI() {
    var data = monitors && monitors.openai;
    if (!data) return loading('正在读取 OpenAI 状态…');
    return '<div class="dev-toolbar"><div><h2>OpenAI Monitor</h2><p class="dev-muted">仅显示安全运行状态，不暴露 API Key。</p></div><button class="dev-button" onclick="devLoadMonitors()">Refresh</button></div>' + monitorCards([
      ['Current Model', data.model], ['API Status', data.apiStatus], ['Quota Status', data.quotaStatus], ['Token Usage', data.tokenUsage || 'No completed usage record']
    ]) + '<div class="dev-grid" style="margin-top:12px"><div class="dev-card"><h3>Last Prompt</h3><pre class="dev-result">' + esc(truncate(data.lastPrompt, 8000)) + '</pre></div><div class="dev-card"><h3>Last Response</h3><pre class="dev-result">' + esc(truncate(data.lastResponse, 8000)) + '</pre></div><div class="dev-card"><h3>Last Error</h3><pre class="dev-result">' + esc(truncate(data.lastError, 8000)) + '</pre></div></div>';
  }

  function renderErrors() {
    var rows = runtimeErrors.map(function (item) { return Object.assign({ action: item.source }, item); }).concat(serverLogs.errors || []);
    return '<div class="dev-toolbar"><div><h2>Error Center</h2><p class="dev-muted">Frontend、Backend、Supabase、OpenAI 与 Authentication 错误。</p></div><div class="dev-toolbar-actions"><button class="dev-button" onclick="devLoadLogs()">Refresh</button><button class="dev-button" onclick="devDownloadErrors()">Download Error Logs</button></div></div>' +
      '<div class="dev-table-wrap"><table class="dev-table"><thead><tr><th>Source / Action</th><th>Message / Metadata</th><th>Actor</th><th>Time</th></tr></thead><tbody>' + (rows.length ? rows.map(function (item) { return '<tr><td>' + esc(item.action || item.source) + '</td><td><pre>' + esc(truncate(item.message || item.metadata, 6000)) + '</pre></td><td>' + esc(item.actor_name || 'Browser') + '</td><td>' + esc(item.created_at || item.timestamp) + '</td></tr>'; }).join('') : '<tr><td colspan="4" class="dev-empty">没有错误记录</td></tr>') + '</tbody></table></div>';
  }

  function renderActivity() {
    var rows = serverLogs.activity || [];
    return '<div class="dev-toolbar"><div><h2>Activity Log</h2><p class="dev-muted">Create Song、Delete Song、Import Royalty、Update Rules、Login、Logout 与开发操作。</p></div><button class="dev-button" onclick="devLoadLogs()">Refresh</button></div>' +
      '<div class="dev-table-wrap"><table class="dev-table"><thead><tr><th>Action</th><th>Actor</th><th>Role</th><th>Metadata</th><th>Time</th></tr></thead><tbody>' + (rows.length ? rows.map(function (item) { return '<tr><td>' + esc(item.action) + '</td><td>' + esc(item.actor_name) + '</td><td>' + esc(item.actor_role) + '</td><td><pre>' + esc(truncate(item.metadata, 5000)) + '</pre></td><td>' + esc(item.created_at) + '</td></tr>'; }).join('') : '<tr><td colspan="5" class="dev-empty">暂无活动记录</td></tr>') + '</tbody></table></div>';
  }

  function renderTools() {
    return '<div class="dev-toolbar"><div><h2>Development Tools</h2><p class="dev-muted">安全刷新、健康检查和导出。</p></div></div><div class="dev-card"><div class="dev-tools"><button class="dev-button" onclick="devToolAction(\'refresh-database\')">Refresh Database</button><button class="dev-button" onclick="devToolAction(\'reload-schema\')">Reload Schema</button><button class="dev-button primary" onclick="devToolAction(\'health\')">Run Health Check</button><button class="dev-button" onclick="devExportLogs()">Export Logs</button><button class="dev-button" onclick="devDownloadSnapshot()">Download Database Snapshot</button><button class="dev-button" onclick="devDownloadErrors()">Download Error Logs</button></div><div id="devToolResult" style="margin-top:14px"></div></div>';
  }

  function renderFinanceDebug() {
    return '<div class="dev-toolbar"><div><h2>AI Finance Debug</h2><p class="dev-muted">直接打开真实 Supabase 记录；Matching / Calculation Queue 使用当前 royalty_import_rows 数据。</p></div></div><div class="dev-grid">' +
      [['Songs', 'songs'], ['Royalty Rules', 'royalty_rules'], ['Royalty Imports', 'royalty_imports'], ['Matching Queue', 'royalty_import_rows'], ['Calculation Queue', 'royalty_import_rows']].map(function (item) {
        return '<div class="dev-card"><h3>' + esc(item[0]) + '</h3><p>Supabase: public.' + esc(item[1]) + '</p><button class="dev-button" onclick="devOpenFinanceTable(\'' + esc(item[1]) + '\')">Open Records</button></div>';
      }).join('') + '</div>' + (tableView ? '<div class="dev-card" style="margin-top:16px"><h3>' + esc(tableView.table) + '</h3>' + dataTable(tableView) + '</div>' : '');
  }

  function renderTests() {
    return '<div class="dev-toolbar"><div><h2>Test Center</h2><p class="dev-muted">测试数据均使用 DEV- 前缀，可一键清理。请勿用于正式结算。</p></div></div><div class="dev-card"><div class="dev-tools"><button class="dev-button primary" onclick="devTestAction(\'insert-test-song\')">Insert Test Song</button><button class="dev-button" onclick="devTestAction(\'insert-test-royalty\')">Insert Test Royalty</button><button class="dev-button danger" onclick="devTestAction(\'delete-test-data\')">Delete Test Data</button><button class="dev-button" onclick="devTestAction(\'generate-fake-royalty-report\')">Generate Fake Royalty Report</button><button class="dev-button" onclick="devTestAction(\'generate-fake-song-library\')">Generate Fake Song Library</button></div><div id="devTestResult" style="margin-top:14px"></div></div>';
  }

  function sectionHtml() {
    if (section === 'database') return renderDatabase();
    if (section === 'crud') return renderCrud();
    if (section === 'api') return renderApi();
    if (section === 'supabase') return renderSupabase();
    if (section === 'openai') return renderOpenAI();
    if (section === 'errors') return renderErrors();
    if (section === 'activity') return renderActivity();
    if (section === 'tools') return renderTools();
    if (section === 'finance') return renderFinanceDebug();
    return renderTests();
  }

  function renderContent() {
    var node = document.getElementById('developerConsoleContent');
    if (node) node.innerHTML = sectionHtml();
  }

  async function loadTables() {
    try {
      var data = await request('tables');
      tables = data.tables || [];
      renderContent();
    } catch (error) {
      runtimeErrors.unshift({ source: 'Developer Console', message: error.message, timestamp: new Date().toISOString() });
      renderContent();
    }
  }

  async function loadTable(name, page, search) {
    tableView = { table: name, data: [], page: page || 1, pageSize: 100, total: 0, search: search || '' };
    renderContent();
    try {
      tableView = await request('table', null, { table: name, page: page || 1, pageSize: 100, search: search || '' });
      tableView.search = search || '';
    } catch (error) {
      tableView = { table: name, data: [], page: 1, pageSize: 100, total: 0, error: error.message, search: search || '' };
    }
    renderContent();
  }

  async function loadMonitors() {
    try { monitors = await request('monitors'); }
    catch (error) { runtimeErrors.unshift({ source: 'Monitor', message: error.message, timestamp: new Date().toISOString() }); }
    renderContent();
  }

  async function loadLogs() {
    try { serverLogs = await request('logs'); }
    catch (error) { runtimeErrors.unshift({ source: 'Logs', message: error.message, timestamp: new Date().toISOString() }); }
    renderContent();
  }

  function loadSection() {
    renderContent();
    if (section === 'database' || section === 'crud') loadTables();
    if (section === 'supabase' || section === 'openai') loadMonitors();
    if (section === 'errors' || section === 'activity') loadLogs();
  }

  function download(name, data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  window.renderDeveloperConsole = function () {
    injectStyles();
    if (!authorized()) return '<section class="section active"><div class="empty-state">Developer Console 仅限 CEO 或管理员。</div></section>';
    setTimeout(loadSection, 0);
    return '<section class="section active dev-console"><div class="hero"><div><h1>Developer Console</h1><p>数据库、API、Supabase、OpenAI、错误与端到端测试中心。</p></div><span class="dev-pill">CEO / Admin Only</span></div><div class="dev-nav">' +
      sections.map(function (item) { return '<button class="' + (section === item[0] ? 'active' : '') + '" onclick="setDeveloperSection(\'' + item[0] + '\')">' + esc(item[1]) + '</button>'; }).join('') +
      '</div><div id="developerConsoleContent">' + sectionHtml() + '</div></section>';
  };

  window.setDeveloperSection = function (value) {
    section = value;
    tableView = null;
    openSection('developer');
  };
  window.devRefreshSection = renderContent;
  window.devRefreshDatabase = loadTables;
  window.devOpenTable = function (name, page) {
    var search = tableView && tableView.table === name ? tableView.search : '';
    loadTable(name, page || 1, search);
  };
  window.devTablePage = function (page) {
    if (tableView) loadTable(tableView.table, page, tableView.search);
  };
  window.devSearchTable = function () {
    if (!tableView) return;
    loadTable(tableView.table, 1, document.getElementById('devTableSearch').value);
  };
  window.devRunCrud = async function () {
    if (busy) return;
    busy = true;
    try {
      var operation = document.getElementById('devCrudOperation').value;
      var recordText = document.getElementById('devCrudRecord').value.trim();
      var record = recordText ? JSON.parse(recordText) : {};
      crudResult = await request('crud', {
        method: 'POST',
        body: JSON.stringify({ action: 'crud', operation: operation, table: document.getElementById('devCrudTable').value, id: document.getElementById('devCrudId').value.trim(), record: record })
      });
    } catch (error) {
      crudResult = { success: false, error: error.message };
    } finally {
      busy = false;
      renderContent();
    }
  };
  window.devClearApiLog = function () { apiLog.length = 0; renderContent(); };
  window.devLoadMonitors = loadMonitors;
  window.devLoadLogs = loadLogs;
  window.devOpenFinanceTable = function (name) { loadTable(name, 1, ''); };
  window.devToolAction = async function (action) {
    var node = document.getElementById('devToolResult');
    if (node) node.innerHTML = loading('正在执行…');
    try {
      var result = await request(action, { method: 'POST', body: JSON.stringify({ action: action }) });
      if (node) node.innerHTML = '<pre class="dev-result">' + esc(JSON.stringify(result, null, 2)) + '</pre>';
      if (action === 'refresh-database' || action === 'reload-schema') loadTables();
    } catch (error) {
      if (node) node.innerHTML = '<pre class="dev-result dev-error">' + esc(error.message) + '</pre>';
    }
  };
  window.devExportLogs = function () {
    download('cheerful-developer-logs-' + new Date().toISOString().slice(0, 10) + '.json', { api: apiLog, activity: serverLogs.activity, errors: serverLogs.errors, runtimeErrors: runtimeErrors });
  };
  window.devDownloadErrors = async function () {
    if (!serverLogs.errors.length) await loadLogs();
    download('cheerful-error-logs-' + new Date().toISOString().slice(0, 10) + '.json', { server: serverLogs.errors, frontend: runtimeErrors });
  };
  window.devDownloadSnapshot = async function () {
    showToastMessage('正在生成数据库快照…');
    try {
      var snapshot = await request('snapshot');
      download('cheerful-database-snapshot-' + new Date().toISOString().slice(0, 10) + '.json', snapshot);
      showToastMessage('数据库快照已生成');
    } catch (error) { alert(error.message); }
  };
  window.devTestAction = async function (action) {
    var node = document.getElementById('devTestResult');
    if (node) node.innerHTML = loading('正在执行测试…');
    try {
      var result = await request(action, { method: 'POST', body: JSON.stringify({ action: action }) });
      if (node) node.innerHTML = '<pre class="dev-result">' + esc(JSON.stringify(result, null, 2)) + '</pre>';
      if (window.CheerfulSupabase && /song/.test(action)) window.CheerfulSupabase.refreshCatalog().catch(function () {});
    } catch (error) {
      if (node) node.innerHTML = '<pre class="dev-result dev-error">' + esc(error.message) + '</pre>';
    }
  };

  installApiMonitor();
  injectStyles();
})();
