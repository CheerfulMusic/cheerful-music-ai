(function () {
  'use strict';

  const CATALOG_KEY = 'cm_finance_recordings';
  const RULES_KEY = 'cm_finance_rules';
  const IMPORTS_KEY = 'cm_finance_imports_v131';
  const BATCH_SIZE = 250;
  let activeUser = null;
  let syncTimer = null;
  let lastImportSnapshot = localStorage.getItem(IMPORTS_KEY) || '[]';
  let pollingStarted = false;
  let knownCatalog = new Map(typeof financeRecordings !== 'undefined' ? financeRecordings.map(record => [record.id, JSON.stringify(record)]) : []);
  let knownRules = new Map(typeof financeRules !== 'undefined' ? financeRules.map(record => [record.id, JSON.stringify(record)]) : []);

  function can(permission) {
    return Boolean(activeUser && Array.isArray(activeUser.permissions) && activeUser.permissions.includes(permission));
  }

  async function request(resource, options) {
    const response = await fetch(`/api/os-data?resource=${encodeURIComponent(resource)}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...((options && options.headers) || {}) },
      ...(options || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Supabase request failed (${response.status})`);
    return data;
  }

  function chunks(records) {
    const output = [];
    for (let index = 0; index < records.length; index += BATCH_SIZE) output.push(records.slice(index, index + BATCH_SIZE));
    return output;
  }

  async function sendBatches(resource, records) {
    const batches = chunks(records);
    const results = [];
    for (const batch of batches) {
      results.push(await request(resource, { method: 'POST', body: JSON.stringify({ resource, records: batch }) }));
    }
    return results;
  }

  async function deleteCodes(resource, codes) {
    for (const batch of chunks(codes)) {
      await request(resource, { method: 'DELETE', body: JSON.stringify({ resource, codes: batch }) });
    }
  }

  function remoteCatalog(records) {
    return records.map(record => {
      const song = record.songs || {};
      return {
        id: record.recording_id,
        workId: song.work_id || '',
        workTitle: song.title || '',
        alternativeTitle: Array.isArray(song.alternative_titles) ? song.alternative_titles.join(' | ') : '',
        artist: record.artist_name || '',
        versionName: record.version_name || '',
        versionType: record.version_type || '',
        isrc: record.isrc || '',
        iswc: song.iswc || '',
        upc: record.upc || '',
        language: song.language || '',
        releaseDate: record.release_date || '',
        label: record.label || song.label || '',
        copyrightOwner: song.copyright_owner || '',
        recordingOwner: record.recording_owner || '',
        status: record.status || 'released',
        notes: record.notes || song.notes || ''
      };
    }).filter(record => record.id);
  }

  function remoteRules(records) {
    return records.map(record => ({
      id: record.rule_code,
      recordingId: record.recordings && record.recordings.recording_id || '',
      artistName: record.artist_name || '',
      payee: record.payee_name || '',
      role: record.role || 'Artist',
      royaltyType: record.royalty_type || 'Artist Royalty',
      percentage: Number(record.share_percentage || 0),
      basis: record.calculation_basis || 'Net Receipts',
      startDate: record.effective_date || '',
      endDate: record.end_date || '',
      territory: record.territory || 'Worldwide',
      platform: record.platform || 'All',
      currency: record.currency || '',
      contractNo: record.contract_no || '',
      notes: record.notes || ''
    })).filter(record => record.id && record.recordingId);
  }

  function remoteImports(records) {
    return records.map(record => ({
      id: record.batch_no,
      platform: record.platform,
      fileName: record.original_filename,
      period: record.metadata && record.metadata.period || [record.period_start, record.period_end].filter(Boolean).join(' – '),
      rowCount: Number(record.total_rows || 0),
      songCount: Number(record.metadata && record.metadata.songCount || 0),
      revenue: Number(record.total_amount || 0),
      currency: record.currency || '未识别',
      status: record.status,
      headers: record.metadata && record.metadata.headers || [],
      mapping: record.metadata && record.metadata.mapping || {},
      rows: record.metadata && record.metadata.preview || []
    })).filter(record => record.id);
  }

  async function hydrate() {
    if (!activeUser) return;
    const status = await request('status');
    if (!status.connected) return;
    const tasks = [];
    if (can('song_library_read')) tasks.push(request('catalog').then(result => ({ key: CATALOG_KEY, records: remoteCatalog(result.data || []) })));
    if (can('royalty_rules_read')) tasks.push(request('royalty_rules').then(result => ({ key: RULES_KEY, records: remoteRules(result.data || []) })));
    if (can('platform_royalty_read')) tasks.push(request('royalty_imports').then(result => ({ key: IMPORTS_KEY, records: remoteImports(result.data || []) })));
    const datasets = await Promise.all(tasks);
    let changed = false;
    datasets.forEach(dataset => {
      if (!dataset.records.length) return;
      const serialized = JSON.stringify(dataset.records);
      if (localStorage.getItem(dataset.key) !== serialized) {
        localStorage.setItem(dataset.key, serialized);
        changed = true;
      }
      if (dataset.key === CATALOG_KEY && typeof financeRecordings !== 'undefined') financeRecordings = dataset.records;
      if (dataset.key === RULES_KEY && typeof financeRules !== 'undefined') financeRules = dataset.records;
    });
    if (typeof financeRecordings !== 'undefined' && datasets.some(dataset => dataset.key === CATALOG_KEY && dataset.records.length)) {
      knownCatalog = new Map(financeRecordings.map(record => [record.id, JSON.stringify(record)]));
    }
    if (typeof financeRules !== 'undefined' && datasets.some(dataset => dataset.key === RULES_KEY && dataset.records.length)) {
      knownRules = new Map(financeRules.map(record => [record.id, JSON.stringify(record)]));
    }
    lastImportSnapshot = localStorage.getItem(IMPORTS_KEY) || '[]';

    const hydratedKey = `cm_supabase_hydrated_${activeUser.id || activeUser.email || activeUser.role}`;
    if (changed && !sessionStorage.getItem(hydratedKey)) {
      sessionStorage.setItem(hydratedKey, 'true');
      location.reload();
      return;
    }
    if (typeof current !== 'undefined' && current === 'finance' && typeof openSection === 'function') openSection('finance');

    const catalogEmpty = datasets.some(dataset => dataset.key === CATALOG_KEY && !dataset.records.length);
    const rulesEmpty = datasets.some(dataset => dataset.key === RULES_KEY && !dataset.records.length);
    const importsEmpty = datasets.some(dataset => dataset.key === IMPORTS_KEY && !dataset.records.length);
    const localImports = (() => { try { return JSON.parse(localStorage.getItem(IMPORTS_KEY) || '[]'); } catch (_) { return []; } })();
    if ((catalogEmpty && typeof financeRecordings !== 'undefined' && financeRecordings.length > 5) ||
        (rulesEmpty && typeof financeRules !== 'undefined' && financeRules.length > 3)) {
      await syncFinanceData(true);
    }
    if (importsEmpty && Array.isArray(localImports) && localImports.length && can('platform_royalty_write')) {
      await sendBatches('royalty_imports', localImports);
    }
  }

  async function syncFinanceData(force) {
    if (!activeUser) return;
    try {
      const nextCatalog = typeof financeRecordings !== 'undefined' ? new Map(financeRecordings.map(record => [record.id, JSON.stringify(record)])) : knownCatalog;
      const nextRules = typeof financeRules !== 'undefined' ? new Map(financeRules.map(record => [record.id, JSON.stringify(record)])) : knownRules;
      if (can('royalty_rules_write') && typeof financeRules !== 'undefined') {
        const deleted = [...knownRules.keys()].filter(id => !nextRules.has(id));
        if (deleted.length) await deleteCodes('royalty_rules', deleted);
      }
      if (can('song_library_write') && typeof financeRecordings !== 'undefined') {
        const deleted = [...knownCatalog.keys()].filter(id => !nextCatalog.has(id));
        if (deleted.length) await deleteCodes('catalog', deleted);
        const changed = force ? financeRecordings : financeRecordings.filter(record => knownCatalog.get(record.id) !== JSON.stringify(record));
        if (changed.length) await sendBatches('catalog', changed);
        knownCatalog = nextCatalog;
      }
      if (can('royalty_rules_write') && typeof financeRules !== 'undefined') {
        const changed = force ? financeRules : financeRules.filter(record => knownRules.get(record.id) !== JSON.stringify(record));
        if (changed.length) await sendBatches('royalty_rules', changed);
        knownRules = nextRules;
      }
      if (typeof showToastMessage === 'function') showToastMessage('数据已安全同步到 Supabase');
    } catch (error) {
      console.error('Cheerful Supabase sync failed', error);
      if (typeof showToastMessage === 'function') showToastMessage('本机已保存；Supabase 同步暂未完成');
    }
  }

  function queueFinanceSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncFinanceData, 800);
  }

  async function syncImportsIfChanged() {
    if (!can('platform_royalty_write')) return;
    const snapshot = localStorage.getItem(IMPORTS_KEY) || '[]';
    if (snapshot === lastImportSnapshot) return;
    let previous = [];
    try { previous = JSON.parse(lastImportSnapshot); } catch (_) {}
    lastImportSnapshot = snapshot;
    let records = [];
    try { records = JSON.parse(snapshot); } catch (_) {}
    if (!Array.isArray(records)) return;
    try {
      const nextIds = new Set(records.map(record => record.id));
      const deleted = Array.isArray(previous) ? previous.map(record => record.id).filter(id => id && !nextIds.has(id)) : [];
      if (deleted.length) await deleteCodes('royalty_imports', deleted);
      if (records.length) await sendBatches('royalty_imports', records);
    }
    catch (error) { console.error('Cheerful royalty import sync failed', error); }
  }

  function startImportPolling() {
    if (pollingStarted) return;
    pollingStarted = true;
    setInterval(syncImportsIfChanged, 2500);
  }

  const originalSaveFinanceData = window.saveFinanceData;
  if (typeof originalSaveFinanceData === 'function') {
    window.saveFinanceData = function () {
      const result = originalSaveFinanceData.apply(this, arguments);
      queueFinanceSync();
      return result;
    };
  }

  async function onSession(user) {
    activeUser = user || null;
    if (!activeUser) return;
    startImportPolling();
    try { await hydrate(); }
    catch (error) { console.error('Cheerful Supabase hydration failed', error); }
  }

  document.addEventListener('cheerful:session', event => onSession(event.detail));
  if (window.cheerfulCurrentUser) onSession(window.cheerfulCurrentUser);

  window.CheerfulSupabase = {
    hydrate,
    syncAll: () => syncFinanceData(true),
    status: () => request('status')
  };
})();
