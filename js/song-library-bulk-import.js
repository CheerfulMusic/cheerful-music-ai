console.log("Cheerful Song Library Bulk Import Loaded");
(function(){
'use strict';

const fields=[
 {key:'workId',label:'Work ID',description:'作品唯一编号',aliases:['work id','workid','作品id','作品编号','作品唯一编号']},
 {key:'workTitle',label:'Song Title',description:'歌名',required:true,aliases:['song title','songtitle','track title','title','song name','歌曲','歌曲名称','歌名','作品名']},
 {key:'alternativeTitle',label:'Alternative Title',description:'别名／旧名',aliases:['alternative title','alternativetitle','alternate title','alias','old title','别名','旧名']},
 {key:'writer',label:'Writer',description:'作者／词曲作者',aliases:['writer','songwriter','author','composer','lyricist','词曲作者','作者','作词','作曲']},
 {key:'artist',label:'Artist',description:'艺人',required:true,aliases:['artist','artist name','performer','singer','艺人','歌手','演唱者','主艺人']},
 {key:'versionName',label:'Version Name',description:'版本名称',aliases:['version name','versionname','version','版本','版本名称']},
 {key:'versionType',label:'Version Type',description:'原版／Live／Remix／翻唱／伴奏',aliases:['version type','versiontype','type','版本类型','类型']},
 {key:'isrc',label:'ISRC',description:'录音唯一编码',aliases:['isrc','recording code','录音编码','录音唯一编码']},
 {key:'iswc',label:'ISWC',description:'词曲作品编码',aliases:['iswc','work code','词曲作品编码','作品编码']},
 {key:'upc',label:'UPC',description:'专辑／发行编码',aliases:['upc','release code','album code','专辑编码','发行编码']},
 {key:'language',label:'Language',description:'语言',aliases:['language','lang','语言','语种']},
 {key:'releaseDate',label:'Release Date',description:'发行日期',aliases:['release date','releasedate','date released','发行日期','上线日期']},
 {key:'label',label:'Label',description:'厂牌',aliases:['label','record label','厂牌','唱片公司']},
 {key:'copyrightOwner',label:'Copyright Owner',description:'版权方',aliases:['copyright owner','copyrightowner','copyright holder','版权方','版权公司','版权归属']},
 {key:'recordingOwner',label:'Recording Owner',description:'录音权方',aliases:['recording owner','recordingowner','master owner','master rights owner','录音权方','母带版权方','录音版权方']},
 {key:'status',label:'Status',description:'已发行／未发行／下架',aliases:['status','release status','发行状态','状态']},
 {key:'notes',label:'Notes',description:'备注',aliases:['notes','note','comments','comment','备注','说明']}
];
const steps=['上传表格','字段映射','数据预览','重复检查','错误提示','确认导入'];
let bulkStep=1;
let bulkState={fileName:'',headers:[],rows:[],mapping:{},report:null,result:null};

function esc(value){return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function normalize(value){return String(value??'').trim().toLowerCase().normalize('NFKC').replace(/[\s_\-()./\\]+/g,'')}
function normalizeCode(value){return String(value??'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'')}
function valueFor(row,key){const header=bulkState.mapping[key];return header?String(row?.[header]??'').trim():''}
function detectMapping(headers){
 const mapping={};
 fields.forEach(field=>{
  const aliases=field.aliases.map(normalize);
  const exact=headers.find(header=>aliases.includes(normalize(header)));
  const partial=exact||headers.find(header=>aliases.some(alias=>normalize(header).includes(alias)||alias.includes(normalize(header))));
  if(partial)mapping[field.key]=partial
 });
 return mapping
}
function parseDate(value){
 if(!value)return'';
 if(value instanceof Date&&!Number.isNaN(value.valueOf()))return value.toISOString().slice(0,10);
 if(typeof value==='number'&&window.XLSX?.SSF){const parsed=XLSX.SSF.parse_date_code(value);if(parsed)return `${parsed.y}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`}
 const text=String(value).trim(),match=text.match(/(20\d{2})\D(0?[1-9]|1[0-2])\D(0?[1-9]|[12]\d|3[01])/);
 return match?`${match[1]}-${String(Number(match[2])).padStart(2,'0')}-${String(Number(match[3])).padStart(2,'0')}`:text
}
function inferVersionType(versionName,value){
 if(value)return value;
 const name=String(versionName||'').toLowerCase();
 if(/live|现场/.test(name))return'Live';
 if(/remix|混音/.test(name))return'Remix';
 if(/翻唱|cover/.test(name))return'翻唱';
 if(/伴奏|instrumental/.test(name))return'伴奏';
 if(/dj/.test(name))return'DJ版';
 return'原版'
}
function mappedValues(row){
 const versionName=valueFor(row,'versionName')||'原版';
 return{
  workId:valueFor(row,'workId'),workTitle:valueFor(row,'workTitle'),alternativeTitle:valueFor(row,'alternativeTitle'),writer:valueFor(row,'writer'),
  artist:valueFor(row,'artist'),versionName,versionType:inferVersionType(versionName,valueFor(row,'versionType')),isrc:valueFor(row,'isrc'),
  iswc:valueFor(row,'iswc'),upc:valueFor(row,'upc'),language:valueFor(row,'language'),releaseDate:parseDate(valueFor(row,'releaseDate')),
  label:valueFor(row,'label'),copyrightOwner:valueFor(row,'copyrightOwner'),recordingOwner:valueFor(row,'recordingOwner'),
  status:valueFor(row,'status')||'未发行',notes:valueFor(row,'notes')
 }
}
function workAliases(values){
 const aliases=[];
 if(values.workId)aliases.push(`workid:${normalizeCode(values.workId)}`);
 if(values.iswc)aliases.push(`iswc:${normalizeCode(values.iswc)}`);
 if(values.workTitle&&values.writer)aliases.push(`titlewriter:${normalize(values.workTitle)}|${normalize(values.writer)}`);
 if(values.workTitle&&values.artist)aliases.push(`titleartist:${normalize(values.workTitle)}|${normalize(values.artist)}`);
 return aliases
}
function mergeNonEmpty(existing,incoming){
 const merged={...existing};
 Object.entries(incoming).forEach(([key,value])=>{if(value!==''&&value!==null&&value!==undefined)merged[key]=value});
 merged.id=existing.id;
 return merged
}
function nextIdFactory(prefix,values){
 const used=new Set(values.map(String));
 let next=values.reduce((max,value)=>Math.max(max,Number((String(value).match(/\d+$/)||['0'])[0])),0)+1;
 return()=>{let value;do{value=`${prefix}${String(next++).padStart(6,'0')}`}while(used.has(value));used.add(value);return value}
}

function buildWorkGroups(incoming){
 const nodes=[],parent=[],rank=[];
 const aliasIndex=new Map();
 function addNode(data){const index=nodes.length;nodes.push(data);parent.push(index);rank.push(0);return index}
 function find(index){while(parent[index]!==index){parent[index]=parent[parent[index]];index=parent[index]}return index}
 function union(a,b){a=find(a);b=find(b);if(a===b)return;if(rank[a]<rank[b])[a,b]=[b,a];parent[b]=a;if(rank[a]===rank[b])rank[a]++}
 function register(index,aliases){aliases.forEach(alias=>{if(aliasIndex.has(alias))union(index,aliasIndex.get(alias));else aliasIndex.set(alias,index)})}

 financeRecordings.forEach((record,index)=>{
  const node=addNode({kind:'existing',index,values:record});
  register(node,workAliases(record))
 });
 incoming.forEach((values,index)=>{
  const node=addNode({kind:'incoming',index,values});
  register(node,workAliases(values))
 });

 const groups=new Map();
 nodes.forEach((node,index)=>{const root=find(index);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(node)});
 return{incomingRoots:incoming.map((_,index)=>find(financeRecordings.length+index)),groups}
}

function buildReport(){
 const incoming=bulkState.rows.map(mappedValues);
 const {incomingRoots,groups}=buildWorkGroups(incoming);
 const usedWorkIds=[...financeRecordings.map(item=>item.workId).filter(Boolean),...incoming.map(item=>item.workId).filter(Boolean)];
 const usedRecordingIds=financeRecordings.map(item=>item.id).filter(Boolean);
 const nextWorkId=nextIdFactory('CM-W-',usedWorkIds),nextRecordingIdValue=nextIdFactory('CM-R-',usedRecordingIds);
 const groupMeta=new Map();
 groups.forEach((nodes,root)=>{
  const workIds=[...new Set(nodes.map(node=>node.values.workId).filter(Boolean))];
  const existingWorkId=nodes.find(node=>node.kind==='existing'&&node.values.workId)?.values.workId;
  groupMeta.set(root,{workId:existingWorkId||workIds[0]||nextWorkId(),conflict:workIds.length>1,workIds})
 });

 const existingByISRC=new Map();
 const existingByComposite=new Map();
 financeRecordings.forEach(record=>{
  const isrc=normalizeCode(record.isrc);if(isrc&&!existingByISRC.has(isrc))existingByISRC.set(isrc,record);
  const aliases=workAliases(record),canonical=record.workId||aliases[0];
  if(canonical&&record.artist&&(record.versionName||'原版'))existingByComposite.set(`${normalizeCode(canonical)}|${normalize(record.artist)}|${normalize(record.versionName||'原版')}`,record)
 });

 const seenISRC=new Set(),seenComposite=new Set();
 const items=incoming.map((values,rowIndex)=>{
  const issues=[],warnings=[],root=incomingRoots[rowIndex],meta=groupMeta.get(root);
  if(!values.workTitle)issues.push('缺少 Song Title');
  if(!values.artist)issues.push('缺少 Artist');
  if(!workAliases(values).length)issues.push('缺少作品识别信息：需要 Work ID、ISWC、Song Title + Writer 或 Song Title + Artist');
  if(meta?.conflict)issues.push(`作品标识冲突：同组出现多个 Work ID（${meta.workIds.join('、')}）`);
  const workId=meta?.workId||'';
  const isrcKey=normalizeCode(values.isrc);
  const compositeKey=workId&&values.artist?`${normalizeCode(workId)}|${normalize(values.artist)}|${normalize(values.versionName||'原版')}`:'';
  if(!isrcKey&&!compositeKey)issues.push('缺少录音识别信息：需要 ISRC，或 Artist + Version Name');
  const fileDuplicate=(isrcKey&&seenISRC.has(isrcKey))||(compositeKey&&seenComposite.has(compositeKey));
  if(isrcKey)seenISRC.add(isrcKey);if(compositeKey)seenComposite.add(compositeKey);
  if(fileDuplicate)warnings.push('文件内录音版本重复');
  const isrcExisting=isrcKey&&existingByISRC.get(isrcKey);
  const compositeExisting=compositeKey&&existingByComposite.get(compositeKey);
  const existing=isrcExisting||compositeExisting||null;
  if(isrcExisting){
   const titleConflict=values.workTitle&&isrcExisting.workTitle&&normalize(values.workTitle)!==normalize(isrcExisting.workTitle);
   const artistConflict=values.artist&&isrcExisting.artist&&normalize(values.artist)!==normalize(isrcExisting.artist);
   if(titleConflict||artistConflict)issues.push('ISRC 已存在，但歌名或艺人与已有记录不一致，请人工确认');
  }
  if(compositeExisting&&isrcKey&&normalizeCode(compositeExisting.isrc)&&normalizeCode(compositeExisting.isrc)!==isrcKey){
   issues.push('同一作品／艺人／版本已存在，但 ISRC 不一致，请人工确认');
  }
  const incomingRecord={...values,workId};
  let state='new',targetId='';
  if(issues.length)state='error';
  else if(fileDuplicate)state='duplicate';
  else if(existing){state='update';targetId=existing.id;warnings.push('将更新已有录音版本')}
  if(!valueFor(bulkState.rows[rowIndex],'versionName'))warnings.push('Version Name 为空，已按“原版”处理');
  const record=existing?mergeNonEmpty(existing,{...incomingRecord,id:existing.id}):{id:nextRecordingIdValue(),...incomingRecord};
  return{rowIndex,state,issues,warnings,record,targetId,sourceRow:bulkState.rows[rowIndex],workIdentity:workAliases(values)[0]||'',recordingIdentity:isrcKey?`ISRC ${values.isrc}`:`${values.artist} + ${values.versionName}`}
 });
 const newItems=items.filter(item=>item.state==='new'),updates=items.filter(item=>item.state==='update');
 const duplicates=items.filter(item=>item.state==='duplicate'),errors=items.filter(item=>item.state==='error');
 const workCount=new Set([...newItems,...updates].map(item=>item.record.workId).filter(Boolean)).size;
 return{items,newItems,updates,duplicates,errors,total:items.length,recognized:Object.keys(bulkState.mapping).length,workCount,successCount:newItems.length+updates.length,failCount:duplicates.length+errors.length}
}

function readWorkbook(file){
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onerror=()=>reject(new Error('文件读取失败'));
  reader.onload=event=>{
   try{
    if(!window.XLSX)throw new Error('Excel 解析组件尚未加载，请刷新页面后重试');
    const extension=file.name.split('.').pop().toLowerCase();
    const workbook=XLSX.read(event.target.result,{type:extension==='csv'?'string':'array',cellDates:true});
    const sheet=workbook.Sheets[workbook.SheetNames[0]];
    resolve(XLSX.utils.sheet_to_json(sheet,{defval:'',raw:false}))
   }catch(error){reject(error)}
  };
  if(file.name.toLowerCase().endsWith('.csv'))reader.readAsText(file,'UTF-8');else reader.readAsArrayBuffer(file)
 })
}

function injectStyles(){
 if(document.getElementById('songBulkImportStyles'))return;
 const style=document.createElement('style');style.id='songBulkImportStyles';style.textContent=`
.song-bulk-modal{width:min(1180px,100%)}.sbi-steps{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;margin-bottom:18px}.sbi-step{display:flex;align-items:center;gap:7px;padding:9px;border:1px solid var(--line);border-radius:12px;color:var(--muted);background:#0e1014;font-size:10px;min-width:0}.sbi-step span{width:24px;height:24px;flex:0 0 24px;border-radius:8px;background:#24272e;display:grid;place-items:center;font-size:10px}.sbi-step.active{border-color:rgba(249,56,34,.42);background:rgba(249,56,34,.08);color:#ff8a7b}.sbi-step.active span{background:var(--red);color:white}.sbi-step.done{color:#86e89b}.sbi-step.done span{background:#1d6a34;color:white}.sbi-drop{padding:48px 22px;border:1px dashed #434751;border-radius:16px;background:#0c0e12;text-align:center}.sbi-drop.drag{border-color:var(--red);background:rgba(249,56,34,.08)}.sbi-drop h3{margin:12px 0 7px}.sbi-drop p{margin:0;color:var(--muted);font-size:12px;line-height:1.6}.sbi-formats{display:flex;justify-content:center;gap:8px;margin:17px 0}.sbi-formats span{padding:6px 9px;border-radius:999px;background:#24272e;color:#c9ccd3;font-size:10px}.sbi-file{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 14px;border:1px solid var(--line);border-radius:13px;background:#0e1014;margin-bottom:14px}.sbi-file small{display:block;color:var(--muted);margin-top:4px}.sbi-mapping{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:14px 0;max-height:480px;overflow:auto}.sbi-map-row{display:grid;grid-template-columns:minmax(150px,.8fr) minmax(180px,1fr);gap:10px;align-items:center;padding:11px;border:1px solid var(--line);border-radius:12px;background:#0e1014}.sbi-map-row b{font-size:12px}.sbi-map-row small{display:block;color:var(--muted);margin-top:4px}.sbi-map-row select{width:100%;height:38px;border:1px solid var(--line);border-radius:10px;background:#0d0f13;color:white;padding:0 9px}.sbi-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:9px;margin:15px 0}.sbi-stat{padding:13px;border:1px solid var(--line);border-radius:13px;background:#0e1014}.sbi-stat span{display:block;color:var(--muted);font-size:10px}.sbi-stat b{display:block;margin-top:7px;font-size:19px}.sbi-help{padding:12px 14px;border:1px solid rgba(10,132,255,.24);border-radius:12px;background:rgba(10,132,255,.08);color:#b8d9ff;font-size:11px;line-height:1.6}.sbi-warning{border-color:rgba(255,174,56,.28);background:rgba(255,174,56,.08);color:#ffd39a}.sbi-preview{max-height:390px;overflow:auto;border:1px solid var(--line);border-radius:14px}.sbi-preview table{width:100%;min-width:1450px;border-collapse:collapse}.sbi-preview th,.sbi-preview td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;font-size:11px;white-space:nowrap}.sbi-preview th{position:sticky;top:0;background:#0e1014;color:var(--muted);z-index:1}.sbi-preview td{background:#111317}.sbi-status-new,.sbi-status-update{color:#7be995}.sbi-status-duplicate,.sbi-status-error{color:#ff8171}.sbi-result{padding:36px 20px;text-align:center;border:1px solid var(--line);border-radius:16px;background:#0e1014}.sbi-result-icon{width:56px;height:56px;margin:0 auto 14px;border-radius:18px;background:#1d6a34;display:grid;place-items:center;font-size:26px}@media(max-width:980px){.sbi-steps{grid-template-columns:repeat(3,1fr)}}@media(max-width:820px){.sbi-mapping,.sbi-stats{grid-template-columns:1fr}.sbi-map-row{grid-template-columns:1fr}.sbi-file{align-items:flex-start;flex-direction:column}.sbi-steps{grid-template-columns:repeat(2,1fr)}}`;
 document.head.appendChild(style)
}

function installEntry(){
 const original=window.renderRecordingManager;
 if(typeof original!=='function'||original.__songBulkWrapped)return;
 const wrapped=function(){
  const html=original();
  return html.replace('<button class="primary" onclick="openFinanceModal(\'recording\')">新增录音版本</button>','<div class="finance-toolbar-left"><button class="ghost" onclick="openSongBulkImport()">Bulk Import</button><button class="primary" onclick="openFinanceModal(\'recording\')">新增录音版本</button></div>')
 };
 wrapped.__songBulkWrapped=true;window.renderRecordingManager=wrapped
}
function ensureModal(){
 let backdrop=document.getElementById('songBulkImportModal');if(backdrop)return backdrop;
 backdrop=document.createElement('div');backdrop.id='songBulkImportModal';backdrop.className='finance-modal-backdrop';
 backdrop.addEventListener('click',event=>{if(event.target===backdrop)closeSongBulkImport()});
 backdrop.innerHTML='<div class="finance-modal song-bulk-modal" id="songBulkImportContent"></div>';document.body.appendChild(backdrop);return backdrop
}
function modalHead(subtitle){return `<div class="finance-modal-head"><div><h3>Song Library Bulk Import</h3><div style="color:var(--muted);font-size:12px;margin-top:5px">${esc(subtitle)}</div></div><button class="finance-close" onclick="closeSongBulkImport()">×</button></div>`}
function stepHeader(){return `<div class="sbi-steps">${steps.map((label,index)=>{const step=index+1;return `<div class="sbi-step ${bulkStep===step?'active':(bulkStep>step?'done':'')}"><span>${bulkStep>step?'✓':step}</span><b>${label}</b></div>`}).join('')}</div>`}
function fileSummary(){const report=bulkState.report||buildReport();return `<div class="sbi-file"><div><b>${esc(bulkState.fileName)}</b><small>${report.total.toLocaleString()} 行 · 已识别 ${report.recognized}/${fields.length} 个字段</small></div><button class="ghost" onclick="resetSongBulkImport()">重新选择文件</button></div>`}
function actions(back,nextLabel,nextStep,disabled=false){return `<div class="finance-actions"><button class="ghost" onclick="goSongBulkStep(${back})">上一步</button><button class="primary" ${disabled?'disabled':''} onclick="goSongBulkStep(${nextStep})">${esc(nextLabel)}</button></div>`}
function mappingOptions(field){return `<option value="">不导入</option>${bulkState.headers.map(header=>`<option value="${esc(header)}" ${bulkState.mapping[field.key]===header?'selected':''}>${esc(header)}</option>`).join('')}`}
function statusLabel(state){return state==='new'?'新增':state==='update'?'更新已有':state==='duplicate'?'重复跳过':'数据错误'}
function renderTable(items,limit=50){
 const preview=items.slice(0,limit);
 return `<div class="sbi-preview"><table><thead><tr><th>行</th><th>状态</th><th>Work ID</th><th>Song Title</th><th>Writer</th><th>Alternative Title</th><th>Artist</th><th>Version Name</th><th>Version Type</th><th>ISRC</th><th>ISWC</th><th>UPC</th><th>Language</th><th>Release Date</th><th>Label</th><th>Copyright Owner</th><th>Recording Owner</th><th>Status</th><th>问题／备注</th></tr></thead><tbody>${preview.length?preview.map(item=>`<tr><td>${item.rowIndex+2}</td><td class="sbi-status-${item.state}">${statusLabel(item.state)}</td><td>${esc(item.record.workId)}</td><td>${esc(item.record.workTitle)}</td><td>${esc(item.record.writer)}</td><td>${esc(item.record.alternativeTitle)}</td><td>${esc(item.record.artist)}</td><td>${esc(item.record.versionName)}</td><td>${esc(item.record.versionType)}</td><td>${esc(item.record.isrc)}</td><td>${esc(item.record.iswc)}</td><td>${esc(item.record.upc)}</td><td>${esc(item.record.language)}</td><td>${esc(item.record.releaseDate)}</td><td>${esc(item.record.label)}</td><td>${esc(item.record.copyrightOwner)}</td><td>${esc(item.record.recordingOwner)}</td><td>${esc(item.record.status)}</td><td>${esc([...item.issues,...item.warnings,item.record.notes].filter(Boolean).join('；'))}</td></tr>`).join(''):`<tr><td colspan="19" class="finance-empty">没有记录</td></tr>`}</tbody></table></div><div style="color:var(--muted);font-size:11px;margin-top:8px">当前显示 ${Math.min(items.length,limit).toLocaleString()} / ${items.length.toLocaleString()} 行；确认时将处理全部数据。</div>`
}

function renderUpload(){
 const content=document.getElementById('songBulkImportContent');
 content.innerHTML=`${modalHead('批量导入歌曲、作品与录音版本主数据')}${stepHeader()}<div id="songBulkDrop" class="sbi-drop"><div style="font-size:34px">⇧</div><h3>拖拽歌曲库文件到这里</h3><p>适用于约 6000 首歌曲的批量导入。系统先在本机读取和检查，不会立即写入歌曲库。</p><div class="sbi-formats"><span>CSV</span><span>XLSX</span><span>XLS</span></div><button class="primary" onclick="document.getElementById('songBulkFile').click()">选择文件</button><input id="songBulkFile" type="file" accept=".csv,.xlsx,.xls" hidden></div><div class="sbi-help" style="margin-top:14px">作品按 Work ID → ISWC → Song Title + Writer → Song Title + Artist 识别；录音版本按 ISRC → Artist + Version Name 识别。不会把每一行都当成一首独立歌曲。</div>`;
 const input=document.getElementById('songBulkFile'),drop=document.getElementById('songBulkDrop');
 input.addEventListener('change',event=>handleSongBulkFile(event.target.files));
 drop.addEventListener('dragover',event=>{event.preventDefault();drop.classList.add('drag')});drop.addEventListener('dragleave',()=>drop.classList.remove('drag'));
 drop.addEventListener('drop',event=>{event.preventDefault();drop.classList.remove('drag');handleSongBulkFile(event.dataTransfer.files)})
}
function renderMapping(){
 const content=document.getElementById('songBulkImportContent'),report=bulkState.report||buildReport();
 content.innerHTML=`${modalHead('字段自动识别、验证与批量导入 · Step 2')}${stepHeader()}${fileSummary()}<div class="sbi-stats"><div class="sbi-stat"><span>文件行数</span><b>${report.total.toLocaleString()}</b></div><div class="sbi-stat"><span>候选新增录音</span><b style="color:#7be995">${report.newItems.length.toLocaleString()}</b></div><div class="sbi-stat"><span>已有数据更新</span><b style="color:#8bc7ff">${report.updates.length.toLocaleString()}</b></div><div class="sbi-stat"><span>错误／重复</span><b style="color:#ff8171">${report.failCount.toLocaleString()}</b></div><div class="sbi-stat"><span>识别字段</span><b>${report.recognized}/${fields.length}</b></div></div><div class="sbi-help">左侧为系统标准字段，右侧为文件列名。Writer 用于在没有 Work ID / ISWC 时，与 Song Title 共同识别作品。</div><div class="sbi-mapping">${fields.map(field=>`<div class="sbi-map-row"><div><b>${esc(field.label)}${field.required?' *':''}</b><small>${esc(field.description)}</small></div><select onchange="updateSongBulkMapping('${field.key}',this.value)">${mappingOptions(field)}</select></div>`).join('')}</div>${actions(1,'下一步：数据预览',3)}`
}
function renderDataPreview(){
 const report=bulkState.report=buildReport(),content=document.getElementById('songBulkImportContent');
 content.innerHTML=`${modalHead('Step 3 · 导入前数据预览')}${stepHeader()}${fileSummary()}<div class="sbi-stats"><div class="sbi-stat"><span>文件行数</span><b>${report.total.toLocaleString()}</b></div><div class="sbi-stat"><span>识别作品</span><b>${report.workCount.toLocaleString()}</b></div><div class="sbi-stat"><span>新增录音</span><b style="color:#7be995">${report.newItems.length.toLocaleString()}</b></div><div class="sbi-stat"><span>更新已有</span><b style="color:#8bc7ff">${report.updates.length.toLocaleString()}</b></div><div class="sbi-stat"><span>待处理</span><b style="color:#ff8171">${report.failCount.toLocaleString()}</b></div></div><div class="sbi-help">作品与录音版本已分层：多行可以属于同一个 Work，但每个 ISRC / 艺人版本仍是独立 Recording。</div>${renderTable(report.items,50)}${actions(2,'下一步：重复检查',4)}`
}
function renderDuplicateCheck(){
 const report=bulkState.report=buildReport(),items=[...report.updates,...report.duplicates],content=document.getElementById('songBulkImportContent');
 content.innerHTML=`${modalHead('Step 4 · 已有数据与文件内重复检查')}${stepHeader()}${fileSummary()}<div class="sbi-stats"><div class="sbi-stat"><span>已有数据更新</span><b style="color:#8bc7ff">${report.updates.length.toLocaleString()}</b></div><div class="sbi-stat"><span>文件内重复</span><b style="color:#ff8171">${report.duplicates.length.toLocaleString()}</b></div><div class="sbi-stat"><span>ISRC 匹配优先</span><b>1</b></div><div class="sbi-stat"><span>同名不同艺人</span><b>保留</b></div><div class="sbi-stat"><span>同作品多版本</span><b>归组</b></div></div><div class="sbi-help sbi-warning">已有录音不会重复新增：系统会按 ISRC 优先匹配并更新；同一个作品下，不同艺人或不同版本名称会保留为不同录音。</div>${renderTable(items,100)}${actions(3,'下一步：错误提示',5)}`
}
function renderErrorReview(){
 const report=bulkState.report=buildReport(),items=[...report.errors,...report.duplicates],content=document.getElementById('songBulkImportContent');
 content.innerHTML=`${modalHead('Step 5 · 错误行检查与单独导出')}${stepHeader()}${fileSummary()}<div class="sbi-stats"><div class="sbi-stat"><span>缺失／冲突错误</span><b style="color:#ff8171">${report.errors.length.toLocaleString()}</b></div><div class="sbi-stat"><span>文件内重复</span><b style="color:#ffc266">${report.duplicates.length.toLocaleString()}</b></div><div class="sbi-stat"><span>失败总数</span><b>${report.failCount.toLocaleString()}</b></div><div class="sbi-stat"><span>可成功处理</span><b style="color:#7be995">${report.successCount.toLocaleString()}</b></div><div class="sbi-stat"><span>错误文件</span><b>CSV</b></div></div><div class="sbi-help sbi-warning">错误行不会写入歌曲库。可以先单独导出修正，再用 Bulk Import 重新导入。</div>${renderTable(items,100)}<div class="finance-actions"><button class="ghost" onclick="goSongBulkStep(4)">上一步</button><button class="ghost" ${items.length?'':'disabled'} onclick="exportSongBulkErrors()">导出错误行 CSV</button><button class="primary" ${report.successCount?'':'disabled'} onclick="goSongBulkStep(6)">下一步：确认导入</button></div>`
}
function renderConfirm(){
 const report=bulkState.report=buildReport(),content=document.getElementById('songBulkImportContent');
 content.innerHTML=`${modalHead('Step 6 · 确认写入歌曲与版本库')}${stepHeader()}${fileSummary()}<div class="sbi-stats"><div class="sbi-stat"><span>识别作品</span><b>${report.workCount.toLocaleString()}</b></div><div class="sbi-stat"><span>新增录音版本</span><b style="color:#7be995">${report.newItems.length.toLocaleString()}</b></div><div class="sbi-stat"><span>更新已有版本</span><b style="color:#8bc7ff">${report.updates.length.toLocaleString()}</b></div><div class="sbi-stat"><span>成功处理</span><b>${report.successCount.toLocaleString()}</b></div><div class="sbi-stat"><span>失败不写入</span><b style="color:#ff8171">${report.failCount.toLocaleString()}</b></div></div><div class="sbi-help">确认后：同一作品的多个录音版本会共享 Work ID；已有录音将更新而非重复创建；错误和文件内重复行不会写入。</div>${renderTable([...report.newItems,...report.updates],50)}<div class="finance-actions"><button class="ghost" onclick="goSongBulkStep(5)">上一步</button><button class="primary" ${report.successCount?'':'disabled'} onclick="confirmSongBulkImport()">确认导入 ${report.successCount.toLocaleString()} 行</button></div>`
}
function renderResult(){
 const result=bulkState.result,content=document.getElementById('songBulkImportContent');
 const sample=(result.sample||[]).map(item=>item.workTitle).filter(Boolean).slice(0,5);
 content.innerHTML=`${modalHead('批量导入完成')}<div class="sbi-result"><div class="sbi-result-icon">✓</div><h3>歌曲库已更新</h3><p style="color:var(--muted);font-size:12px">系统已按作品与录音版本两层结构完成处理。</p><div class="sbi-stats"><div class="sbi-stat"><span>新增录音</span><b style="color:#7be995">${result.created.toLocaleString()}</b></div><div class="sbi-stat"><span>更新已有</span><b style="color:#8bc7ff">${result.updated.toLocaleString()}</b></div><div class="sbi-stat"><span>成功总数</span><b>${result.success.toLocaleString()}</b></div><div class="sbi-stat"><span>失败总数</span><b style="color:#ff8171">${result.failed.toLocaleString()}</b></div><div class="sbi-stat"><span>歌曲库录音总数</span><b>${financeRecordings.length.toLocaleString()}</b></div></div>${sample.length?`<div class="sbi-help" style="text-align:left">本次新增示例：${sample.map(esc).join('、')}</div>`:''}<button class="primary" onclick="finishSongBulkImport()">返回歌曲与版本库</button></div>`
}
function renderCurrentStep(){
 if(bulkState.result){renderResult();return}
 if(bulkStep===1)renderUpload();else if(bulkStep===2)renderMapping();else if(bulkStep===3)renderDataPreview();else if(bulkStep===4)renderDuplicateCheck();else if(bulkStep===5)renderErrorReview();else renderConfirm()
}

window.openSongBulkImport=function(){injectStyles();bulkStep=1;bulkState={fileName:'',headers:[],rows:[],mapping:{},report:null,result:null};ensureModal().classList.add('show');renderUpload()};
window.closeSongBulkImport=function(){document.getElementById('songBulkImportModal')?.classList.remove('show')};
window.resetSongBulkImport=function(){bulkStep=1;bulkState={fileName:'',headers:[],rows:[],mapping:{},report:null,result:null};renderUpload()};
window.goSongBulkStep=function(step){bulkStep=Math.max(1,Math.min(6,Number(step)||1));bulkState.report=bulkStep>=3?buildReport():null;renderCurrentStep()};
window.handleSongBulkFile=async function(files){
 const file=files?.[0];if(!file)return;
 if(!/\.(csv|xlsx|xls)$/i.test(file.name)){alert('仅支持 CSV、XLSX、XLS 文件。');return}
 if(file.size>50*1024*1024){alert('文件超过 50MB，请拆分后再导入。');return}
 try{
  showToastMessage('正在读取歌曲库文件…');const rows=await readWorkbook(file);
  if(!rows.length)throw new Error('文件中没有可识别的数据');if(rows.length>25000)throw new Error('单次最多导入 25,000 行，请拆分文件');
  const headers=Object.keys(rows[0]);bulkState={fileName:file.name,headers,rows,mapping:detectMapping(headers),report:null,result:null};bulkStep=2;renderMapping();showToastMessage(`已读取 ${rows.length.toLocaleString()} 行歌曲数据`)
 }catch(error){alert(error.message||'文件解析失败')}
};
window.updateSongBulkMapping=function(key,header){if(header)bulkState.mapping[key]=header;else delete bulkState.mapping[key];bulkState.report=null;renderMapping()};
window.exportSongBulkErrors=function(){
 const report=buildReport(),problemItems=[...report.errors,...report.duplicates];if(!problemItems.length){alert('没有需要导出的错误行。');return}
 const headers=[...bulkState.headers,'Import Status','Import Error'];
 const quote=value=>{
  let text=String(value??'');
  if(/^[=+\-@\t\r]/.test(text))text="'"+text;
  return `"${text.replace(/"/g,'""')}"`;
 };
 const lines=[headers.map(quote).join(','),...problemItems.map(item=>[...bulkState.headers.map(header=>item.sourceRow?.[header]??''),statusLabel(item.state),[...item.issues,...item.warnings].join('；')].map(quote).join(','))];
 const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download=`${bulkState.fileName.replace(/\.[^.]+$/,'')||'song-library'}-errors.csv`;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)
};
window.confirmSongBulkImport=async function(){
 const report=buildReport();if(!report.successCount){alert('没有通过验证、可以导入或更新的录音版本。');return}
 const original=financeRecordings.map(item=>({...item}));
 try{
  const updateById=new Map(report.updates.map(item=>[item.targetId,item.record]));
  const changed=report.updates.map(item=>updateById.get(item.targetId)).concat(report.newItems.map(item=>item.record));
  showToastMessage(`正在向 Supabase 写入 ${changed.length.toLocaleString()} 条歌曲数据…`);
  await window.CheerfulSupabase.saveCatalog(changed);
  await window.CheerfulSupabase.refreshCatalog();
  bulkState.report=report;bulkState.result={created:report.newItems.length,updated:report.updates.length,success:report.successCount,failed:report.failCount,sample:report.newItems.slice(0,5).map(item=>item.record)};renderResult();showToastMessage(`成功处理 ${report.successCount.toLocaleString()} 行歌曲数据`)
 }catch(error){
  financeRecordings=original;alert(`Supabase 导入失败，未修改数据库：${error.message||'未知错误'}`)
 }
};
window.finishSongBulkImport=function(){closeSongBulkImport();financeTab='catalog';openSection('finance')};

injectStyles();installEntry();
})();
