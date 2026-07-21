const crypto = require('crypto');
const { isAllowedOrigin, requireSession } = require('./_gpt-auth');
const { serviceRequest, supabaseConfig } = require('./_supabase');
const { writeAudit } = require('./_gpt-store');

const MAX_BATCH = 500;
const ROLES = new Set(['ceo', 'finance', 'ar', 'hr', 'marketing', 'legal', 'copyright', 'distribution', 'admin', 'member', 'viewer']);

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(payload));
}

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function number(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeRawData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = Object.create(null);
  Object.entries(value).slice(0, 200).forEach(([rawKey, rawValue]) => {
    const key = text(rawKey, 200);
    if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) return;
    if (rawValue == null || typeof rawValue === 'number' || typeof rawValue === 'boolean') output[key] = rawValue;
    else if (typeof rawValue === 'string') output[key] = rawValue.slice(0, 10000);
    else {
      try { output[key] = JSON.parse(JSON.stringify(rawValue).slice(0, 10000)); }
      catch (_) { output[key] = text(rawValue, 10000); }
    }
  });
  return output;
}

function date(value) {
  const normalized = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function uuidOrNull(value) {
  const normalized = text(value, 40);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized) ? normalized : null;
}

function normalizeStatus(value) {
  const candidate = text(value, 30).toLowerCase();
  const map = { '已发行': 'released', '未发行': 'unreleased', '下架': 'takedown', '归档': 'archived' };
  const normalized = map[candidate] || candidate;
  return ['released', 'unreleased', 'takedown', 'archived'].includes(normalized) ? normalized : 'released';
}

function fallbackWorkId(record) {
  const title = text(record.workTitle || record.songTitle || record.title, 500).toLowerCase();
  const identity = title
    ? [record.iswc, title, record.copyrightOwner || record.label]
    : [record.iswc, record.id, record.isrc, record.artist];
  const normalizedIdentity = identity.map(value => text(value, 500).toLowerCase()).join('|');
  return `LEGACY-W-${crypto.createHash('sha1').update(normalizedIdentity).digest('hex').slice(0, 16).toUpperCase()}`;
}

function requireConfigured(res) {
  const config = supabaseConfig();
  if (!config.databaseConfigured) {
    json(res, 503, { error: 'Supabase 尚未连接到 Vercel。', code: 'SUPABASE_NOT_CONFIGURED' });
    return null;
  }
  return config;
}

function requirePermission(req, res, permission) {
  return requireSession(req, res, permission);
}

async function upsert(table, conflict, records) {
  if (!records.length) return [];
  const result = await serviceRequest(`${table}?on_conflict=${encodeURIComponent(conflict)}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(records)
  });
  return Array.isArray(result.data) ? result.data : [];
}

async function readAll(path, options = {}) {
  const pageSize = Math.max(1, Math.min(1000, number(options.pageSize, 1000)));
  const maxRows = Math.max(pageSize, Math.min(100000, number(options.maxRows, 100000)));
  const rows = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const result = await serviceRequest(`${path}${separator}limit=${pageSize}&offset=${offset}`);
    const page = Array.isArray(result.data) ? result.data : [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function inFilter(values) {
  const quoted = values.map(value => `"${String(value).replace(/"/g, '')}"`).join(',');
  return encodeURIComponent(`(${quoted})`);
}

async function syncCatalog(records, user) {
  const input = records.slice(0, MAX_BATCH);
  const createdBy = uuidOrNull(user.sub);
  const songsByWorkId = new Map();
  input.forEach(record => {
    const workId = text(record.workId || record.work_id, 120) || fallbackWorkId(record);
    if (!songsByWorkId.has(workId)) {
      const alternatives = Array.isArray(record.alternativeTitles) ? record.alternativeTitles : text(record.alternativeTitle, 1000).split(/[|;；]/);
      songsByWorkId.set(workId, {
        work_id: workId,
        title: text(record.workTitle || record.songTitle || record.title, 500) || '未命名作品',
        alternative_titles: alternatives.map(value => text(value, 300)).filter(Boolean),
        iswc: text(record.iswc, 100) || null,
        language: text(record.language, 80) || null,
        label: text(record.label, 300) || null,
        copyright_owner: text(record.copyrightOwner, 500) || null,
        status: normalizeStatus(record.status),
        notes: text(record.notes, 4000) || null,
        ...(createdBy ? { created_by: createdBy } : {})
      });
    }
  });

  const songs = await upsert('songs', 'work_id', [...songsByWorkId.values()]);
  const songIdByWork = new Map(songs.map(song => [song.work_id, song.id]));
  const recordingRows = input.map(record => {
    const workId = text(record.workId || record.work_id, 120) || fallbackWorkId(record);
    return {
      recording_id: text(record.id || record.recordingId || record.recording_id, 120),
      song_id: songIdByWork.get(workId),
      isrc: text(record.isrc, 100) || null,
      version_name: text(record.versionName, 300) || '原版',
      version_type: text(record.versionType, 100) || 'Original',
      artist_name: text(record.artist || record.artistName, 500) || '未知艺人',
      upc: text(record.upc, 100) || null,
      release_date: date(record.releaseDate),
      label: text(record.label, 300) || null,
      recording_owner: text(record.recordingOwner, 500) || null,
      status: normalizeStatus(record.status),
      notes: text(record.notes, 4000) || null,
      ...(createdBy ? { created_by: createdBy } : {})
    };
  }).filter(record => record.recording_id && record.song_id);

  const recordings = await upsert('recordings', 'recording_id', recordingRows);
  return { received: input.length, songs: songs.length, recordings: recordings.length };
}

