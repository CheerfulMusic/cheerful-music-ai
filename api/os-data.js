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
    rows.push({
      import_id: batch.id,
      source_row_number: Math.max(1, number(record.rowIndex, index) + 1),
      raw_data: {
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
      gross_amount: number(record.revenue),
      net_amount: number(record.revenue),
      error_reason: recording ? null : '未匹配到录音版本'
    });
  });
  const saved = await upsert('royalty_import_rows', 'import_id,source_row_number', rows);
  return { received: input.length, saved: saved.length, failed };
}

async function readResource(resource) {
  if (resource === 'catalog') {
    const result = await serviceRequest('recordings?select=id,recording_id,isrc,version_name,version_type,artist_name,upc,release_date,label,recording_owner,status,notes,songs(id,work_id,title,alternative_titles,iswc,language,label,copyright_owner,status,notes)&order=updated_at.desc&limit=10000');
    return result.data || [];
  }
  if (resource === 'royalty_rules') {
    const result = await serviceRequest('royalty_rules?select=id,rule_code,recording_id,payee_id,artist_name,payee_name,role,royalty_type,share_percentage,calculation_basis,effective_date,end_date,territory,platform,currency,contract_no,status,notes,recordings(recording_id,song_id)&order=updated_at.desc&limit=10000');
    return result.data || [];
  }
  if (resource === 'royalty_imports') {
    const result = await serviceRequest('royalty_imports?select=id,batch_no,platform,period_start,period_end,original_filename,currency,status,total_rows,imported_rows,updated_rows,skipped_rows,failed_rows,review_rows,total_amount,metadata,created_at&order=created_at.desc&limit=1000');
    return result.data || [];
  }
  if (resource === 'matching_queue') {
    const result = await serviceRequest('royalty_import_rows?select=id,source_row_number,raw_data,match_status,match_method,confidence,platform,territory,currency,gross_amount,net_amount,error_reason,created_at,royalty_imports(batch_no),recordings(recording_id)&order=created_at.desc&limit=10000');
    return result.data || [];
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
  matching_queue: ['song_matching_read', 'song_matching_write'],
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
      const records = Array.isArray(req.body && req.body.records) ? req.body.records : [];
      if (!records.length || records.length > MAX_BATCH) return json(res, 400, { error: `每批必须包含 1–${MAX_BATCH} 条记录。` });
      let result;
      if (resource === 'catalog') result = await syncCatalog(records, user);
      else if (resource === 'royalty_rules') result = await syncRoyaltyRules(records, user);
      else if (resource === 'royalty_imports') result = await syncImports(records, user);
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
    return json(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error(JSON.stringify({ type: 'cheerful_os_data_error', resource, message: error.message }));
    await writeAudit({ actorId: user.sub, actorName: user.name, actorRole: user.role, action: `data.${resource}.failed`, metadata: { method: req.method, error: error.message.slice(0, 500) } });
    return json(res, error.statusCode || 500, { error: 'Supabase 数据操作失败。', detail: error.message.slice(0, 500) });
  }
};
