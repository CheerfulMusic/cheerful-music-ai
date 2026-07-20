console.log("Cheerful Finance Workflow Loaded");
(function(){
'use strict';

let activeBatchId='';
let exceptionRisk='all';
let exceptionStatus='open';
let workflowMatches=[];
let workflowCalculations=[];
let workflowExceptions=[];
let matchIndexSource=null;
let matchIndexes={isrc:new Map(),title:new Map(),artist:new Map(),prefix:new Map()};
function esc(value){return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function normalize(value){return String(value??'').toLowerCase().normalize('NFKC').replace(/[^a-z0-9\u3400-\u9fff]+/g,'')}
function normalizeISRC(value){return String(value??'').toUpperCase().replace(/[^A-Z0-9]/g,'')}
function numberValue(value){
 const number=Number(String(value??'').replace(/,/g,'').replace(/[^0-9.\-]/g,''));
 return Number.isFinite(number)?number:0
}
function money(value,currency){return `${esc(currency||'—')} ${Number(value||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`}
function getImports(){return window.CheerfulFinanceImports?window.CheerfulFinanceImports.all():[]}
function getMatches(){return workflowMatches.slice()}
function getCalculations(){return workflowCalculations.slice()}
function getExceptions(){return workflowExceptions.slice()}
function currentImports(){
 const imports=getImports();
 if(!imports.some(item=>item.id===activeBatchId))activeBatchId=imports[0]?.id||'';
 return imports
}
function currentBatch(){return currentImports().find(item=>item.id===activeBatchId)||null}
function getField(batch,row,field){const column=batch?.mapping?.[field];return column?row?.[column]??'':''}
function recordingLabel(recording){return recording?`${recording.workTitle} · ${recording.versionName} · ${recording.artist}`:'未匹配'}
function periodDate(period){
 const value=String(period||'').trim();
 const quarter=value.match(/(20\d{2})\D*Q([1-4])/i);
 if(quarter)return `${quarter[1]}-${String((Number(quarter[2])-1)*3+1).padStart(2,'0')}-01`;
 const month=value.match(/(20\d{2})\D(0?[1-9]|1[0-2])/);
 if(month)return `${month[1]}-${String(Number(month[2])).padStart(2,'0')}-01`;
 const year=value.match(/(20\d{2})/);
 return year?`${year[1]}-01-01`:new Date().toISOString().slice(0,10)
}
function activeRulesFor(recordingId,date){
 return financeRules.filter(rule=>rule.recordingId===recordingId&&(!rule.startDate||rule.startDate<=date)&&(!rule.endDate||rule.endDate>=date))
}
function dice(a,b){
 if(!a&&!b)return 1;if(!a||!b)return 0;if(a===b)return 1;
 if(a.length<2||b.length<2)return a===b?1:0;
 const pairs=new Map();
 for(let index=0;index<a.length-1;index++){const pair=a.slice(index,index+2);pairs.set(pair,(pairs.get(pair)||0)+1)}
 let overlap=0;
 for(let index=0;index<b.length-1;index++){const pair=b.slice(index,index+2),count=pairs.get(pair)||0;if(count){overlap++;pairs.set(pair,count-1)}}
 return 2*overlap/((a.length-1)+(b.length-1))
}
function confidenceLabel(score,manual){
 if(manual)return['人工确认','ok'];
 if(score>=90)return['高置信度','ok'];
 if(score>=75)return['建议确认','warn'];
 if(score>=58)return['需要审核','warn'];
 return['未匹配','danger']
}
function addIndex(map,key,recording){if(!key)return;if(!map.has(key))map.set(key,[]);map.get(key).push(recording)}
function ensureMatchIndexes(){
 if(matchIndexSource===financeRecordings)return;
 matchIndexSource=financeRecordings;
 matchIndexes={isrc:new Map(),title:new Map(),artist:new Map(),prefix:new Map()};
 financeRecordings.forEach(recording=>{
  const isrc=normalizeISRC(recording.isrc),title=normalize(recording.workTitle),artist=normalize(recording.artist);
  if(isrc)matchIndexes.isrc.set(isrc,recording);
  addIndex(matchIndexes.title,title,recording);addIndex(matchIndexes.artist,artist,recording);addIndex(matchIndexes.prefix,title.slice(0,2),recording)
 })
}
function bestRecordingMatch(title,artist,isrc){
 ensureMatchIndexes();
 const normalizedISRC=normalizeISRC(isrc);
 if(normalizedISRC){
  const exact=matchIndexes.isrc.get(normalizedISRC);
  if(exact)return{recordingId:exact.id,confidence:100,reason:'ISRC 精确匹配'}
 }
 const normalizedTitle=normalize(title),normalizedArtist=normalize(artist);
 const exactTitle=matchIndexes.title.get(normalizedTitle)||[];
 const sameArtist=matchIndexes.artist.get(normalizedArtist)||[];
 const samePrefix=matchIndexes.prefix.get(normalizedTitle.slice(0,2))||[];
 const pool=[...new Map([...exactTitle,...sameArtist,...samePrefix].map(recording=>[recording.id,recording])).values()];
 if(!pool.length)return{recordingId:'',confidence:0,reason:'未找到可靠的歌曲版本'};
 const candidates=pool.map(recording=>{
  const work=normalize(recording.workTitle),recordingArtist=normalize(recording.artist),version=normalize(recording.versionName),type=normalize(recording.versionType);
  const titleSimilarity=dice(normalizedTitle,work);
  const artistSimilarity=normalizedArtist?dice(normalizedArtist,recordingArtist):0;
  const versionHit=Boolean(normalizedTitle&&((version&&normalizedTitle.includes(version))||(type&&normalizedTitle.includes(type))));
  let score=Math.round(titleSimilarity*72+artistSimilarity*20+(versionHit?8:0));
  if(normalizedTitle===work&&normalizedArtist===recordingArtist)score=Math.max(score,92);
  else if(normalizedTitle===work&&normalizedArtist)score=Math.max(score,78);
  else if(normalizedTitle===work)score=Math.max(score,70);
  return{recordingId:recording.id,confidence:Math.min(score,99),reason:`歌名 ${Math.round(titleSimilarity*100)}% · 艺人 ${Math.round(artistSimilarity*100)}%${versionHit?' · 版本命中':''}`}
 }).sort((a,b)=>b.confidence-a.confidence);
 return candidates[0]&&candidates[0].confidence>=58?candidates[0]:{recordingId:'',confidence:candidates[0]?.confidence||0,reason:'未找到可靠的歌曲版本'}
}
function batchOptions(imports){
 return imports.map(item=>`<option value="${esc(item.id)}" ${item.id===activeBatchId?'selected':''}>${esc(item.fileName)} · ${esc(item.period)} · ${esc(item.id)}</option>`).join('')
}
function emptyWorkflow(title,description){
 return `<div class="fw-empty"><div class="fw-empty-icon">◇</div><h3>${esc(title)}</h3><p>${esc(description)}</p><button class="primary" onclick="setFinanceTab('imports')">前往平台版税导入</button></div>`
}
function workflowHeader(title,description,action){
 const imports=currentImports();
 return `<div class="finance-toolbar fw-toolbar"><div><h3>${esc(title)}</h3><p>${esc(description)}</p></div>${imports.length?`<div class="fw-toolbar-actions"><select class="finance-select" onchange="chooseFinanceWorkflowBatch(this.value)">${batchOptions(imports)}</select>${action}</div>`:''}</div>`
}
function workflowSteps(active){
 const steps=[['matching','1','AI自动匹配'],['calculation','2','AI版税计算'],['exceptions','3','异常审核']];
 return `<div class="fw-steps">${steps.map(step=>`<button class="fw-step ${step[0]===active?'active':''}" onclick="setFinanceTab('${step[0]}')"><span>${step[1]}</span><b>${step[2]}</b></button>`).join('')}</div>`
}
function injectStyles(){
 if(document.getElementById('financeWorkflowStyles'))return;
 const style=document.createElement('style');style.id='financeWorkflowStyles';style.textContent=`
.fw-toolbar{align-items:flex-start}.fw-toolbar h3{margin:0 0 6px}.fw-toolbar p{margin:0;color:var(--muted);font-size:12px;line-height:1.6}.fw-toolbar-actions{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.fw-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:8px 0 18px}.fw-step{border:1px solid var(--line);background:#0e1014;color:var(--muted);border-radius:14px;padding:12px 14px;text-align:left;display:flex;align-items:center;gap:10px}.fw-step span{width:26px;height:26px;border-radius:9px;background:#24272e;display:grid;place-items:center;font-size:11px}.fw-step b{font-size:12px}.fw-step.active{border-color:rgba(249,56,34,.45);background:rgba(249,56,34,.09);color:#ff8a7b}.fw-step.active span{background:var(--red);color:white}.fw-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}.fw-metric{border:1px solid var(--line);background:#0e1014;border-radius:14px;padding:15px}.fw-metric span{display:block;color:var(--muted);font-size:10px}.fw-metric b{display:block;margin-top:8px;font-size:21px}.fw-score{font-weight:800}.fw-score.high{color:#7be995}.fw-score.medium{color:#ffc266}.fw-score.low{color:#ff8273}.fw-select{width:100%;min-width:190px;height:36px;border:1px solid var(--line);border-radius:9px;background:#0d0f13;color:white;padding:0 9px}.fw-empty{border:1px dashed #3b3f48;border-radius:16px;padding:42px 22px;text-align:center;background:#0c0e12}.fw-empty-icon{font-size:30px;color:#737985}.fw-empty h3{margin:13px 0 7px}.fw-empty p{margin:0 auto 18px;color:var(--muted);font-size:12px;max-width:520px;line-height:1.6}.fw-info{padding:12px 14px;border:1px solid rgba(10,132,255,.25);border-radius:12px;background:rgba(10,132,255,.08);color:#b8d9ff;font-size:11px;line-height:1.6;margin:12px 0}.fw-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0}.fw-summary-card{padding:15px;border:1px solid var(--line);border-radius:14px;background:#0e1014}.fw-summary-card span{color:var(--muted);font-size:10px}.fw-summary-card b{display:block;margin-top:7px;font-size:16px}.fw-risk-high{color:#ff8171}.fw-risk-medium{color:#ffc266}.fw-risk-low{color:#8dc4ff}.fw-resolution{display:flex;gap:6px;align-items:center}.finance-chip.danger{background:rgba(255,69,58,.13);color:#ff8171}@media(max-width:1050px){.fw-metrics{grid-template-columns:repeat(2,1fr)}.fw-summary{grid-template-columns:1fr}}@media(max-width:760px){.fw-steps,.fw-metrics{grid-template-columns:1fr}.fw-toolbar-actions{width:100%;align-items:stretch;flex-direction:column}.fw-toolbar-actions .finance-select{width:100%}}`;
 document.head.appendChild(style)
}

window.renderFinanceWorkflowHeroAction=function(tab){
 if(tab==='matching')return'<button class="primary" onclick="runAIRoyaltyMatching()">开始 AI 匹配</button>';
 if(tab==='calculation')return'<button class="primary" onclick="runRoyaltyCalculation()">开始版税计算</button>';
 return'<button class="primary" onclick="refreshRoyaltyExceptions()">刷新异常</button>'
};
window.renderFinanceWorkflowTab=function(tab){
 injectStyles();
 if(tab==='matching')return renderMatching();
 if(tab==='calculation')return renderCalculation();
 return renderExceptions()
};
window.chooseFinanceWorkflowBatch=function(id){activeBatchId=id;openSection('finance')};

function renderMatching(){
 const imports=currentImports(),batch=currentBatch();
 if(!imports.length)return workflowSteps('matching')+emptyWorkflow('尚无可匹配的版税报表','请先上传 Spotify、Apple Music、腾讯音乐或其他平台报表。');
 const matches=getMatches().filter(item=>item.batchId===batch.id);
 const matched=matches.filter(item=>item.recordingId&&item.confidence>=75).length;
 const review=matches.filter(item=>item.recordingId&&item.confidence<75).length;
 const unmatched=matches.filter(item=>!item.recordingId).length;
 return `${workflowSteps('matching')}${workflowHeader('AI自动匹配','根据 ISRC、歌名、艺人和版本信息，将平台收入逐行匹配到录音版本库。','<button class="primary" onclick="runAIRoyaltyMatching()">开始 AI 匹配</button>')}
 ${matches.length?`<div class="fw-metrics"><div class="fw-metric"><span>报表预览行</span><b>${matches.length}</b></div><div class="fw-metric"><span>自动匹配</span><b class="fw-score high">${matched}</b></div><div class="fw-metric"><span>建议人工确认</span><b class="fw-score medium">${review}</b></div><div class="fw-metric"><span>无法匹配</span><b class="fw-score low">${unmatched}</b></div></div>
 <div class="fw-info">匹配优先级：ISRC 精确匹配 → 歌名＋艺人＋版本相似度 → 人工确认。低置信度结果不会直接进入最终结算。</div>
 <div class="finance-table-wrap"><table class="finance-table"><thead><tr><th>行</th><th>平台歌名</th><th>艺人</th><th>ISRC</th><th>建议录音版本</th><th>置信度</th><th>依据</th><th>状态</th></tr></thead><tbody>${matches.map(match=>matchingRow(match)).join('')}</tbody></table></div>
 <div class="finance-actions"><button class="primary" onclick="setFinanceTab('calculation')">下一步：AI版税计算 →</button></div>`:emptyWorkflow('尚未运行 AI 自动匹配','选择当前报表后点击“开始 AI 匹配”，系统将生成逐行匹配建议。')}`
}
function matchingRow(match){
 const status=confidenceLabel(match.confidence,match.manual),scoreClass=match.confidence>=90?'high':(match.confidence>=75?'medium':'low');
 const options=financeRecordings.map(recording=>`<option value="${esc(recording.id)}" ${recording.id===match.recordingId?'selected':''}>${esc(recordingLabel(recording))}</option>`).join('');
 return `<tr><td>${match.rowIndex+1}</td><td>${esc(match.title||'—')}</td><td>${esc(match.artist||'—')}</td><td>${esc(match.isrc||'—')}</td><td><select class="fw-select" onchange="overrideRoyaltyMatch('${esc(match.id)}',this.value)"><option value="">未匹配</option>${options}</select></td><td><span class="fw-score ${scoreClass}">${match.confidence}%</span></td><td>${esc(match.reason)}</td><td><span class="finance-chip ${status[1]}">${status[0]}</span></td></tr>`
}
window.runAIRoyaltyMatching=async function(){
 const batch=currentBatch();if(!batch){alert('请先导入平台版税报表。');setFinanceTab('imports');return}
 const sourceRows=getMatches().filter(item=>item.batchId===batch.id);
 if(!sourceRows.length){alert('该导入批次没有已保存的收入明细。请重新上传平台报表。');return}
 const matches=sourceRows.map((row,rowIndex)=>{
  const title=row.title||'',artist=row.artist||'',isrc=row.isrc||'';
  const suggestion=bestRecordingMatch(title,artist,isrc);
  return{...row,id:row.id||`${batch.id}-${row.rowIndex??rowIndex}`,batchId:batch.id,rowIndex:row.rowIndex??rowIndex,title,artist,isrc,country:row.country||'',period:row.period||batch.period,revenue:numberValue(row.revenue),currency:row.currency||batch.currency,quantity:numberValue(row.quantity),manual:false,...suggestion}
 });
 workflowMatches=[...getMatches().filter(item=>item.batchId!==batch.id),...matches];
 try{await window.CheerfulSupabase.saveMatches(matches);await window.CheerfulSupabase.refreshMatches();openSection('finance');showToastMessage(`AI 已完成并保存 ${matches.length} 行匹配`)}
 catch(error){await window.CheerfulSupabase.refreshMatches().catch(()=>{});alert(`匹配结果保存失败：${error.message}`)}
};
window.overrideRoyaltyMatch=async function(id,recordingId){
 const matches=getMatches(),match=matches.find(item=>item.id===id);if(!match)return;
 match.recordingId=recordingId;match.confidence=recordingId?100:0;match.manual=Boolean(recordingId);match.reason=recordingId?'财务人工确认':'财务标记为未匹配';
 try{await window.CheerfulSupabase.saveMatches([match]);await window.CheerfulSupabase.refreshMatches();openSection('finance');showToastMessage('匹配结果已保存到 Supabase')}
 catch(error){alert(`匹配结果保存失败：${error.message}`)}
};

function renderCalculation(){
 const imports=currentImports(),batch=currentBatch();
 if(!imports.length)return workflowSteps('calculation')+emptyWorkflow('尚无可计算的版税报表','请先完成平台报表导入和 AI 自动匹配。');
 const matches=getMatches().filter(item=>item.batchId===batch.id),results=getCalculations().filter(item=>item.batchId===batch.id);
 const currencies=[...new Set(results.map(item=>item.currency||'—'))];
 const payables=currencies.map(currency=>`${currency} ${results.filter(item=>(item.currency||'—')===currency).reduce((sum,item)=>sum+item.royaltyAmount,0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`).join(' · ')||'—';
 const payees=new Set(results.map(item=>item.payee)).size;
 const pending=results.filter(item=>item.status!=='calculated').length;
 return `${workflowSteps('calculation')}${workflowHeader('AI版税计算','按收入发生期间选择有效合同规则，生成可追溯的逐笔版税计算结果。','<button class="primary" onclick="runRoyaltyCalculation()">开始版税计算</button>')}
 ${!matches.length?emptyWorkflow('请先完成 AI 自动匹配','当前报表还没有匹配结果，无法确定应采用哪首录音和哪份合同。'):(results.length?`<div class="fw-metrics"><div class="fw-metric"><span>计算明细</span><b>${results.length}</b></div><div class="fw-metric"><span>涉及权利人</span><b>${payees}</b></div><div class="fw-metric"><span>应付版税</span><b style="font-size:14px">${esc(payables)}</b></div><div class="fw-metric"><span>等待审核</span><b class="fw-score ${pending?'medium':'high'}">${pending}</b></div></div>
 <div class="fw-info">金额计算由固定规则引擎执行：平台收入 × 合同有效期内的分成比例。涉及成本回收的规则会自动进入异常审核，等待 Recoupment 数据接入后确认。</div>
 ${renderPayeeSummary(results)}
 <div class="finance-table-wrap"><table class="finance-table"><thead><tr><th>歌曲版本</th><th>权利人</th><th>平台收入</th><th>分成比例</th><th>计算基数</th><th>应付金额</th><th>合同</th><th>状态</th></tr></thead><tbody>${results.map(result=>`<tr><td>${esc(financeRecordingLabel(result.recordingId))}</td><td>${esc(result.payee)}</td><td>${money(result.revenue,result.currency)}</td><td>${result.percentage}%</td><td>${esc(result.basis)}</td><td><b>${money(result.royaltyAmount,result.currency)}</b></td><td>${esc(result.contractNo)}</td><td><span class="finance-chip ${result.status==='calculated'?'ok':'warn'}">${result.status==='calculated'?'已计算':'待审核'}</span></td></tr>`).join('')}</tbody></table></div>
 <div class="finance-actions"><button class="primary" onclick="setFinanceTab('exceptions')">下一步：异常审核 →</button></div>`:emptyWorkflow('尚未生成版税计算结果','点击“开始版税计算”，系统将按录音版本、合同有效期和分成比例进行计算。'))}`
}
function renderPayeeSummary(results){
 const grouped={};results.forEach(result=>{const key=`${result.payee}__${result.currency}`;grouped[key]||(grouped[key]={payee:result.payee,currency:result.currency,amount:0,count:0});grouped[key].amount+=result.royaltyAmount;grouped[key].count++});
 const items=Object.values(grouped);if(!items.length)return'';
 return `<div class="fw-summary">${items.slice(0,6).map(item=>`<div class="fw-summary-card"><span>${esc(item.payee)} · ${item.count} 笔</span><b>${money(item.amount,item.currency)}</b></div>`).join('')}</div>`
}
window.runRoyaltyCalculation=async function(){
 const batch=currentBatch();if(!batch){alert('请先导入平台版税报表。');return}
 let matches=getMatches().filter(item=>item.batchId===batch.id);
 if(!matches.length){await runAIRoyaltyMatching();matches=getMatches().filter(item=>item.batchId===batch.id)}
 try{
  showToastMessage('正在由服务器规则引擎计算并写入 Supabase…');
  const response=await window.CheerfulSupabase.runCalculation(batch.id);
  await Promise.all([window.CheerfulSupabase.refreshCalculations(),window.CheerfulSupabase.refreshExceptions()]);
  openSection('finance');showToastMessage(`规则引擎已保存 ${response.result?.lines||0} 笔计算明细和 ${response.result?.exceptions||0} 项异常`)
 }catch(error){alert(`版税计算失败：${error.message}`)}
};

function deriveExceptions(batch){
 return batch?getExceptions().filter(item=>item.batchId===batch.id):[]
}
function renderExceptions(){
 const imports=currentImports(),batch=currentBatch();
 if(!imports.length)return workflowSteps('exceptions')+emptyWorkflow('尚无可审核的数据','请先导入平台报表，完成自动匹配和版税计算。');
 const all=deriveExceptions(batch),filtered=all.filter(item=>(exceptionRisk==='all'||item.risk===exceptionRisk)&&(exceptionStatus==='all'||(exceptionStatus==='resolved'?item.resolved:!item.resolved)));
 const high=all.filter(item=>item.risk==='高风险'&&!item.resolved).length,medium=all.filter(item=>item.risk==='中风险'&&!item.resolved).length,resolved=all.filter(item=>item.resolved).length;
 return `${workflowSteps('exceptions')}${workflowHeader('异常审核','集中处理无法匹配、合同失效、成本回收、负数和重复收入等风险。','<button class="primary" onclick="refreshRoyaltyExceptions()">刷新异常</button>')}
 <div class="fw-metrics"><div class="fw-metric"><span>全部异常</span><b>${all.length}</b></div><div class="fw-metric"><span>高风险待处理</span><b class="fw-score low">${high}</b></div><div class="fw-metric"><span>中风险待处理</span><b class="fw-score medium">${medium}</b></div><div class="fw-metric"><span>已解决</span><b class="fw-score high">${resolved}</b></div></div>
 <div class="finance-toolbar"><div class="finance-toolbar-left"><select class="finance-select" onchange="setRoyaltyExceptionRisk(this.value)"><option value="all" ${exceptionRisk==='all'?'selected':''}>全部风险</option><option value="高风险" ${exceptionRisk==='高风险'?'selected':''}>高风险</option><option value="中风险" ${exceptionRisk==='中风险'?'selected':''}>中风险</option></select><select class="finance-select" onchange="setRoyaltyExceptionStatus(this.value)"><option value="open" ${exceptionStatus==='open'?'selected':''}>待处理</option><option value="resolved" ${exceptionStatus==='resolved'?'selected':''}>已解决</option><option value="all" ${exceptionStatus==='all'?'selected':''}>全部状态</option></select></div><span class="finance-chip">${filtered.length} 项</span></div>
 ${filtered.length?`<div class="finance-table-wrap"><table class="finance-table"><thead><tr><th>风险</th><th>异常类型</th><th>歌曲 / 权利人</th><th>异常说明</th><th>系统建议</th><th>状态</th><th>操作</th></tr></thead><tbody>${filtered.map(item=>`<tr><td><b class="${item.risk==='高风险'?'fw-risk-high':'fw-risk-medium'}">${esc(item.risk)}</b></td><td>${esc(item.type)}</td><td>${esc(item.subject)}</td><td>${esc(item.description)}</td><td>${esc(item.suggestion)}</td><td><span class="finance-chip ${item.resolved?'ok':'warn'}">${item.resolved?'已解决':'待处理'}</span></td><td><button class="finance-link" onclick="toggleRoyaltyException('${esc(item.id)}',${item.resolved?'false':'true'})">${item.resolved?'重新打开':'标记已解决'}</button></td></tr>`).join('')}</tbody></table></div>`:emptyWorkflow(all.length?'当前筛选条件下没有异常':'当前批次未发现异常','可以调整风险和状态筛选，或返回前一步重新计算。')}
 <div class="finance-note">异常及处理状态已保存到 Supabase，并记录处理人、处理时间和审计日志。</div>`
}
window.refreshRoyaltyExceptions=async function(){try{await window.CheerfulSupabase.refreshExceptions();openSection('finance');showToastMessage('已从 Supabase 刷新异常')}catch(error){alert(`刷新失败：${error.message}`)}};
window.setRoyaltyExceptionRisk=function(value){exceptionRisk=value;openSection('finance')};
window.setRoyaltyExceptionStatus=function(value){exceptionStatus=value;openSection('finance')};
window.toggleRoyaltyException=async function(id,resolved){try{await window.CheerfulSupabase.resolveException(id,resolved?'resolved':'reopened','财务在异常审核页面更新状态');await window.CheerfulSupabase.refreshExceptions();openSection('finance');showToastMessage(resolved?'异常已标记为解决':'异常已重新打开')}catch(error){alert(`异常状态保存失败：${error.message}`)}};

injectStyles();
window.CheerfulFinanceWorkflow={
 replaceMatches:function(records){workflowMatches=Array.isArray(records)?records:[]},
 replaceCalculations:function(records){workflowCalculations=Array.isArray(records)?records:[]},
 replaceExceptions:function(records){workflowExceptions=Array.isArray(records)?records:[]},
 matches:function(){return workflowMatches.slice()},
 calculations:function(){return workflowCalculations.slice()},
 exceptions:function(){return workflowExceptions.slice()}
};
})();