async function syncRoyaltyRules(records, user) {
  const input = records.slice(0, MAX_BATCH);
  const recordingCodes = [...new Set(input.map(record => text(record.recordingId || record.recording_id, 120)).filter(Boolean))];
  let recordingRows = [];
  if (recordingCodes.length) {
    const result = await serviceRequest(`recordings?recording_id=in.${inFilter(recordingCodes)}&select=id,recording_id,song_id`);
    recordingRows = Array.isArray(result.data) ? result.data : [];
  }
  const recordingByCode = new Map(recordingRows.map(record => [record.recording_id, record]));
  const createdBy = uuidOrNull(user.sub);
  const allowedRoles = new Set(['Artist', 'Featured Artist', 'Lyricist', 'Composer', 'Producer', 'Publisher', 'Label', 'Recording Owner', 'Copyright Owner', 'Other']);
  const allowedTypes = new Set(['Recording Royalty', 'Publishing Royalty', 'Artist Royalty', 'Producer Royalty', 'Platform Revenue Share', 'Other']);
  const failed = [];
  const rows = [];

  input.forEach((record, index) => {
    const recordingCode = text(record.recordingId || record.recording_id, 120);
    const recording = recordingByCode.get(recordingCode);
    const percentage = number(record.percentage == null ? record.sharePercentage : record.percentage);
    if (!recording || percentage == null || percentage < 0 || percentage > 100) {
      failed.push({ index, ruleCode: text(record.id || record.ruleCode, 120), reason: !recording ? '录音版本未匹配' : '分成比例无效' });
      return;
    }
    const role = text(record.role, 80) || 'Artist';
    const royaltyType = text(record.royaltyType, 100) || 'Artist Royalty';
    rows.push({
      rule_code: text(record.id || record.ruleCode, 120) || `CM-RULE-${crypto.randomUUID()}`,
      song_id: recording.song_id,
      recording_id: recording.id,
      artist_name: text(record.artistName, 500) || null,
      payee_name: text(record.payee || record.payeeName, 500) || '未指定收款方',
      role: allowedRoles.has(role) ? role : 'Other',
      royalty_type: allowedTypes.has(royaltyType) ? royaltyType : 'Other',
      share_percentage: percentage,
      calculation_basis: text(record.basis || record.calculationBasis, 120) || 'Net Receipts',
      effective_date: date(record.startDate || record.effectiveDate) || '1900-01-01',
      end_date: date(record.endDate),
      territory: text(record.territory, 200) || 'Worldwide',
      platform: text(record.platform, 200) || 'All',
      currency: text(record.currency, 20) || null,
      contract_no: text(record.contractNo, 200) || null,
      notes: text(record.notes, 4000) || null,
      ...(createdBy ? { created_by: createdBy } : {})
    });
  });

  const saved = await upsert('royalty_rules', 'rule_code', rows);
  return { received: input.length, saved: saved.length, failed };
}

async function syncImports(records, user) {
  const uploadedBy = uuidOrNull(user.sub);
  for (const record of records.slice(0, MAX_BATCH)) {
    const checksum = text(record.checksum, 128).toLowerCase();
    if (!checksum) continue;
    const duplicate = await serviceRequest(`royalty_imports?metadata->>checksum=eq.${encodeURIComponent(checksum)}&batch_no=neq.${encodeURIComponent(text(record.id || record.batchNo, 120))}&select=batch_no&limit=1`);
    if (Array.isArray(duplicate.data) && duplicate.data.length) {
      throw Object.assign(new Error(`相同平台文件已存在于批次 ${duplicate.data[0].batch_no}。`), { statusCode: 409 });
    }
  }
  const rows = records.slice(0, MAX_BATCH).map(record => ({
    batch_no: text(record.id || record.batchNo, 120),
    platform: text(record.platform, 200) || 'unknown',
    period_start: date(record.periodStart),
    period_end: date(record.periodEnd),
    original_filename: text(record.fileName || record.originalFilename, 500) || 'unknown-file',
    currency: text(record.currency, 30) || null,
    status: 'ready',
    total_rows: Math.max(0, number(record.rowCount, 0)),
    imported_rows: Math.max(0, number(record.importedRows, record.rowCount || 0)),
    failed_rows: Math.max(0, number(record.failedRows, 0)),
    review_rows: Math.max(0, number(record.reviewRows, 0)),
    total_amount: number(record.revenue),
    metadata: {
      period: text(record.period, 200),
      songCount: Math.max(0, number(record.songCount, 0)),
      checksum: text(record.checksum, 128).toLowerCase() || null,
      fileBytes: Math.max(0, number(record.fileBytes, 0)),
      headers: Array.isArray(record.headers) ? record.headers.slice(0, 100) : [],
      mapping: record.mapping && typeof record.mapping === 'object' ? record.mapping : {},
      preview: Array.isArray(record.rows) ? record.rows.slice(0, 20) : []
    },
    ...(uploadedBy ? { uploaded_by: uploadedBy } : {})
  })).filter(record => record.batch_no);
  const saved = await upsert('royalty_imports', 'batch_no', rows);
  return { received: records.length, saved: saved.length };
}

