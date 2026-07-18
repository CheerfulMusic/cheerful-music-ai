(function () {
  'use strict';

  const STORAGE_KEY = 'cm_cheerful_gpt_conversations_v1';
  const MAX_LOCAL_CONVERSATIONS = 20;
  const MAX_LOCAL_MESSAGES = 60;
  const gptState = {
    session: null,
    loadingSession: true,
    conversations: loadConversations(),
    activeId: null,
    streaming: false,
    uploading: false,
    pendingAttachments: [],
    webSearch: true,
    includeContext: true,
    audit: null,
    scopeOpen: false
  };

  function uid() {
    return window.crypto && crypto.randomUUID ? crypto.randomUUID() : `cgpt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function loadConversations() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function saveConversations() {
    const compact = gptState.conversations.slice(0, MAX_LOCAL_CONVERSATIONS).map(conversation => ({
      ...conversation,
      messages: (conversation.messages || []).slice(-MAX_LOCAL_MESSAGES)
    }));
    gptState.conversations = compact;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
  }

  function currentConversation() {
    return gptState.conversations.find(conversation => conversation.id === gptState.activeId) || null;
  }

  function createConversation() {
    const conversation = { id: uid(), title: '新对话', createdAt: new Date().toISOString(), messages: [] };
    gptState.conversations.unshift(conversation);
    gptState.activeId = conversation.id;
    saveConversations();
    return conversation;
  }

  function ensureConversation() {
    if (!gptState.activeId && gptState.conversations.length) gptState.activeId = gptState.conversations[0].id;
    return currentConversation() || createConversation();
  }

  function formatTime(value) {
    try { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return '—'; }
  }

  function safeMarkdown(value) {
    let text = escapeHtml(value);
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    text = text.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    return text.split(/\n{2,}/).map(paragraph => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`).join('');
  }

  function roleLabel(role) {
    return { admin: '管理员', finance: '财务', ceo: 'CEO', ar: 'A&R', hr: 'HR', copyright: '版权', distribution: '发行', marketing: '推广', legal: '法务', member: '成员', viewer: '只读' }[role] || role;
  }

  function can(permission) {
    return Boolean(gptState.session && gptState.session.permissions && gptState.session.permissions.includes(permission));
  }

  function appendGptNav() {
    const nav = document.getElementById('nav');
    if (!nav || nav.querySelector('[data-id="cheerful-gpt"]')) return;
    const button = document.createElement('button');
    button.dataset.id = 'cheerful-gpt';
    button.className = current === 'cheerful-gpt' ? 'active' : '';
    button.innerHTML = '<span class="ico">✦</span>Cheerful GPT';
    button.onclick = () => openSection('cheerful-gpt');
    const dashboardButton = nav.querySelector('[data-id="dashboard"]');
    if (dashboardButton) dashboardButton.insertAdjacentElement('afterend', button);
    else nav.prepend(button);
  }

  const baseBuildNav = window.buildNav;
  const baseOpenSection = window.openSection;
  window.buildNav = function () {
    baseBuildNav();
    appendGptNav();
  };
  window.openSection = function (id) {
    if (id !== 'cheerful-gpt') return baseOpenSection(id);
    current = id;
    window.buildNav();
    document.getElementById('pageTitle').textContent = 'Cheerful GPT';
    document.getElementById('content').innerHTML = renderRoot();
    initPage();
  };

  function renderRoot() {
    return '<section class="section active" id="cheerfulGptRoot"><div class="cgpt-loading">正在建立安全会话…</div></section>';
  }

  async function initPage() {
    await refreshSession();
    if (gptState.session) {
      ensureConversation();
      await syncServerHistory();
    }
    renderPage();
  }

  async function refreshSession() {
    gptState.loadingSession = true;
    try {
      const response = await fetch('/api/gpt-session', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      gptState.session = data.authenticated ? data.user : null;
      gptState.sessionError = response.ok ? '' : (data.error || '安全会话暂不可用。');
    } catch (_) {
      gptState.session = null;
      gptState.sessionError = '尚未连接到 Cheerful GPT 后端。请检查 Vercel 部署。';
    } finally {
      gptState.loadingSession = false;
    }
  }

  function renderPage() {
    const root = document.getElementById('cheerfulGptRoot');
    if (!root) return;
    if (gptState.loadingSession) {
      root.innerHTML = '<div class="cgpt-loading">正在建立安全会话…</div>';
      return;
    }
    root.innerHTML = gptState.session ? renderChat() : renderGate();
    bindChatEvents();
  }

  function renderGate() {
    return `<div class="cgpt-gate"><div class="cgpt-gate-card">
      <div class="cgpt-logo">C</div><h2>登录会话已失效</h2>
      <p>Cheerful GPT 与 Cheerful Music AI OS 使用同一个登录身份。请返回登录页面重新验证，不需要第二个访问码。</p>
      <button type="button" id="cgptReturnLogin">返回登录页面</button>
      <div class="cgpt-gate-error" id="cgptGateError">${escapeHtml(gptState.sessionError || '')}</div>
    </div></div>`;
  }

  function renderChat() {
    const conversation = ensureConversation();
    const permissions = gptState.session.permissions || [];
    const contextDisabled = !permissions.includes('internal_context');
    const searchDisabled = !permissions.includes('web_search');
    return `<div class="cgpt-shell">
      <aside class="cgpt-sidebar">
        <div class="cgpt-brand"><h2>Cheerful GPT</h2><p>青风音乐内部 AI 助手</p></div>
        <button class="cgpt-new" id="cgptNewConversation">＋ 新对话</button>
        <div class="cgpt-history-label">对话记录</div>
        <div class="cgpt-history">${gptState.conversations.map(item => `<button data-cgpt-conversation="${escapeHtml(item.id)}" class="${item.id === gptState.activeId ? 'active' : ''}" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</button>`).join('')}</div>
        <div class="cgpt-account"><div class="cgpt-account-row"><div class="cgpt-avatar">${escapeHtml(gptState.session.name.slice(0, 2).toUpperCase())}</div><div class="cgpt-account-copy"><b>${escapeHtml(gptState.session.name)}</b><span>${escapeHtml(roleLabel(gptState.session.role))} · 安全会话</span></div></div><button class="cgpt-logout" id="cgptLogout">退出 Cheerful GPT</button></div>
      </aside>
      <main class="cgpt-main">
        <header class="cgpt-topbar"><div class="cgpt-heading"><h1>${escapeHtml(conversation.title)}</h1><p>服务器安全调用 OpenAI Responses API</p></div>
          <div class="cgpt-controls">
            <label class="cgpt-toggle ${searchDisabled ? 'disabled' : ''}"><input id="cgptWebSearch" type="checkbox" ${gptState.webSearch && !searchDisabled ? 'checked' : ''} ${searchDisabled ? 'disabled' : ''}>联网搜索</label>
            <label class="cgpt-toggle ${contextDisabled ? 'disabled' : ''}"><input id="cgptContext" type="checkbox" ${gptState.includeContext && !contextDisabled ? 'checked' : ''} ${contextDisabled ? 'disabled' : ''}>使用内部数据</label>
            <button class="cgpt-action" id="cgptScopeButton">权限范围</button>
            ${can('audit_view') ? '<button class="cgpt-action" id="cgptAuditButton">审计日志</button>' : ''}
          </div>
        </header>
        <div class="cgpt-messages" id="cgptMessages">${renderMessages(conversation)}</div>
        <div class="cgpt-composer">
          ${renderDataBoundary()}
          <div class="cgpt-compose-box">
            ${gptState.pendingAttachments.length ? `<div class="cgpt-attachments">${gptState.pendingAttachments.map((file, index) => `<span class="cgpt-file-chip">${escapeHtml(file.name)}<button data-cgpt-remove-file="${index}" title="移除">×</button></span>`).join('')}</div>` : ''}
            <textarea id="cgptInput" rows="1" placeholder="${can('internal_context') ? '询问当前账号获准访问的内部数据，或搜索公开资料…' : '搜索公开资料、行业新闻、市场趋势或提出工作问题…'}"></textarea><div class="cgpt-compose-foot"><div class="cgpt-compose-left"><button class="cgpt-attach" id="cgptAttach" ${can('file_upload') && !gptState.uploading ? '' : 'disabled'} title="上传合同、PDF、Excel 或 CSV">＋ 文件</button><input id="cgptFileInput" type="file" hidden multiple accept=".pdf,.csv,.xlsx,.xls,.doc,.docx,.txt,.md,.json,.rtf"><span class="cgpt-compose-note">${gptState.uploading ? '正在安全上传文件…' : 'AI 可能出错；重要结论需人工审核。'}</span></div><button class="cgpt-send" id="cgptSend" title="发送" ${gptState.uploading ? 'disabled' : ''}>↑</button></div>
          </div>
        </div>
      </main>
    </div>${gptState.scopeOpen ? renderScope() : ''}${gptState.audit ? renderAudit() : ''}`;
  }

  function renderDataBoundary() {
    if (!can('internal_context')) return '<div class="cgpt-banner">当前账号可对话和联网搜索公开资料，但不能读取任何青风音乐内部数据。</div>';
    if (gptState.session.role === 'ceo') return '<div class="cgpt-banner">CEO：可搜索公开资料，并读取全部已接入的青风音乐内部数据。</div>';
    if (can('financial_data')) return '<div class="cgpt-banner">财务：可搜索公开资料，并读取歌曲、版税规则、分成比例、平台收入及金额；不能读取人事数据。</div>';
    if (can('hr_data')) return '<div class="cgpt-banner">HR：可搜索公开资料，并读取招聘与人事数据；不能读取音乐财务、版税比例或金额。</div>';
    if (can('legal_data')) return '<div class="cgpt-banner">法务：可搜索公开资料，并读取合同与法务数据；不能读取版税结算金额。</div>';
    if (can('catalog_context')) return '<div class="cgpt-banner">A&R：可搜索公开资料，并读取歌曲库、艺人、录音版本及 Song Matching 数据；不能读取分成比例或金额。</div>';
    return '';
  }

  function renderMessages(conversation) {
    if (!conversation.messages.length) {
      if (!can('internal_context')) {
        return `<div class="cgpt-empty"><div class="cgpt-logo">C</div><h2>我可以帮你搜索什么？</h2><p>你可以进行多轮对话和联网搜索公开资料。青风音乐内部歌曲、合同、版税比例及金额不会提供给当前账号。</p><div class="cgpt-prompts">
          <button class="cgpt-prompt" data-cgpt-prompt="搜索本周全球音乐行业的重要新闻，并列出来源和发布日期。">搜索音乐行业新闻</button>
          <button class="cgpt-prompt" data-cgpt-prompt="搜索近期全球流媒体平台的公开规则变化，并说明可能影响。">查询流媒体规则变化</button>
          <button class="cgpt-prompt" data-cgpt-prompt="研究当前海外音乐市场的公开趋势和增长机会，并标注资料来源。">研究海外市场趋势</button>
          <button class="cgpt-prompt" data-cgpt-prompt="搜索公开资料，整理一份音乐营销案例与可复用方法。">搜索音乐营销案例</button>
        </div></div>`;
      }
      if (gptState.session.role === 'hr') {
        return `<div class="cgpt-empty"><div class="cgpt-logo">C</div><h2>HR 工作助手</h2><p>可搜索公开资料，并在权限范围内使用招聘与人事数据。</p><div class="cgpt-prompts">
          <button class="cgpt-prompt" data-cgpt-prompt="根据当前招聘数据总结候选人进展和待处理事项。">总结招聘进展</button>
          <button class="cgpt-prompt" data-cgpt-prompt="根据当前候选人资料整理面试准备清单。">准备面试清单</button>
          <button class="cgpt-prompt" data-cgpt-prompt="搜索音乐行业近期招聘趋势，并标注资料来源。">搜索招聘趋势</button>
          <button class="cgpt-prompt" data-cgpt-prompt="搜索公开资料，整理一份新人培训最佳实践。">研究新人培训</button>
        </div></div>`;
      }
      if (gptState.session.role === 'legal') {
        return `<div class="cgpt-empty"><div class="cgpt-logo">C</div><h2>法务工作助手</h2><p>可搜索公开资料，并在权限范围内使用合同与法务数据。</p><div class="cgpt-prompts">
          <button class="cgpt-prompt" data-cgpt-prompt="根据当前合同资料列出即将到期和需要复核的事项。">检查合同待办</button>
          <button class="cgpt-prompt" data-cgpt-prompt="根据当前合同资料总结主要权利、期限和风险。">总结合同风险</button>
          <button class="cgpt-prompt" data-cgpt-prompt="搜索近期音乐版权法规变化，并标注权威来源。">搜索法规变化</button>
          <button class="cgpt-prompt" data-cgpt-prompt="搜索公开资料，整理音乐授权合同常见风险。">研究授权风险</button>
        </div></div>`;
      }
      if (gptState.session.role === 'ar') {
        return `<div class="cgpt-empty"><div class="cgpt-logo">C</div><h2>A&amp;R 工作助手</h2><p>可搜索公开资料，并在权限范围内使用歌曲库、艺人、ISRC/UPC 与匹配数据。</p><div class="cgpt-prompts">
          <button class="cgpt-prompt" data-cgpt-prompt="总结当前歌曲库的数据质量，并列出需要优先处理的问题。">分析歌曲库数据质量</button>
          <button class="cgpt-prompt" data-cgpt-prompt="检查当前歌曲匹配结果，列出需要人工确认的录音版本。">检查 Song Matching</button>
          <button class="cgpt-prompt" data-cgpt-prompt="搜索本周全球音乐趋势，并标注资料来源。">搜索全球音乐趋势</button>
          <button class="cgpt-prompt" data-cgpt-prompt="搜索公开资料，分析近期热门歌曲的创作与传播特点。">研究热门歌曲</button>
        </div></div>`;
      }
      return `<div class="cgpt-empty"><div class="cgpt-logo">C</div><h2>我可以为青风音乐做什么？</h2><p>可进行多轮对话、联网搜索，也可以在权限允许时使用当前浏览器中的歌曲库、Royalty Matrix、平台导入、匹配和版税结果作为受控上下文。</p><div class="cgpt-prompts">
        <button class="cgpt-prompt" data-cgpt-prompt="总结当前歌曲库的数据质量，并列出需要优先处理的问题。">分析歌曲库数据质量</button>
        <button class="cgpt-prompt" data-cgpt-prompt="根据当前版税规则，找出可能过期、重叠或缺失的规则。">检查 Royalty Matrix</button>
        <button class="cgpt-prompt" data-cgpt-prompt="搜索本周全球音乐行业的重要新闻，并说明对青风音乐可能的影响。">联网搜索行业新闻</button>
        <button class="cgpt-prompt" data-cgpt-prompt="根据当前平台收入和匹配情况，给我一份管理层摘要。">生成版税管理摘要</button>
      </div></div>`;
    }
    return conversation.messages.map(message => renderMessage(message)).join('');
  }

  function renderMessage(message) {
    const sources = Array.isArray(message.sources) ? message.sources : [];
    return `<article class="cgpt-message ${message.role === 'user' ? 'user' : 'assistant'}" data-message-id="${escapeHtml(message.id)}">
      <div class="cgpt-message-avatar">${message.role === 'user' ? 'SN' : 'C'}</div>
      <div class="cgpt-message-body">${Array.isArray(message.attachments) && message.attachments.length ? `<div class="cgpt-message-files">${message.attachments.map(file => `<span>📎 ${escapeHtml(file.name)}</span>`).join('')}</div>` : ''}<div class="cgpt-message-text">${safeMarkdown(message.content || '')}${message.streaming ? '<span class="cgpt-cursor"></span>' : ''}</div>
      ${sources.length ? `<div class="cgpt-sources">${sources.map(source => `<a class="cgpt-source" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || source.url)}</a>`).join('')}</div>` : ''}</div>
    </article>`;
  }

  function bindChatEvents() {
    document.getElementById('cgptReturnLogin')?.addEventListener('click', () => {
      if (typeof window.logout === 'function') window.logout();
    });
    document.getElementById('cgptNewConversation')?.addEventListener('click', () => { createConversation(); renderPage(); });
    document.querySelectorAll('[data-cgpt-conversation]').forEach(button => button.addEventListener('click', () => { gptState.activeId = button.dataset.cgptConversation; renderPage(); }));
    document.querySelectorAll('[data-cgpt-prompt]').forEach(button => button.addEventListener('click', () => { const input = document.getElementById('cgptInput'); input.value = button.dataset.cgptPrompt; input.focus(); }));
    document.getElementById('cgptWebSearch')?.addEventListener('change', event => { gptState.webSearch = event.target.checked; });
    document.getElementById('cgptContext')?.addEventListener('change', event => { gptState.includeContext = event.target.checked; });
    document.getElementById('cgptSend')?.addEventListener('click', sendMessage);
    document.getElementById('cgptAttach')?.addEventListener('click', () => document.getElementById('cgptFileInput').click());
    document.getElementById('cgptFileInput')?.addEventListener('change', event => uploadFiles(Array.from(event.target.files || [])));
    document.querySelectorAll('[data-cgpt-remove-file]').forEach(button => button.addEventListener('click', () => { gptState.pendingAttachments.splice(Number(button.dataset.cgptRemoveFile), 1); renderPage(); }));
    document.getElementById('cgptInput')?.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
    document.getElementById('cgptInput')?.addEventListener('input', event => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`; });
    document.getElementById('cgptLogout')?.addEventListener('click', logoutSession);
    document.getElementById('cgptAuditButton')?.addEventListener('click', openAudit);
    document.getElementById('cgptAuditClose')?.addEventListener('click', () => { gptState.audit = null; renderPage(); });
    document.getElementById('cgptScopeButton')?.addEventListener('click', () => { gptState.scopeOpen = true; renderPage(); });
    document.getElementById('cgptScopeClose')?.addEventListener('click', () => { gptState.scopeOpen = false; renderPage(); });
    scrollMessages();
  }

  async function logoutSession() {
    await fetch('/api/gpt-session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => null);
    gptState.session = null;
    if (typeof window.logout === 'function') await window.logout();
    else renderPage();
  }

  function relevantRecords(records, query, fields, limit) {
    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(token => token.length > 1);
    const scored = records.map(record => {
      const text = fields.map(field => record[field] || '').join(' ').toLowerCase();
      return { record, score: tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0) };
    }).filter(item => !tokens.length || item.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(item => item.record);
  }

  function parseStorage(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; }
    catch (_) { return fallback; }
  }

  function buildBusinessContext(query) {
    const recordings = typeof financeRecordings !== 'undefined' ? financeRecordings : [];
    const rules = typeof financeRules !== 'undefined' ? financeRules : [];
    const imports = parseStorage('cm_finance_imports_v131', []);
    const matches = parseStorage('cm_finance_matches_v140', []);
    const calculations = parseStorage('cm_finance_calculations_v140', []);
    const exceptions = parseStorage('cm_finance_exception_reviews_v140', []);
    const hrRecords = parseStorage('cm_hr_records', []);
    const recruitmentRecords = parseStorage('cm_recruitment_records', []);
    const contracts = parseStorage('cm_legal_contracts', []);
    const legalRecords = parseStorage('cm_legal_records', []);
    return {
      generatedAt: new Date().toISOString(),
      scope: 'Only records relevant to the current user question are included. Counts cover all browser records.',
      summary: {
        recordingCount: recordings.length,
        royaltyRuleCount: rules.length,
        importBatchCount: imports.length,
        matchedRowCount: matches.length,
        calculationCount: calculations.length,
        exceptionCount: exceptions.length
      },
      ...(can('catalog_context') ? { recordings: relevantRecords(recordings, query, ['id', 'workId', 'workTitle', 'alternativeTitle', 'artist', 'versionName', 'isrc', 'iswc', 'upc'], 60) } : {}),
      ...(can('financial_data') ? {
        royaltyRules: relevantRecords(rules, query, ['id', 'recordingId', 'payee', 'role', 'royaltyType', 'contractNo', 'territory', 'platform'], 60),
        recentImports: imports.slice(-8),
        relevantMatches: relevantRecords(matches, query, ['title', 'artist', 'isrc', 'recordingId', 'reason', 'status'], 40),
        relevantCalculations: relevantRecords(calculations, query, ['recordingId', 'payee', 'currency', 'contractNo', 'status'], 40),
        relevantExceptions: relevantRecords(exceptions, query, ['type', 'risk', 'subject', 'description', 'status'], 40)
      } : { financialDataRestricted: true }),
      ...(can('hr_data') ? {
        hrRecords: relevantRecords(hrRecords, query, ['name', 'department', 'role', 'status', 'notes'], 60),
        recruitmentRecords: relevantRecords(recruitmentRecords, query, ['candidate', 'position', 'status', 'notes'], 60)
      } : {}),
      ...(can('legal_data') ? {
        contracts: relevantRecords(contracts, query, ['contractNo', 'title', 'counterparty', 'status', 'notes'], 60),
        legalRecords: relevantRecords(legalRecords, query, ['title', 'type', 'status', 'notes'], 60)
      } : {})
    };
  }

  async function sendMessage() {
    if (gptState.streaming) return;
    const input = document.getElementById('cgptInput');
    const content = String(input.value || '').trim();
    if (!content) return;
    const conversation = ensureConversation();
    if (conversation.title === '新对话') conversation.title = content.slice(0, 26);
    const userMessage = { id: uid(), role: 'user', content, attachments: gptState.pendingAttachments.slice(), createdAt: new Date().toISOString() };
    const assistantMessage = { id: uid(), role: 'assistant', content: '', sources: [], streaming: true, createdAt: new Date().toISOString() };
    conversation.messages.push(userMessage, assistantMessage);
    gptState.pendingAttachments = [];
    input.value = '';
    gptState.streaming = true;
    saveConversations();
    renderPage();
    const sendButton = document.getElementById('cgptSend');
    if (sendButton) sendButton.disabled = true;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation.id,
          messages: conversation.messages.filter(message => !message.streaming).map(({ role, content: text, attachments }) => ({ role, content: text, attachments: attachments || [] })),
          webSearch: gptState.webSearch && can('web_search'),
          includeContext: gptState.includeContext && can('internal_context'),
          businessContext: gptState.includeContext && can('internal_context') ? buildBusinessContext(content) : null
        })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `请求失败（${response.status}）`);
      }
      if (!response.body) throw new Error('服务器未返回流式响应。');
      await consumeStream(response.body, assistantMessage);
    } catch (error) {
      assistantMessage.content = `暂时无法完成请求：${error.message}`;
    } finally {
      assistantMessage.streaming = false;
      gptState.streaming = false;
      saveConversations();
      renderPage();
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
      reader.onload = () => resolve(String(reader.result || '').split(',').pop() || '');
      reader.readAsDataURL(file);
    });
  }

  async function uploadFiles(files) {
    if (!can('file_upload') || !files.length || gptState.uploading) return;
    const room = Math.max(0, 5 - gptState.pendingAttachments.length);
    const selected = files.slice(0, room);
    gptState.uploading = true;
    renderPage();
    try {
      for (const file of selected) {
        if (file.size > 3 * 1024 * 1024) throw new Error(`${file.name} 超过 3 MB，请压缩或拆分后上传。`);
        const data = await fileToBase64(file);
        const response = await fetch('/api/gpt-file', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, type: file.type, data })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `${file.name} 上传失败。`);
        gptState.pendingAttachments.push({ fileId: result.fileId, name: result.name, bytes: result.bytes });
      }
    } catch (error) {
      alert(error.message);
    } finally {
      gptState.uploading = false;
      renderPage();
    }
  }

  async function consumeStream(body, assistantMessage) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      blocks.forEach(block => {
        let eventName = 'message';
        let data = '';
        block.split('\n').forEach(line => {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trim();
        });
        if (!data) return;
        let payload;
        try { payload = JSON.parse(data); } catch (_) { return; }
        if (eventName === 'delta') assistantMessage.content += payload.text || '';
        if (eventName === 'sources') assistantMessage.sources = payload.sources || [];
        if (eventName === 'error') assistantMessage.content += `\n\n[错误] ${payload.error || '生成失败'}`;
        updateStreamingMessage(assistantMessage);
      });
    }
  }

  function updateStreamingMessage(message) {
    const article = document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
    if (!article) return;
    const text = article.querySelector('.cgpt-message-text');
    if (text) text.innerHTML = `${safeMarkdown(message.content)}<span class="cgpt-cursor"></span>`;
    scrollMessages();
  }

  function scrollMessages() {
    const node = document.getElementById('cgptMessages');
    if (node) node.scrollTop = node.scrollHeight;
  }

  async function syncServerHistory() {
    if (!can('history')) return;
    try {
      const response = await fetch('/api/gpt-history', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (data.storage !== 'supabase' || !Array.isArray(data.messages) || !data.messages.length) return;
      const groups = data.messages.reduce((result, message) => {
        const id = message.conversation_id;
        if (!result[id]) result[id] = [];
        result[id].push({ id: uid(), role: message.role, content: message.content, createdAt: message.created_at, sources: message.sources || [] });
        return result;
      }, {});
      Object.entries(groups).forEach(([id, messages]) => {
        if (!gptState.conversations.some(item => item.id === id)) {
          const firstUser = messages.find(message => message.role === 'user');
          gptState.conversations.push({ id, title: firstUser ? firstUser.content.slice(0, 26) : '历史对话', createdAt: messages[0].createdAt, messages });
        }
      });
      saveConversations();
    } catch (_) {}
  }

  async function openAudit() {
    gptState.audit = { loading: true, storage: '', events: [] };
    renderPage();
    try {
      const response = await fetch('/api/gpt-audit', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '读取审计日志失败。');
      gptState.audit = { loading: false, storage: data.storage, events: data.events || [] };
    } catch (error) {
      gptState.audit = { loading: false, error: error.message, storage: '', events: [] };
    }
    renderPage();
  }

  function renderAudit() {
    const audit = gptState.audit;
    const rows = (audit.events || []).map(event => `<tr><td>${escapeHtml(formatTime(event.created_at))}</td><td>${escapeHtml(event.actor_name)}</td><td>${escapeHtml(roleLabel(event.actor_role))}</td><td>${escapeHtml(event.action)}</td><td>${escapeHtml(event.conversation_id || '—')}</td></tr>`).join('');
    return `<div class="cgpt-audit"><div class="cgpt-audit-card"><div class="cgpt-audit-head"><div><h3>Cheerful GPT 审计日志</h3><div class="cgpt-compose-note">存储：${escapeHtml(audit.storage || '检查中')}</div></div><button class="cgpt-action" id="cgptAuditClose">关闭</button></div>
      ${audit.loading ? '<div class="cgpt-loading">正在读取审计日志…</div>' : (audit.error ? `<div class="cgpt-banner">${escapeHtml(audit.error)}</div>` : `<table><thead><tr><th>时间</th><th>用户</th><th>角色</th><th>操作</th><th>对话</th></tr></thead><tbody>${rows || '<tr><td colspan="5">暂无可查询的持久化审计记录；操作仍会写入 Vercel Functions 日志。</td></tr>'}</tbody></table>`)}</div></div>`;
  }

  function accessMode(fullPermission, readPermission, limitedPermission) {
    if (fullPermission && can(fullPermission)) return ['完整', 'full'];
    if (readPermission && can(readPermission)) return ['只读', 'read'];
    if (limitedPermission && can(limitedPermission)) return ['部分', 'limited'];
    return ['无权限', 'none'];
  }

  function renderScope() {
    const rows = [
      ['互联网公开资料', accessMode('web_search')],
      ['歌曲库', accessMode('song_library_write', 'song_library_read')],
      ['Royalty Matrix／分成比例', accessMode('royalty_rules_write', 'royalty_rules_read')],
      ['平台版税导入', accessMode('platform_royalty_write', 'platform_royalty_read')],
      ['AI Song Matching', accessMode('song_matching_write', 'song_matching_read')],
      ['版税计算', accessMode('royalty_calculation')],
      ['金额报表', accessMode('financial_reports')],
      ['合同', accessMode('contracts_full', null, 'contracts_limited')],
      ['招聘', accessMode('recruitment_write', 'recruitment_read')]
    ];
    const permissionRows = rows.map(([label, mode]) => `<div class="cgpt-scope-row"><span>${escapeHtml(label)}</span><b class="${mode[1]}">${mode[1] === 'full' ? '✓' : mode[1] === 'read' ? '◉' : mode[1] === 'limited' ? '◐' : '×'} ${mode[0]}</b></div>`).join('');
    const boundary = renderDataBoundary();
    return `<div class="cgpt-audit"><div class="cgpt-audit-card cgpt-scope-card"><div class="cgpt-audit-head"><div><h3>AI 工作台权限</h3><div class="cgpt-compose-note">${escapeHtml(gptState.session.name)} · ${escapeHtml(roleLabel(gptState.session.role))}。Cheerful AI 只会读取当前角色允许的数据。</div></div><button class="cgpt-action" id="cgptScopeClose">关闭</button></div><div class="cgpt-scope-list">${permissionRows}</div>${boundary}</div></div>`;
  }

  document.addEventListener('cheerful:session', event => {
    gptState.session = event.detail || null;
    if (document.getElementById('cheerfulGptRoot')) {
      if (gptState.session) ensureConversation();
      renderPage();
    }
  });
})();
