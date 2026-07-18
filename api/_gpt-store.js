const { serviceRequest, supabaseConfig } = require('./_supabase');

async function writeAudit(event) {
  const record = {
    actor_id: event.actorId,
    actor_name: event.actorName,
    actor_role: event.actorRole,
    action: event.action,
    conversation_id: event.conversationId || null,
    metadata: event.metadata || {},
    created_at: new Date().toISOString()
  };
  console.log(JSON.stringify({ type: 'cheerful_gpt_audit', ...record }));
  try {
    const result = await serviceRequest('gpt_audit_logs', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(record)
    });
    return result.configured;
  } catch (error) {
    console.error(JSON.stringify({ type: 'cheerful_gpt_store_error', target: 'audit', message: error.message }));
    return false;
  }
}

async function writeMessages(records) {
  if (!records.length) return false;
  try {
    const result = await serviceRequest('gpt_chat_messages', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(records)
    });
    return result.configured;
  } catch (error) {
    console.error(JSON.stringify({ type: 'cheerful_gpt_store_error', target: 'messages', message: error.message }));
    return false;
  }
}

async function readMessages(userId, limit = 100) {
  try {
    return await serviceRequest(`gpt_chat_messages?actor_id=eq.${encodeURIComponent(userId)}&select=conversation_id,role,content,sources,created_at&order=created_at.asc&limit=${Math.min(limit, 200)}`);
  } catch (error) {
    console.error(JSON.stringify({ type: 'cheerful_gpt_store_error', target: 'history', message: error.message }));
    return { configured: supabaseConfig().databaseConfigured, data: [] };
  }
}

async function readAudit(limit = 100) {
  try {
    return await serviceRequest(`gpt_audit_logs?select=actor_name,actor_role,action,conversation_id,metadata,created_at&order=created_at.desc&limit=${Math.min(limit, 200)}`);
  } catch (error) {
    console.error(JSON.stringify({ type: 'cheerful_gpt_store_error', target: 'audit_read', message: error.message }));
    return { configured: supabaseConfig().databaseConfigured, data: [] };
  }
}

module.exports = { readAudit, readMessages, writeAudit, writeMessages };