async function syncMatchingQueue(records) {
  const input = records.slice(0, MAX_BATCH);
  const batchCodes = [...new Set(input.map(record => text(record.batchId || record.batch_no, 120)).filter(Boolean))];
  const recordingCodes = [...new Set(input.map(record => text(record.recordingId || record.recording_id, 120)).filter(Boolean))];
  const [importResult, recordingResult] = await Promise.all([
    batchCodes.length ? serviceRequest(`royalty_imports?batch_no=in.${inFilter(batchCodes)}&select=id,batch_no,platform`) : { data: [] },
    recordingCodes.length ? serviceRequest(`recordings?recording_id=in.${inFilter(recordingCodes)}&select=id,recording_id,song_id`) : { data: [] }
  ]);
  const imports = new Map((Array.isArray(importResult.data) ? importResult.data : []).map(row => [row.batch_no, row]));
  const recordings = new Map((Array.isArray(recordingResult.data) ? recordingResult.data : []).map(row => [row.recording_id, row]));
  const failed = [];
  const rows = [];
  input.forEach((record, index) => {
    const batchCode = text(record.batchId || record.batch_no, 120);
    const batch = imports.get(batchCode);
    if (!batch) {
      failed.push({ index, reason: '导入批次不存在', batchCode });
      return;
    }
    const recordingCode = text(record.recordingId || record.recording_id, 120);
    const recording = recordings.get(recordingCode);
    const confidenceRaw = number(record.confidence, 0);
    const confidence = Math.max(0, Math.min(1, confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw));
    const raw = safeRawData(record.rawData);
    rows.push({
      import_id: batch.id,
      source_row_number: Math.max(1, number(record.rowIndex, index) + 1),
      raw_data: {
        ...raw,
        title: text(record.title, 500), artist: text(record.artist, 500), isrc: text(record.isrc, 100),
        country: text(record.country, 100), period: text(record.period, 100), quantity: number(record.quantity, 0)
      },
      song_id: recording && recording.song_id || null,
      recording_id: recording && recording.id || null,
      match_status: recording ? (confidence >= 0.75 ? 'matched' : 'review') : 'unmatched',
      match_method: text(record.reason, 500) || null,
      confidence,
      platform: text(record.platform, 200) || batch.platform || null,
      territory: text(record.country || record.territory, 100) || null,
      currency: text(record.currency, 30) || null,
      error_reason: recording ? null : '未匹配到录音版本'
    });
  });
  const saved = await upsert('royalty_import_rows', 'import_id,source_row_number', rows);
  return { received: input.length, saved: saved.length, failed };
}

async function syncImportRows(records) {
  const input = records.slice(0, MAX_BATCH);
  const batchCodes = [...new Set(input.map(record => text(record.batchId || record.batch_no, 120)).filter(Boolean))];
  const importResult = batchCodes.length
    ? await serviceRequest(`royalty_imports?batch_no=in.${inFilter(batchCodes)}&select=id,batch_no,platform`)
    : { data: [] };
  const imports = new Map((Array.isArray(importResult.data) ? importResult.data : []).map(row => [row.batch_no, row]));
  const failed = [];
  const rows = [];
  input.forEach((record, index) => {
    const batchCode = text(record.batchId || record.batch_no, 120);
    const batch = imports.get(batchCode);
    if (!batch) {
      failed.push({ index, batchCode, reason: '导入批次不存在' });
      return;
    }
    const raw = safeRawData(record.rawData);
    rows.push({
      import_id: batch.id,
      source_row_number: Math.max(1, number(record.rowIndex, index) + 1),
      raw_data: {
        ...raw,
        title: text(record.title || raw.title, 500),
        artist: text(record.artist || raw.artist, 500),
        isrc: text(record.isrc || raw.isrc, 100),
        country: text(record.country || raw.country, 100),
        period: text(record.period || raw.period, 100),
        quantity: number(record.quantity == null ? raw.quantity : record.quantity, 0)
      },
      match_status: 'pending',
      match_method: null,
      confidence: 0,
      platform: text(record.platform, 200) || batch.platform || null,
      territory: text(record.country || record.territory, 100) || null,
      usage_date: date(record.usageDate),
      currency: text(record.currency, 30) || null,
      gross_amount: number(record.grossAmount == null ? record.revenue : record.grossAmount, 0),
      fees: number(record.fees, 0),
      tax_amount: number(record.taxAmount, 0),
      net_amount: number(record.netAmount == null ? record.revenue : record.netAmount, 0),
      error_reason: null
    });
  });
  const saved = await upsert('royalty_import_rows', 'import_id,source_row_number', rows);
  return { received: input.length, saved: saved.length, failed };
}

