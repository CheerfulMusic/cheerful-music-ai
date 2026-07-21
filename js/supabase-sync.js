(function () {
  'use strict';

  const BATCH_SIZE = 250;
  let activeUser = null;
  let hydrationPromise = null;

  function can(permission) {
    return Boolean(activeUser && Array.isArray(activeUser.permissions) && activeUser.permissions.includes(permission));
  }

  async function request(resource, options) {
    const response = await fetch(`/api/os-data?resource=${encodeURIComponent(resource)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...((options && options.headers) || {}) },
      ...(options || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || `Supabase request failed (${response.status})`);
    return data;
  }

  function chunks(records) {
    const output = [];
    for (let index = 0; index < records.length; index += BATCH_SIZE) output.push(records.slice(index, index + BATCH_SIZE));
    return output;
  }

  async function sendBatches(resource, records) {
    if (!Array.isArray(records) || !records.length) return [];
    const results = [];
    for (const batch of chunks(records)) {
      results.push(await request(resource, { method: 'POST', body: JSON.stringify({ resource, records: batch }) }));
    }
    return results;
  }

  function legacyRecords(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  async function migrateLegacyRoyaltyMatrixStorage() {
    if (!can('royalty_rules_write')) return;
    const historyKey = 'cm_royalty_matrix_import_history_v133';
    const reviewKey = 'cm_royalty_matrix_review_queue_v133';
    const history = legacyRecords(historyKey);
    const reviews = legacyRecords(reviewKey);
    if (!history.length && !reviews.length) return;
    const batches = new Map(history.map(record => [record.id, {
      id: record.id,
      fileName: record.fileName || 'legacy-browser-import',
      fileSize: Number(record.fileSize || 0),
      total: Number(record.total || 0),
      imported: Number(record.imported || 0),
      updated: Number(record.updated || 0),
      skipped: Number(record.skipped || 0),
      failed: Number(record.failed || 0),
      needsReview: Number(record.needsReview || 0),
      schemaVersion: 'royalty-rule-v1',
      metadata: { migratedFrom: 'browser-storage', originalCreatedAt: record.createdAt || null }
    }]));
    reviews.forEach(record => {
      if (!record.batchId || batches.has(record.batchId)) return;
      batches.set(record.batchId, {
        id: record.batchId,
        fileName: 'legacy-browser-import',
        fileSize: 0,
        total: 1,
        imported: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        needsReview: 1,
        schemaVersion: 'royalty-rule-v1',
        metadata: { migratedFrom: 'browser-storage' }
      });
    });
    if (batches.size) await sendBatches('royalty_rule_imports', [...batches.values()]);
    if (reviews.length) await sendBatches('royalty_rule_reviews', reviews.map((record, index) => ({
      id: record.id || `${record.batchId}-${record.rowNumber || index + 1}`,
      batchId: record.batchId,
      rowNumber: Number(record.rowNumber || index + 1),
      status: 'needs_review',
      reason: record.reason || '从浏览器迁移的待审核记录',
      sourceData: record.sourceData || {},
      recordingId: record.recordingId || '',
      matchMethod: record.matchMethod || ''
    })));
    localStorage.removeItem(historyKey);
    localStorage.removeItem(reviewKey);
  }

  async function deleteCodes(resource, codes) {
    if (!Array.isArray(codes) || !codes.length) return;
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

  function remoteRoyaltyRuleImports(records) {
    return records.map(record => ({
      id: record.batch_no,
      fileName: record.original_filename || '',
      fileSize: Number(record.file_size || 0),
      total: Number(record.total_rows || 0),
      imported: Number(record.imported_rows || 0),
      updated: Number(record.updated_rows || 0),
      skipped: Number(record.skipped_rows || 0),
      failed: Number(record.failed_rows || 0),
      needsReview: Number(record.review_rows || 0),
      status: record.status || 'completed',
      schemaVersion: record.schema_version || '',
      metadata: record.metadata || {},
      createdAt: record.created_at || ''
    })).filter(record => record.id);
  }

  function remoteRoyaltyRuleReviews(records) {
    return records.map(record => ({
      id: record.id,
      reviewKey: record.review_key,
      batchId: record.royalty_rule_imports && record.royalty_rule_imports.batch_no || '',
      fileName: record.royalty_rule_imports && record.royalty_rule_imports.original_filename || '',
      rowNumber: Number(record.source_row_number || 0),
      status: record.status || 'needs_review',
      reason: record.reason || '',
      sourceData: record.source_data || {},
      recordingId: record.recordings && record.recordings.recording_id || '',
      matchMethod: record.match_method || '',
      resolutionAction: record.resolution_action || '',
      resolutionNotes: record.resolution_notes || '',
      resolvedAt: record.resolved_at || '',
      createdAt: record.created_at || ''
    })).filter(record => record.id && record.batchId);
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
      rows: record.metadata && record.metadata.preview || [],
      checksum: record.metadata && record.metadata.checksum || '',
      fileBytes: Number(record.metadata && record.metadata.fileBytes || 0)
    })).filter(record => record.id);
  }

  function remoteMatches(records) {
    return records.map(record => {
      const raw = record.raw_data || {};
      return {
        id: `${record.royalty_imports && record.royalty_imports.batch_no || 'batch'}-${Math.max(0, Number(record.source_row_number || 1) - 1)}`,
        batchId: record.royalty_imports && record.royalty_imports.batch_no || '',
        rowIndex: Math.max(0, Number(record.source_row_number || 1) - 1),
        rawData: raw,
        title: raw.title || '', artist: raw.artist || '', isrc: raw.isrc || '', country: raw.country || '',
        period: raw.period || '', quantity: Number(raw.quantity || 0),
        revenue: Number(record.net_amount == null ? record.gross_amount || 0 : record.net_amount),
        currency: record.currency || '',
        recordingId: record.recordings && record.recordings.recording_id || '',
        confidence: Math.round(Number(record.confidence || 0) * 100),
        reason: record.match_method || record.error_reason || '',
        manual: String(record.match_method || '').includes('人工')
      };
    }).filter(record => record.batchId);
  }

  function remoteCalculations(records) {
    const mapped = records.map(record => ({
      id: record.id,
      runId: record.royalty_calculation_runs && record.royalty_calculation_runs.id || '',
      runNo: record.royalty_calculation_runs && record.royalty_calculation_runs.run_no || '',
      runStatus: record.royalty_calculation_runs && record.royalty_calculation_runs.status || '',
      batchId: record.royalty_calculation_runs && record.royalty_calculation_runs.royalty_imports && record.royalty_calculation_runs.royalty_imports.batch_no || '',
      rowIndex: Math.max(0, Number(record.royalty_import_rows && record.royalty_import_rows.source_row_number || 1) - 1),
      sourceData: record.royalty_import_rows && record.royalty_import_rows.raw_data || {},
      recordingId: record.recordings && record.recordings.recording_id || '',
      payee: record.payee_name || '',
      royaltyType: record.royalty_type || '',
      percentage: Number(record.share_percentage || 0),
      basis: record.calculation_basis || '',
      contractNo: record.royalty_rules && record.royalty_rules.contract_no || '',
      ruleCode: record.royalty_rules && record.royalty_rules.rule_code || '',
      revenue: Number(record.source_amount || 0),
      eligibleAmount: Number(record.eligible_amount || 0),
      royaltyAmount: Number(record.royalty_amount || 0),
      currency: record.currency || '',
      status: record.status || 'review',
      trace: record.calculation_trace || {},
      createdAt: record.created_at || ''
    })).filter(record => record.id && record.batchId && record.runStatus !== 'superseded');
    const latestRunByBatch = new Map();
    mapped.forEach(record => { if (!latestRunByBatch.has(record.batchId)) latestRunByBatch.set(record.batchId, record.runId); });
    return mapped.filter(record => latestRunByBatch.get(record.batchId) === record.runId);
  }

  function remoteExceptions(records) {
    const riskLabels = { high: '高风险', medium: '中风险', low: '低风险' };
    const mapped = records.map(record => ({
      id: record.id,
      key: record.exception_key,
      batchId: record.royalty_imports && record.royalty_imports.batch_no || '',
      runNo: record.royalty_calculation_runs && record.royalty_calculation_runs.run_no || '',
      type: record.exception_type || '',
      risk: riskLabels[record.risk_level] || record.risk_level || '中风险',
      subject: record.subject || '',
      description: record.description || '',
      suggestion: record.suggestion || '',
      status: record.status || 'open',
      resolved: ['resolved', 'dismissed'].includes(record.status),
      resolutionNotes: record.resolution_notes || '',
      resolvedAt: record.resolved_at || '',
      metadata: record.metadata || {},
      createdAt: record.created_at || '',
      updatedAt: record.updated_at || ''
    })).filter(record => record.id && record.batchId);
    const latestRunByBatch = new Map();
    mapped.forEach(record => { if (record.runNo && !latestRunByBatch.has(record.batchId)) latestRunByBatch.set(record.batchId, record.runNo); });
    return mapped.filter(record => !record.runNo || latestRunByBatch.get(record.batchId) === record.runNo);
  }

  function rerenderFinance() {
    if (typeof current !== 'undefined' && current === 'finance' && typeof openSection === 'function') openSection('finance');
  }

  async function refreshCatalog() {
    if (!can('song_library_read')) return [];
    const result = await request('catalog');
    financeRecordings = remoteCatalog(result.data || []);
    financeDataLoading = false;
    rerenderFinance();
    return financeRecordings;
  }

  async function refreshRules() {
    if (!can('royalty_rules_read')) return [];
    const result = await request('royalty_rules');
    financeRules = remoteRules(result.data || []);
    financeDataLoading = false;
    rerenderFinance();
    return financeRules;
  }

  async function refreshRoyaltyRuleImports() {
    if (!can('royalty_rules_read')) return [];
    const result = await request('royalty_rule_imports');
    const records = remoteRoyaltyRuleImports(result.data || []);
    if (window.CheerfulRoyaltyMatrixStore) window.CheerfulRoyaltyMatrixStore.replaceHistory(records);
    rerenderFinance();
    return records;
  }

  async function refreshRoyaltyRuleReviews() {
    if (!can('royalty_rules_read')) return [];
    const result = await request('royalty_rule_reviews');
    const records = remoteRoyaltyRuleReviews(result.data || []);
    if (window.CheerfulRoyaltyMatrixStore) window.CheerfulRoyaltyMatrixStore.replaceReviews(records);
    rerenderFinance();
    return records;
  }

  async function refreshImports() {
    if (!can('platform_royalty_read')) return [];
    const result = await request('royalty_imports');
    const records = remoteImports(result.data || []);
    if (window.CheerfulFinanceImports) window.CheerfulFinanceImports.replace(records);
    rerenderFinance();
    return records;
  }

  async function refreshMatches() {
    if (!can('song_matching_read')) return [];
    const result = await request('matching_queue');
    const records = remoteMatches(result.data || []);
    if (window.CheerfulFinanceWorkflow) window.CheerfulFinanceWorkflow.replaceMatches(records);
    rerenderFinance();
    return records;
  }

  async function refreshCalculations() {
    if (!can('royalty_calculation')) return [];
    const result = await request('calculations');
    const records = remoteCalculations(result.data || []);
    if (window.CheerfulFinanceWorkflow) window.CheerfulFinanceWorkflow.replaceCalculations(records);
    rerenderFinance();
    return records;
  }

  async function refreshExceptions() {
    if (!can('royalty_calculation')) return [];
    const result = await request('exceptions');
    const records = remoteExceptions(result.data || []);
    if (window.CheerfulFinanceWorkflow) window.CheerfulFinanceWorkflow.replaceExceptions(records);
    rerenderFinance();
    return records;
  }

  async function hydrate() {
    if (!activeUser) return;
    if (hydrationPromise) return hydrationPromise;
    hydrationPromise = (async () => {
      const status = await request('status');
      if (!status.connected) throw new Error('Supabase 尚未连接');
      financeDataLoading = true;
      rerenderFinance();
      await migrateLegacyRoyaltyMatrixStorage();
      const tasks = [];
      if (can('song_library_read')) tasks.push(refreshCatalog()); else financeRecordings = [];
      if (can('royalty_rules_read')) tasks.push(refreshRules(), refreshRoyaltyRuleImports(), refreshRoyaltyRuleReviews()); else financeRules = [];
      if (can('platform_royalty_read')) tasks.push(refreshImports());
      if (can('song_matching_read')) tasks.push(refreshMatches());
      if (can('royalty_calculation')) tasks.push(refreshCalculations(), refreshExceptions());
      await Promise.all(tasks);
      financeDataLoading = false;
      ['cm_finance_recordings', 'cm_finance_rules', 'cm_finance_imports_v131', 'cm_finance_preview_v131', 'cm_finance_matches_v140', 'cm_finance_calculations_v140', 'cm_finance_exception_reviews_v140', 'cm_royalty_matrix_import_history_v133', 'cm_royalty_matrix_review_queue_v133'].forEach(key => localStorage.removeItem(key));
      rerenderFinance();
    })().finally(() => { hydrationPromise = null; });
    return hydrationPromise;
  }

  async function onSession(user) {
    activeUser = user || null;
    if (!activeUser) {
      financeRecordings = [];
      financeRules = [];
      financeDataLoading = true;
      return;
    }
    try { await hydrate(); }
    catch (error) {
      financeDataLoading = false;
      console.error('Cheerful Supabase hydration failed', error);
      if (typeof showToastMessage === 'function') showToastMessage(`Supabase 读取失败：${error.message}`);
    }
  }

  document.addEventListener('cheerful:session', event => onSession(event.detail));
  if (window.cheerfulCurrentUser) onSession(window.cheerfulCurrentUser);

  window.CheerfulSupabase = {
    hydrate,
    status: () => request('status'),
    refreshCatalog,
    refreshRules,
    refreshRoyaltyRuleImports,
    refreshRoyaltyRuleReviews,
    refreshImports,
    refreshMatches,
    refreshCalculations,
    refreshExceptions,
    saveCatalog: records => sendBatches('catalog', records),
    saveRules: records => sendBatches('royalty_rules', records),
    saveRoyaltyRuleImports: records => sendBatches('royalty_rule_imports', records),
    saveRoyaltyRuleReviews: records => sendBatches('royalty_rule_reviews', records),
    saveImports: records => sendBatches('royalty_imports', records),
    saveImportRows: records => sendBatches('import_rows', records),
    saveMatches: records => sendBatches('matching_queue', records),
    runCalculation: batchId => request('calculations', { method: 'POST', body: JSON.stringify({ resource: 'calculations', batchId }) }),
    resolveException: (id, status, notes) => request('exceptions', { method: 'PATCH', body: JSON.stringify({ resource: 'exceptions', id, status, notes: notes || '' }) }),
    deleteCatalog: codes => deleteCodes('catalog', codes),
    deleteRules: codes => deleteCodes('royalty_rules', codes),
    deleteImports: codes => deleteCodes('royalty_imports', codes),
    request
  };
})();
