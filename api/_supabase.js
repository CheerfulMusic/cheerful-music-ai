function firstConfiguredKey(names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const secretKey = firstConfiguredKey(['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  const publishableKey = firstConfiguredKey(['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY']);
  return {
    url,
    secretKey,
    publishableKey,
    databaseConfigured: Boolean(url && secretKey),
    authConfigured: Boolean(url && secretKey && publishableKey)
  };
}

function keyHeaders(key, headers = {}) {
  const result = { apikey: key, 'Content-Type': 'application/json', ...headers };
  if (key && !key.startsWith('sb_')) result.Authorization = `Bearer ${key}`;
  return result;
}

async function serviceRequest(path, options = {}) {
  const config = supabaseConfig();
  if (!config.databaseConfigured) return { configured: false, data: null, count: null };
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers: keyHeaders(config.secretKey, options.headers || {})
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  const text = await response.text();
  const contentRange = response.headers.get('content-range') || '';
  const total = contentRange.includes('/') ? Number(contentRange.split('/').pop()) : null;
  return { configured: true, data: text ? JSON.parse(text) : null, count: Number.isFinite(total) ? total : null };
}

async function signInWithPassword(email, password) {
  const config = supabaseConfig();
  if (!config.authConfigured) return { configured: false, user: null };
  const response = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: keyHeaders(config.publishableKey),
    body: JSON.stringify({ email, password })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.user) return { configured: true, user: null };
  const profile = await serviceRequest(`users?id=eq.${encodeURIComponent(data.user.id)}&select=id,email,display_name,role,department,active&limit=1`);
  const record = Array.isArray(profile.data) ? profile.data[0] : null;
  if (!record || record.active === false) return { configured: true, user: null };
  return {
    configured: true,
    user: {
      id: record.id,
      email: String(record.email || data.user.email || email).toLowerCase(),
      name: record.display_name || String(record.email || email).split('@')[0],
      role: record.role || 'viewer',
      department: record.department || ''
    }
  };
}

module.exports = { serviceRequest, signInWithPassword, supabaseConfig };