function calculationDate(row, batch) {
  if (row.usage_date) return row.usage_date;
  const rawPeriod = text(row.raw_data && row.raw_data.period, 100);
  const quarter = rawPeriod.match(/(20\d{2})\D*Q([1-4])/i);
  if (quarter) return `${quarter[1]}-${String((Number(quarter[2]) - 1) * 3 + 1).padStart(2, '0')}-01`;
  const month = rawPeriod.match(/(20\d{2})\D(0?[1-9]|1[0-2])/);
  if (month) return `${month[1]}-${String(Number(month[2])).padStart(2, '0')}-01`;
  return batch.period_start || batch.period_end || null;
}

function ruleApplies(rule, row, batch, effectiveDate) {
  if (rule.effective_date && rule.effective_date > effectiveDate) return false;
  if (rule.end_date && rule.end_date < effectiveDate) return false;
  const platform = text(row.platform || batch.platform, 200).toLowerCase();
  const rulePlatform = text(rule.platform, 200).toLowerCase();
  if (rulePlatform && !['all', 'all platforms', '全平台'].includes(rulePlatform) && rulePlatform !== platform) return false;
  const territory = text(row.territory, 100).toLowerCase();
  const ruleTerritory = text(rule.territory, 100).toLowerCase();
  if (ruleTerritory && !['worldwide', 'global', '全球', 'all'].includes(ruleTerritory)) {
    if (!territory || ruleTerritory !== territory) return false;
  }
  return true;
}

function exceptionRow({ key, batch, row, runId, type, risk, subject, description, suggestion, lineId = null, metadata = {} }) {
  return {
    exception_key: key,
    import_id: batch.id,
    import_row_id: row && row.id || null,
    calculation_run_id: runId || null,
    calculation_line_id: lineId,
    exception_type: type,
    risk_level: risk,
    subject: text(subject, 500) || '未命名异常',
    description: text(description, 4000),
    suggestion: text(suggestion, 4000) || null,
    status: 'open',
    metadata
  };
}

