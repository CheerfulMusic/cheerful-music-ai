const { isAllowedOrigin, requireSession } = require('./_gpt-auth');
const { writeAudit } = require('./_gpt-store');

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['pdf', 'csv', 'xlsx', 'xls', 'doc', 'docx', 'txt', 'md', 'json', 'rtf']);

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
  if (!isAllowedOrigin(req)) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: '不允许的请求来源。' }));
  }
  const user = requireSession(req, res, 'file_upload');
  if (!user) return;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: '服务器尚未配置 OPENAI_API_KEY。' }));
  }

  const body = req.body || {};
  const name = String(body.name || 'document').replace(/[\\/]/g, '_').slice(0, 180);
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: '仅支持 PDF、CSV、Excel、Word 和常见文本文件。' }));
  }
  let bytes;
  try { bytes = Buffer.from(String(body.data || ''), 'base64'); }
  catch (_) { bytes = null; }
  if (!bytes || !bytes.length || bytes.length > MAX_FILE_BYTES) {
    res.statusCode = 413;
    return res.end(JSON.stringify({ error: '文件不能为空，且单个文件不能超过 3 MB。' }));
  }

  const form = new FormData();
  form.append('purpose', 'user_data');
  form.append('file', new Blob([bytes], { type: String(body.type || 'application/octet-stream') }), name);
  const response = await fetch('https://api.openai.com/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    res.statusCode = response.status;
    return res.end(JSON.stringify({ error: data.error && data.error.message || '文件上传失败。' }));
  }
  await writeAudit({
    actorId: user.sub,
    actorName: user.name,
    actorRole: user.role,
    action: 'file.uploaded',
    metadata: { fileId: data.id, name, bytes: bytes.length }
  });
  return res.end(JSON.stringify({ fileId: data.id, name, bytes: bytes.length }));
};
