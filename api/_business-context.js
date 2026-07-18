const { serviceRequest, supabaseConfig } = require('./_supabase');

function rows(result) {
  return result && Array.isArray(result.data) ? result.data : [];
}

async function readTable(path) {
  try { return rows(await serviceRequest(path)); }
  catch (error) {
    console.error(JSON.stringify({ type: 'cheerful_context_error', path: path.split('?')[0], message: error.message }));
    return [];
  }
}

async function readAuthorizedBusinessContext(user, question) {
  if (!supabaseConfig().databaseConfigured || !user.permissions.includes('internal_context')) {
    return { configured: false, data: null };
  }
  const context = {
    generatedAt: new Date().toISOString(),
    source: 'supabase',
    scope: `Server-loaded context for role: ${user.role}.`,
    summary: {}
  };

  if (user.permissions.includes('catalog_context')) {
    let recordings = [];
    try {
      recordings = rows(await serviceRequest('rpc/search_music_catalog', {
        method: 'POST',
        body: JSON.stringify({ search_text: String(question || '').slice(0, 500), result_limit: 60 })
      }));
    } catch (error) {
      console.error(JSON.stringify({ type: 'cheerful_context_error', path: 'search_music_catalog', message: error.message }));
    }
    context.recordings = recordings;
    context.summary.recordingCount = recordings.length;
  }

  if (user.permissions.includes('financial_data')) {
    context.royaltyRules = await readTable('royalty_rules?select=id,rule_code,song_id,recording_id,payee_id,artist_name,payee_name,role,royalty_type,share_percentage,calculation_basis,effective_date,end_date,territory,platform,currency,contract_no,status,notes&order=updated_at.desc&limit=80');
    context.recentImports = await readTable('royalty_imports?select=id,batch_no,platform,period_start,period_end,original_filename,currency,status,total_rows,imported_rows,failed_rows,review_rows,total_amount,created_at&order=created_at.desc&limit=20');
    context.relevantMatches = await readTable('royalty_import_rows?select=id,import_id,source_row_number,song_id,recording_id,match_status,match_method,confidence,platform,territory,usage_date,currency,gross_amount,fees,tax_amount,net_amount,error_reason&order=created_at.desc&limit=80');
    context.summary.royaltyRuleCount = context.royaltyRules.length;
    context.summary.importBatchCount = context.recentImports.length;
    context.summary.matchedRowCount = context.relevantMatches.length;
  }

  if (user.permissions.includes('hr_data')) {
    context.hrRecords = await readTable('hr_records?select=id,employee_user_id,employee_name,department,job_title,employment_status,notes,metadata,updated_at&order=updated_at.desc&limit=80');
    context.recruitmentRecords = await readTable('recruitment_records?select=id,candidate_name,position,status,owner_user_id,notes,metadata,updated_at&order=updated_at.desc&limit=80');
    context.summary.hrRecordCount = context.hrRecords.length;
    context.summary.recruitmentRecordCount = context.recruitmentRecords.length;
  }

  if (user.permissions.includes('legal_data')) {
    context.contracts = await readTable('contracts?select=id,contract_no,title,counterparty,contract_type,effective_date,end_date,status,storage_path,notes,metadata,updated_at&order=updated_at.desc&limit=80');
    context.legalRecords = await readTable('legal_records?select=id,title,record_type,status,owner_user_id,notes,metadata,updated_at&order=updated_at.desc&limit=80');
    context.summary.contractCount = context.contracts.length;
    context.summary.legalRecordCount = context.legalRecords.length;
  }

  return { configured: true, data: context };
}

module.exports = { readAuthorizedBusinessContext };