async function runRoyaltyCalculation(batchCode, user) {
  const importResult = await serviceRequest(`royalty_imports?batch_no=eq.${encodeURIComponent(batchCode)}&select=id,batch_no,platform,period_start,period_end,currency,total_rows&limit=1`);
  const batch = Array.isArray(importResult.data) ? importResult.data[0] : null;
  if (!batch) throw Object.assign(new Error('导入批次不存在'), { statusCode: 404 });
  const sourceRows = await readAll(`royalty_import_rows?import_id=eq.${encodeURIComponent(batch.id)}&select=id,source_row_number,raw_data,recording_id,match_status,match_method,confidence,platform,territory,usage_date,currency,gross_amount,fees,tax_amount,net_amount,recordings(recording_id)&order=source_row_number.asc`);
  if (!sourceRows.length) throw Object.assign(new Error('该批次尚未保存任何平台收入明细'), { statusCode: 400 });
  const recordingIds = [...new Set(sourceRows.map(row => row.recording_id).filter(Boolean))];
  const recordingSet = new Set(recordingIds);
  const rules = recordingIds.length
    ? (await readAll('royalty_rules?status=eq.active&select=id,rule_code,recording_id,payee_id,payee_name,royalty_type,share_percentage,calculation_basis,effective_date,end_date,territory,platform,currency,contract_no')).filter(rule => recordingSet.has(rule.recording_id))
    : [];
  const byRecording = new Map();
  rules.forEach(rule => {
    if (!byRecording.has(rule.recording_id)) byRecording.set(rule.recording_id, []);
    byRecording.get(rule.recording_id).push(rule);
  });
  const runNo = `CM-CALC-${batch.batch_no}-${Date.now()}`.slice(0, 180);
  const runResult = await serviceRequest('royalty_calculation_runs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      run_no: runNo,
      import_id: batch.id,
      status: 'processing',
      base_currency: batch.currency || null,
      input_rows: sourceRows.length,
      created_by: uuidOrNull(user.sub),
      rules_snapshot: rules.map(rule => ({
        rule_code: rule.rule_code,
        recording_id: rule.recording_id,
        payee_name: rule.payee_name,
        share_percentage: rule.share_percentage,
        calculation_basis: rule.calculation_basis,
        effective_date: rule.effective_date,
        end_date: rule.end_date,
        territory: rule.territory,
        platform: rule.platform,
        currency: rule.currency
      }))
    })
  });
  const run = Array.isArray(runResult.data) ? runResult.data[0] : null;
  if (!run) throw new Error('无法创建版税计算批次');
  const lines = [];
  const exceptions = [];
  const duplicateFingerprints = new Map();
  try {
    sourceRows.forEach(row => {
      const raw = row.raw_data || {};
      const title = text(raw.title, 500) || `第 ${row.source_row_number} 行`;
      const sourceAmount = number(row.net_amount == null ? row.gross_amount : row.net_amount, 0);
      const keyBase = `${run.id}:${row.id}`;
      if (!row.recording_id || !['matched', 'review'].includes(row.match_status)) {
        exceptions.push(exceptionRow({ key: `${keyBase}:unmatched`, batch, row, runId: run.id, type: '无法匹配歌曲', risk: 'high', subject: title, description: '平台收入尚未对应到内部录音版本。', suggestion: '检查 ISRC、艺人和版本后进行人工匹配。' }));
        return;
      }
      const confidence = number(row.confidence, 0);
      if (confidence < 0.75) exceptions.push(exceptionRow({ key: `${keyBase}:confidence`, batch, row, runId: run.id, type: '低置信度匹配', risk: 'medium', subject: title, description: `当前匹配置信度为 ${Math.round(confidence * 100)}%。`, suggestion: '财务确认建议录音版本。' }));
      if (!row.currency) exceptions.push(exceptionRow({ key: `${keyBase}:currency`, batch, row, runId: run.id, type: '币种缺失', risk: 'medium', subject: title, description: '平台报表没有可用币种。', suggestion: '确认币种后重新计算。' }));
      if (sourceAmount < 0) exceptions.push(exceptionRow({ key: `${keyBase}:negative`, batch, row, runId: run.id, type: '负数版税', risk: 'medium', subject: title, description: `平台收入为 ${sourceAmount}。`, suggestion: '确认是否为退款、冲销或平台调整。' }));
      const effectiveDate = calculationDate(row, batch);
      if (!effectiveDate) {
        exceptions.push(exceptionRow({ key: `${keyBase}:period`, batch, row, runId: run.id, type: '收入期间缺失', risk: 'high', subject: title, description: '平台明细和导入批次均没有可用于选择合同版本的收入日期。', suggestion: '补充收入发生日期或结算期间后重新计算。' }));
        return;
      }
      const duplicateIdentity = text(raw.isrc, 100).toUpperCase() || String(row.recording_id || '');
      const fingerprint = duplicateIdentity ? [duplicateIdentity, text(row.territory, 100), sourceAmount, effectiveDate].join('|') : '';
      if (fingerprint && duplicateFingerprints.has(fingerprint)) exceptions.push(exceptionRow({ key: `${keyBase}:duplicate`, batch, row, runId: run.id, type: '疑似重复收入', risk: 'high', subject: title, description: '同一录音、地区、金额和期间出现多次。', suggestion: '核对平台原始报表，避免重复计算。' }));
      else if (fingerprint) duplicateFingerprints.set(fingerprint, row.id);
      const activeRules = (byRecording.get(row.recording_id) || []).filter(rule => ruleApplies(rule, row, batch, effectiveDate));
      if (!activeRules.length) {
        exceptions.push(exceptionRow({ key: `${keyBase}:rules`, batch, row, runId: run.id, type: '缺少有效分成规则', risk: 'high', subject: title, description: `收入日期 ${effectiveDate} 没有匹配到有效版税规则。`, suggestion: '在版税规则页面补充有效期、平台和地区规则。' }));
        return;
      }
      const totalShare = activeRules.reduce((sum, rule) => sum + number(rule.share_percentage, 0), 0);
      if (totalShare > 100) exceptions.push(exceptionRow({ key: `${keyBase}:share`, batch, row, runId: run.id, type: '分成比例超过100%', risk: 'high', subject: title, description: `有效规则合计 ${totalShare}%。`, suggestion: '检查重叠合同和重复权利人规则。' }));
      activeRules.forEach(rule => {
        const basisName = text(rule.calculation_basis, 120) || 'Net Receipts';
        const isGross = /gross|毛收入/i.test(basisName);
        const requiresRecoupment = /recoup|回收/i.test(basisName);
        const basisAmount = number(isGross ? row.gross_amount : row.net_amount, 0);
        const percentage = number(rule.share_percentage, 0);
        const royaltyAmount = Number((basisAmount * percentage / 100).toFixed(6));
        lines.push({
          run_id: run.id,
          import_row_id: row.id,
          rule_id: rule.id,
          recording_id: row.recording_id,
          payee_id: rule.payee_id,
          payee_name: rule.payee_name,
          royalty_type: rule.royalty_type,
          calculation_basis: basisName,
          share_percentage: percentage,
          source_amount: sourceAmount,
          eligible_amount: basisAmount,
          royalty_amount: royaltyAmount,
          currency: row.currency || rule.currency || batch.currency || null,
          status: requiresRecoupment || totalShare > 100 || confidence < 0.75 ? 'review' : 'calculated',
          calculation_trace: { formula: 'eligible_amount * share_percentage / 100', effective_date: effectiveDate, contract_no: rule.contract_no, match_method: row.match_method }
        });
        if (requiresRecoupment) exceptions.push(exceptionRow({ key: `${keyBase}:${rule.id}:recoupment`, batch, row, runId: run.id, type: '成本回收待确认', risk: 'medium', subject: rule.payee_name, description: `${rule.contract_no || rule.rule_code} 采用“${basisName}”，需要成本回收台账确认。`, suggestion: '核对未回收余额后确认应付金额。' }));
      });
    });
    for (let index = 0; index < lines.length; index += MAX_BATCH) {
      await serviceRequest('royalty_calculation_lines', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(lines.slice(index, index + MAX_BATCH)) });
    }
    for (let index = 0; index < exceptions.length; index += MAX_BATCH) {
      await upsert('finance_exceptions', 'exception_key', exceptions.slice(index, index + MAX_BATCH));
    }
    const totalsByCurrency = {};
    sourceRows.forEach(row => {
      const currency = text(row.currency || batch.currency, 30) || 'UNKNOWN';
      if (!totalsByCurrency[currency]) totalsByCurrency[currency] = { source: 0, royalty: 0 };
      totalsByCurrency[currency].source += number(row.net_amount == null ? row.gross_amount : row.net_amount, 0);
    });
    lines.forEach(line => {
      const currency = text(line.currency, 30) || 'UNKNOWN';
      if (!totalsByCurrency[currency]) totalsByCurrency[currency] = { source: 0, royalty: 0 };
      totalsByCurrency[currency].royalty += number(line.royalty_amount, 0);
    });
    Object.values(totalsByCurrency).forEach(total => {
      total.source = Number(total.source.toFixed(6));
      total.royalty = Number(total.royalty.toFixed(6));
    });
    const currencyCodes = Object.keys(totalsByCurrency);
    const singleCurrency = currencyCodes.length === 1 ? currencyCodes[0] : null;
    const finalStatus = exceptions.some(item => item.risk_level === 'high') ? 'review' : 'completed';
    const updated = await serviceRequest(`royalty_calculation_runs?id=eq.${encodeURIComponent(run.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        status: finalStatus,
        base_currency: singleCurrency,
        calculated_rows: lines.length,
        exception_rows: exceptions.length,
        total_source_amount: singleCurrency ? totalsByCurrency[singleCurrency].source : 0,
        total_royalty_amount: singleCurrency ? totalsByCurrency[singleCurrency].royalty : 0,
        metadata: { totals_by_currency: totalsByCurrency, mixed_currencies: currencyCodes.length > 1 },
        completed_at: new Date().toISOString()
      })
    });
    await serviceRequest(`royalty_calculation_runs?import_id=eq.${encodeURIComponent(batch.id)}&id=neq.${encodeURIComponent(run.id)}&status=neq.superseded`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'superseded' })
    }).catch(error => console.error(JSON.stringify({ type: 'cheerful_calculation_supersede_error', importId: batch.id, message: error.message })));
    return { run: Array.isArray(updated.data) ? updated.data[0] : run, lines: lines.length, exceptions: exceptions.length };
  } catch (error) {
    await serviceRequest(`royalty_calculation_runs?id=eq.${encodeURIComponent(run.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'failed', completed_at: new Date().toISOString(), metadata: { error: error.message.slice(0, 500) } }) }).catch(() => {});
    throw error;
  }
}

async function latestCalculationRunIds() {
  const runs = await readAll('royalty_calculation_runs?status=neq.superseded&select=id,import_id,created_at&order=created_at.desc', { maxRows: 10000 });
  const latestByImport = new Map();
  runs.forEach(run => {
    if (run.id && run.import_id && !latestByImport.has(run.import_id)) latestByImport.set(run.import_id, run.id);
  });
  return [...latestByImport.values()];
}

async function readResource(resource) {
  if (resource === 'catalog') {
    return readAll('recordings?select=id,recording_id,isrc,version_name,version_type,artist_name,upc,release_date,label,recording_owner,status,notes,songs(id,work_id,title,alternative_titles,iswc,language,label,copyright_owner,status,notes)&order=updated_at.desc');
  }
  if (resource === 'royalty_rules') {
    return readAll('royalty_rules?select=id,rule_code,recording_id,payee_id,artist_name,payee_name,role,royalty_type,share_percentage,calculation_basis,effective_date,end_date,territory,platform,currency,contract_no,status,notes,recordings(recording_id,song_id)&order=updated_at.desc');
  }
  if (resource === 'royalty_imports') {
    return readAll('royalty_imports?select=id,batch_no,platform,period_start,period_end,original_filename,currency,status,total_rows,imported_rows,updated_rows,skipped_rows,failed_rows,review_rows,total_amount,metadata,created_at&order=created_at.desc', { maxRows: 10000 });
  }
  if (resource === 'matching_queue' || resource === 'import_rows') {
    return readAll('royalty_import_rows?select=id,source_row_number,raw_data,match_status,match_method,confidence,platform,territory,usage_date,currency,gross_amount,fees,tax_amount,net_amount,error_reason,created_at,royalty_imports(batch_no),recordings(recording_id)&order=created_at.desc');
  }
  if (resource === 'calculations') {
    const runIds = await latestCalculationRunIds();
    if (!runIds.length) return [];
    return readAll(`royalty_calculation_lines?run_id=in.${inFilter(runIds)}&select=id,payee_name,royalty_type,calculation_basis,share_percentage,source_amount,eligible_amount,royalty_amount,currency,status,calculation_trace,created_at,royalty_calculation_runs(id,run_no,status,created_at,royalty_imports(batch_no)),royalty_import_rows(source_row_number,raw_data),royalty_rules(rule_code,contract_no),recordings(recording_id)&order=created_at.desc`);
  }
  if (resource === 'exceptions') {
    const runIds = await latestCalculationRunIds();
    if (!runIds.length) return [];
    return readAll(`finance_exceptions?calculation_run_id=in.${inFilter(runIds)}&select=id,exception_key,exception_type,risk_level,subject,description,suggestion,status,resolution_notes,resolved_at,metadata,created_at,updated_at,royalty_imports(batch_no),royalty_calculation_runs(run_no)&order=created_at.desc`);
  }
  if (resource === 'users') {
    const result = await serviceRequest('users?select=id,email,display_name,role,department,active,created_at,updated_at&order=display_name.asc&limit=1000');
    return result.data || [];
  }
  throw Object.assign(new Error('Unknown resource'), { statusCode: 404 });
}

async function deleteResource(resource, codes) {
  const safeCodes = codes.slice(0, MAX_BATCH).map(value => text(value, 120)).filter(Boolean);
  if (!safeCodes.length) return { deleted: 0 };
  const configuration = {
    catalog: ['recordings', 'recording_id'],
    royalty_rules: ['royalty_rules', 'rule_code'],
    royalty_imports: ['royalty_imports', 'batch_no']
  }[resource];
  if (!configuration) throw Object.assign(new Error('Delete is not supported for this resource'), { statusCode: 405 });
  let parentSongIds = [];
  if (resource === 'catalog') {
    const parents = await serviceRequest(`recordings?recording_id=in.${inFilter(safeCodes)}&select=song_id`);
    parentSongIds = [...new Set((Array.isArray(parents.data) ? parents.data : []).map(row => row.song_id).filter(Boolean))];
  }
  const result = await serviceRequest(`${configuration[0]}?${configuration[1]}=in.${inFilter(safeCodes)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' }
  });
  if (resource === 'catalog') {
    for (const songId of parentSongIds) {
      const remaining = await serviceRequest(`recordings?song_id=eq.${encodeURIComponent(songId)}&select=id&limit=1`);
      if (!Array.isArray(remaining.data) || !remaining.data.length) {
        await serviceRequest(`songs?id=eq.${encodeURIComponent(songId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      }
    }
  }
  return { deleted: Array.isArray(result.data) ? result.data.length : 0 };
}

const RESOURCE_PERMISSIONS = {
  catalog: ['song_library_read', 'song_library_write'],
  royalty_rules: ['royalty_rules_read', 'royalty_rules_write'],
  royalty_imports: ['platform_royalty_read', 'platform_royalty_write'],
  import_rows: ['platform_royalty_read', 'platform_royalty_write'],
  matching_queue: ['song_matching_read', 'song_matching_write'],
  calculations: ['royalty_calculation', 'royalty_calculation'],
  exceptions: ['royalty_calculation', 'royalty_calculation'],
  users: ['user_admin', 'user_admin']
};

module.exports = async function handler(req, res) {
  if (!isAllowedOrigin(req)) return json(res, 403, { error: '不允许的请求来源。' });
  const resource = text((req.query && req.query.resource) || (req.body && req.body.resource), 80);
  if (resource === 'status') {
    const user = requirePermission(req, res, 'chat');
    if (!user) return;
    const config = supabaseConfig();
    return json(res, 200, { connected: config.databaseConfigured, authConfigured: config.authConfigured, role: user.role });
  }
  const permissions = RESOURCE_PERMISSIONS[resource];
  if (!permissions) return json(res, 404, { error: '未知数据资源。' });
  const permission = req.method === 'GET' ? permissions[0] : permissions[1];
  const user = requirePermission(req, res, permission);
  if (!user) return;
  if (!requireConfigured(res)) return;

  try {
    if (req.method === 'GET') {
      const data = await readResource(resource);
      await writeAudit({ actorId: user.sub, actorName: user.name, actorRole: user.role, action: `data.${resource}.queried`, metadata: { count: Array.isArray(data) ? data.length : 0 } });
      return json(res, 200, { resource, data });
    }
    if (req.method === 'POST') {
      if (resource === 'calculations') {
        const batchCode = text(req.body && (req.body.batchId || req.body.batchNo), 120);
        if (!batchCode) return json(res, 400, { error: '缺少平台版税导入批次编号。' });
        const result = await runRoyaltyCalculation(batchCode, user);
        await writeAudit({ actorId: user.sub, actorName: user.name, actorRole: user.role, action: 'data.calculations.executed', metadata: { batchCode, runNo: result.run && result.run.run_no, lines: result.lines, exceptions: result.exceptions } });
        return json(res, 200, { ok: true, resource, result });
      }
      const records = Array.isArray(req.body && req.body.records) ? req.body.records : [];
      if (!records.length || records.length > MAX_BATCH) return json(res, 400, { error: `每批必须包含 1–${MAX_BATCH} 条记录。` });
      let result;
      if (resource === 'catalog') result = await syncCatalog(records, user);
      else if (resource === 'royalty_rules') result = await syncRoyaltyRules(records, user);
      else if (resource === 'royalty_imports') result = await syncImports(records, user);
      else if (resource === 'import_rows') result = await syncImportRows(records);
      else if (resource === 'matching_queue') result = await syncMatchingQueue(records, user);
      else return json(res, 405, { error: '用户角色请通过专用更新操作管理。' });
      await writeAudit({ actorId: user.sub, actorName: user.name, actorRole: user.role, action: `data.${resource}.synced`, metadata: result });
      return json(res, 200, { ok: true, resource, result });
    }
    if (req.method === 'DELETE' && resource !== 'users') {
      const codes = Array.isArray(req.body && req.body.codes) ? req.body.codes : [];
      if (!codes.length || codes.length > MAX_BATCH) return json(res, 400, { error: `每批必须包含 1–${MAX_BATCH} 个编号。` });
      const result = await deleteResource(resource, codes);
      await writeAudit({ actorId: user.sub, actorName: user.name, actorRole: user.role, action: `data.${resource}.deleted`, metadata: result });
      return json(res, 200, { ok: true, resource, result });
    }
    if (req.method === 'PATCH' && resource === 'users') {
      const id = uuidOrNull(req.body && req.body.id);
      const role = text(req.body && req.body.role, 40);
      if (!id || !ROLES.has(role)) return json(res, 400, { error: '用户 ID 或角色无效。' });
      const changes = {
        role,
        active: req.body.active !== false,
        ...(text(req.body.displayName, 200) ? { display_name: text(req.body.displayName, 200) } : {}),
        ...(text(req.body.department, 100) ? { department: text(req.body.department, 100) } : {})
      };
      const result = await serviceRequest(`users?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(changes)
      });
      await writeAudit({ actorId: user.sub, actorName: user.name, actorRole: user.role, action: 'user.role.updated', metadata: { targetUserId: id, role } });
      return json(res, 200, { ok: true, user: Array.isArray(result.data) ? result.data[0] : null });
    }
    if (req.method === 'PATCH' && resource === 'exceptions') {
      const id = uuidOrNull(req.body && req.body.id);
      const status = text(req.body && req.body.status, 30).toLowerCase();
      if (!id || !['open', 'resolved', 'dismissed', 'reopened'].includes(status)) return json(res, 400, { error: '异常 ID 或状态无效。' });
      const resolved = status === 'resolved' || status === 'dismissed';
      const changes = {
        status,
        resolution_notes: text(req.body && req.body.notes, 4000) || null,
        resolved_by: resolved ? uuidOrNull(user.sub) : null,
        resolved_at: resolved ? new Date().toISOString() : null
      };
      const result = await serviceRequest(`finance_exceptions?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(changes)
      });
      await writeAudit({ actorId: user.sub, actorName: user.name, actorRole: user.role, action: 'data.exceptions.updated', metadata: { id, status } });
      return json(res, 200, { ok: true, exception: Array.isArray(result.data) ? result.data[0] : null });
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error(JSON.stringify({ type: 'cheerful_os_data_error', resource, message: error.message }));
    await writeAudit({ actorId: user.sub, actorName: user.name, actorRole: user.role, action: `data.${resource}.failed`, metadata: { method: req.method, error: error.message.slice(0, 500) } });
    const status = error.statusCode || 500;
    return json(res, status, { error: status < 500 ? text(error.message, 500) : 'Supabase 数据操作失败。' });
  }
};
