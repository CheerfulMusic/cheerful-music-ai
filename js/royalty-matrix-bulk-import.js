console.log("Cheerful Royalty Matrix Bulk Import Loaded");
(function(){
"use strict";

const SCHEMA_VERSION="royalty-rule-v1";
const HISTORY_KEY="cm_royalty_matrix_import_history_v133";
const REVIEW_KEY="cm_royalty_matrix_review_queue_v133";
const roles=["Artist","Featured Artist","Lyricist","Composer","Producer","Publisher","Label","Recording Owner","Copyright Owner"];
const royaltyTypes=["Recording Royalty","Publishing Royalty","Artist Royalty","Producer Royalty","Platform Revenue Share","Other"];
const steps=["上传文件","字段映射","数据预览","歌曲匹配","规则校验","重复处理","导入结果"];
const fields=[
 {key:"songTitle",label:"Song Title",description:"歌曲名称",aliases:["song title","songtitle","title","歌曲名称","歌曲","歌名","作品名"]},
 {key:"workId",label:"Work ID",description:"作品唯一编号",aliases:["work id","workid","作品id","作品编号","作品唯一编号"]},
 {key:"isrc",label:"ISRC",description:"录音唯一编码",aliases:["isrc","recording code","录音编码","录音唯一编码"]},
 {key:"versionName",label:"Version Name",description:"版本名称",aliases:["version name","version","版本名称","版本"]},
 {key:"artistName",label:"Artist Name",description:"艺人名称",aliases:["artist name","artist","performer","艺人名称","艺人","演唱者","歌手"]},
 {key:"payeeName",label:"Payee Name",description:"收款方名称",required:true,aliases:["payee name","payee","beneficiary","收款方名称","收款方","权利人"]},
 {key:"role",label:"Role",description:"角色",required:true,aliases:["role","party role","角色","身份"]},
 {key:"royaltyType",label:"Royalty Type",description:"分成类型",required:true,aliases:["royalty type","royaltytype","type","分成类型","版税类型","权利类型"]},
 {key:"sharePercentage",label:"Share Percentage",description:"分成比例",required:true,aliases:["share percentage","share","percentage","royalty rate","split","分成比例","比例","版税比例"]},
 {key:"effectiveDate",label:"Effective Date",description:"生效日期",required:true,aliases:["effective date","start date","startdate","生效日期","开始日期","起始日期"]},
 {key:"endDate",label:"End Date",description:"结束日期",aliases:["end date","enddate","expiry date","结束日期","终止日期","到期日期"]},
 {key:"territory",label:"Territory",description:"地区",aliases:["territory","region","country","地区","区域","国家"]},
 {key:"platform",label:"Platform",description:"平台",aliases:["platform","dsp","service","平台","流媒体平台","渠道"]},
 {key:"currency",label:"Currency",description:"币种",aliases:["currency","currency code","币种","货币"]},
 {key:"notes",label:"Notes",description:"备注",aliases:["notes","note","remarks","comment","备注","说明"]}
];

let matrixStep=1;
let matrixState=emptyState();
let matrixDecisions={};

function emptyState(){
 return{fileName:"",fileSize:0,headers:[],rows:[],mapping:{},report:null,result:null,batchId:""};
}
function esc(value){
 return String(value==null?"":value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function norm(value){
 return String(value==null?"":value).toLowerCase().normalize("NFKC").replace(/[^a-z0-9\u3400-\u9fff]+/g,"");
}
function normISRC(value){
 return String(value==null?"":value).toUpperCase().replace(/[^A-Z0-9]/g,"");
}
function safeJSON(key,fallback){
 try{return JSON.parse(localStorage.getItem(key)||"null")||fallback}catch(_){return fallback}
}
function saveJSON(key,value){
 localStorage.setItem(key,JSON.stringify(value));
}
function fileSizeLabel(size){
 if(size<1024)return size+" B";
 if(size<1024*1024)return(size/1024).toFixed(1)+" KB";
 return(size/1024/1024).toFixed(1)+" MB";
}
function valueFor(row,key){
 const header=matrixState.mapping[key];
 return header?row[header]:"";
}
function dateValue(value){
 if(value===null||value===undefined||value==="")return"";
 if(typeof value==="number"&&window.XLSX&&XLSX.SSF&&XLSX.SSF.parse_date_code){
  const parsed=XLSX.SSF.parse_date_code(value);
  if(parsed)return String(parsed.y).padStart(4,"0")+"-"+String(parsed.m).padStart(2,"0")+"-"+String(parsed.d).padStart(2,"0");
 }
 const text=String(value).trim();
 const match=text.match(/^(\d{4})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})/);
 if(match)return match[1]+"-"+String(Number(match[2])).padStart(2,"0")+"-"+String(Number(match[3])).padStart(2,"0");
 const parsed=new Date(text);
 return Number.isNaN(parsed.getTime())?"":parsed.toISOString().slice(0,10);
}
function shareValue(value){
 const number=Number(String(value==null?"":value).replace(/[%％,\s]/g,""));
 return Number.isFinite(number)?number:NaN;
}
function canonicalRole(value){
 const key=norm(value);
 const map={
  artist:"Artist",艺人:"Artist",主演艺人:"Artist",
  featuredartist:"Featured Artist",featured:"Featured Artist",featuring:"Featured Artist",客演艺人:"Featured Artist",合作艺人:"Featured Artist",
  lyricist:"Lyricist",writer:"Lyricist",词作者:"Lyricist",作词:"Lyricist",
  composer:"Composer",曲作者:"Composer",作曲:"Composer",
  producer:"Producer",制作人:"Producer",
  publisher:"Publisher",出版商:"Publisher",版权代理:"Publisher",
  label:"Label",厂牌:"Label",唱片公司:"Label",
  recordingowner:"Recording Owner",masterowner:"Recording Owner",录音权方:"Recording Owner",录音版权方:"Recording Owner",
  copyrightowner:"Copyright Owner",版权方:"Copyright Owner",版权所有者:"Copyright Owner"
 };
 return map[key]||roles.find(item=>norm(item)===key)||"";
}
function canonicalRoyaltyType(value){
 const key=norm(value);
 const map={
  recordingroyalty:"Recording Royalty",录音版税:"Recording Royalty",录音分成:"Recording Royalty",
  publishingroyalty:"Publishing Royalty",词曲版税:"Publishing Royalty",出版版税:"Publishing Royalty",
  artistroyalty:"Artist Royalty",艺人版税:"Artist Royalty",艺人分成:"Artist Royalty",
  producerroyalty:"Producer Royalty",制作人版税:"Producer Royalty",制作人分成:"Producer Royalty",
  platformrevenueshare:"Platform Revenue Share",平台收入分成:"Platform Revenue Share",平台分成:"Platform Revenue Share",
  other:"Other",其他:"Other"
 };
 return map[key]||royaltyTypes.find(item=>norm(item)===key)||"";
}
function detectMapping(headers){
 const mapping={};
 fields.forEach(function(field){
  const aliasSet=field.aliases.map(norm);
  const exact=headers.find(function(header){return aliasSet.includes(norm(header))});
  if(exact)mapping[field.key]=exact;
 });
 return mapping;
}
function parseRows(file){
 return file.arrayBuffer().then(function(buffer){
  if(!window.XLSX)throw new Error("Excel 解析组件尚未加载，请刷新页面后重试。");
  const isCSV=/\.csv$/i.test(file.name||"");
  const input=isCSV?new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/,""):buffer;
  const workbook=XLSX.read(input,{type:isCSV?"string":"array",cellDates:false});
  const sheet=workbook.Sheets[workbook.SheetNames[0]];
  if(!sheet)return[];
  return XLSX.utils.sheet_to_json(sheet,{defval:"",raw:true});
 });
}
function rowValues(row,index){
 return{
  rowNumber:index+2,
  songTitle:String(valueFor(row,"songTitle")||"").trim(),
  workId:String(valueFor(row,"workId")||"").trim(),
  isrc:String(valueFor(row,"isrc")||"").trim().toUpperCase(),
  versionName:String(valueFor(row,"versionName")||"").trim(),
  artistName:String(valueFor(row,"artistName")||"").trim(),
  payeeName:String(valueFor(row,"payeeName")||"").trim(),
  role:canonicalRole(valueFor(row,"role")),
  rawRole:String(valueFor(row,"role")||"").trim(),
  royaltyType:canonicalRoyaltyType(valueFor(row,"royaltyType")),
  rawRoyaltyType:String(valueFor(row,"royaltyType")||"").trim(),
  sharePercentage:shareValue(valueFor(row,"sharePercentage")),
  effectiveDate:dateValue(valueFor(row,"effectiveDate")),
  endDate:dateValue(valueFor(row,"endDate")),
  territory:String(valueFor(row,"territory")||"").trim()||"Global",
  platform:String(valueFor(row,"platform")||"").trim()||"All Platforms",
  currency:String(valueFor(row,"currency")||"").trim().toUpperCase()||"—",
  notes:String(valueFor(row,"notes")||"").trim(),
  sourceRow:row
 };
}
function narrowCandidates(candidates,values){
 let result=candidates.slice();
 if(values.artistName){
  const artistMatches=result.filter(function(recording){return norm(recording.artist)===norm(values.artistName)});
  if(artistMatches.length)result=artistMatches;
 }
 if(values.versionName){
  const versionMatches=result.filter(function(recording){return norm(recording.versionName)===norm(values.versionName)});
  if(versionMatches.length)result=versionMatches;
 }
 return result;
}
function addIndex(map,key,recording){
 if(!key)return;
 if(!map.has(key))map.set(key,[]);
 map.get(key).push(recording);
}
function recordingIndexes(){
 const indexes={isrc:new Map(),workId:new Map(),titleArtist:new Map(),titleVersion:new Map()};
 financeRecordings.forEach(function(recording){
  addIndex(indexes.isrc,normISRC(recording.isrc),recording);
  addIndex(indexes.workId,norm(recording.workId),recording);
  addIndex(indexes.titleArtist,norm(recording.workTitle)+"|"+norm(recording.artist),recording);
  addIndex(indexes.titleVersion,norm(recording.workTitle)+"|"+norm(recording.versionName),recording);
 });
 return indexes;
}
function resolveCandidates(candidates,method,values){
 const narrowed=narrowCandidates(candidates,values);
 if(narrowed.length===1)return{status:"matched",recording:narrowed[0],method:method,reason:method+"匹配"};
 if(narrowed.length>1)return{status:"review",recording:null,method:method,reason:method+"匹配到多个录音版本"};
 return{status:"review",recording:null,method:method,reason:method+"没有匹配到歌曲库"};
}
function matchRecording(values,indexes){
 if(values.isrc){
  const matches=indexes.isrc.get(normISRC(values.isrc))||[];
  if(matches.length===1)return{status:"matched",recording:matches[0],method:"ISRC",reason:"ISRC 精确匹配"};
  return{status:"review",recording:null,method:"ISRC",reason:matches.length>1?"ISRC 匹配到多个录音":"ISRC 在歌曲库中不存在"};
 }
 if(values.workId){
  const matches=indexes.workId.get(norm(values.workId))||[];
  if(matches.length)return resolveCandidates(matches,"Work ID",values);
 }
 if(values.songTitle&&values.artistName){
  const matches=indexes.titleArtist.get(norm(values.songTitle)+"|"+norm(values.artistName))||[];
  if(matches.length)return resolveCandidates(matches,"Song Title + Artist Name",values);
 }
 if(values.songTitle&&values.versionName){
  const matches=indexes.titleVersion.get(norm(values.songTitle)+"|"+norm(values.versionName))||[];
  if(matches.length)return resolveCandidates(matches,"Song Title + Version Name",values);
 }
 return{status:"review",recording:null,method:"",reason:"无法按 ISRC、Work ID、歌名+艺人或歌名+版本匹配"};
}
function periodsOverlap(a,b){
 const aStart=a.startDate||"0000-01-01",aEnd=a.endDate||"9999-12-31";
 const bStart=b.startDate||"0000-01-01",bEnd=b.endDate||"9999-12-31";
 return aStart<=bEnd&&bStart<=aEnd;
}
function normalizedExisting(rule){
 const recording=financeRecordings.find(function(item){return item.id===rule.recordingId})||{};
 return{
  id:rule.id,
  recordingId:rule.recordingId,
  workId:rule.workId||recording.workId||"",
  isrc:rule.isrc||recording.isrc||"",
  versionName:rule.versionName||recording.versionName||"",
  artistName:rule.artistName||recording.artist||"",
  payeeName:rule.payeeName||rule.payee||"",
  role:rule.role||"Artist",
  royaltyType:rule.royaltyType||"Artist Royalty",
  sharePercentage:Number(rule.sharePercentage==null?rule.percentage:rule.sharePercentage),
  startDate:rule.effectiveDate||rule.startDate||"",
  endDate:rule.endDate||"",
  territory:rule.territory||"Global",
  platform:rule.platform||"All Platforms",
  currency:rule.currency||"—",
  notes:rule.notes||""
 };
}
function coreKey(rule){
 return[
  rule.recordingId,norm(rule.payeeName),norm(rule.royaltyType),rule.startDate||"",rule.endDate||""
 ].join("|");
}
function exactKey(rule){
 return[
  coreKey(rule),Number(rule.sharePercentage).toFixed(6),norm(rule.role),norm(rule.territory),norm(rule.platform),norm(rule.currency),norm(rule.notes)
 ].join("|");
}
function ruleRecord(item,id){
 const values=item.values,recording=item.match.recording;
 return{
  id:id,
  schemaVersion:SCHEMA_VERSION,
  workId:recording.workId||values.workId||"",
  recordingId:recording.id,
  isrc:recording.isrc||values.isrc||"",
  versionName:recording.versionName||values.versionName||"",
  artistName:recording.artist||values.artistName||"",
  payee:values.payeeName,
  payeeName:values.payeeName,
  role:values.role,
  royaltyType:values.royaltyType,
  percentage:values.sharePercentage,
  sharePercentage:values.sharePercentage,
  basis:"净收入 Net Receipts",
  startDate:values.effectiveDate,
  effectiveDate:values.effectiveDate,
  endDate:values.endDate,
  territory:values.territory,
  platform:values.platform,
  currency:values.currency,
  notes:values.notes,
  contractNo:"",
  source:"royalty-matrix-bulk-import",
  importBatchId:matrixState.batchId
 };
}
function baseIssues(values,match){
 const issues=[];
 if(!values.payeeName)issues.push("Payee Name 为空");
 if(!values.rawRole)issues.push("Role 为空");
 else if(!values.role)issues.push("Role 无效");
 if(!values.rawRoyaltyType)issues.push("Royalty Type 为空");
 else if(!values.royaltyType)issues.push("Royalty Type 无效");
 if(!Number.isFinite(values.sharePercentage))issues.push("Share Percentage 不是数字");
 else if(values.sharePercentage<0||values.sharePercentage>100)issues.push("Share Percentage 必须在 0–100 之间");
 if(!values.effectiveDate)issues.push("Effective Date 为空或格式错误");
 if(valueFor(values.sourceRow,"endDate")&&!values.endDate)issues.push("End Date 格式错误");
 if(values.effectiveDate&&values.endDate&&values.effectiveDate>values.endDate)issues.push("Effective Date 晚于 End Date");
 if(match.status!=="matched")issues.push(match.reason);
 if(match.status==="matched"&&!match.recording.isrc)issues.push("歌曲库中的 ISRC 为空");
 return issues;
}
function buildReport(){
 const existing=financeRules.map(normalizedExisting);
 const indexes=recordingIndexes();
 const items=matrixState.rows.map(function(row,index){
  const values=rowValues(row,index),match=matchRecording(values,indexes),issues=baseIssues(values,match);
  const item={rowNumber:index+2,values:values,match:match,issues:issues,warnings:[],duplicateType:"",targetId:"",defaultAction:"create",action:"create"};
  if(match.status==="matched"&&!issues.length){
   const candidate=ruleRecord(item,"");
   const sameCore=existing.filter(function(rule){return coreKey(rule)===coreKey(candidate)});
   if(sameCore.length===1){
    item.targetId=sameCore[0].id;
    if(exactKey(sameCore[0])===exactKey(candidate)){
     item.duplicateType="exact";
     item.defaultAction="skip";
    }else{
     item.duplicateType="changed";
     item.defaultAction="update";
    }
   }else if(sameCore.length>1){
    item.duplicateType="ambiguous";
    item.defaultAction="review";
    item.issues.push("已有多条相同主键规则，无法自动确认更新目标");
   }
  }else if(match.status!=="matched"){
   item.defaultAction="review";
  }
  item.action=matrixDecisions[item.rowNumber]||item.defaultAction;
  return item;
 });

 const seen=new Map();
 items.forEach(function(item){
  if(item.match.status!=="matched"||item.issues.length)return;
  const candidate=ruleRecord(item,""),key=coreKey(candidate);
  if(!seen.has(key)){seen.set(key,item);return}
  const previous=seen.get(key);
  if(exactKey(ruleRecord(previous,""))===exactKey(candidate)){
   item.duplicateType="file-exact";
   item.defaultAction="skip";
   item.action=matrixDecisions[item.rowNumber]||"skip";
  }else{
   item.duplicateType="file-conflict";
   item.defaultAction="review";
   item.action=matrixDecisions[item.rowNumber]||"review";
   item.issues.push("文件内相同歌曲、收款方、类型和有效期存在冲突规则");
  }
 });

 const updateIds=new Set(items.filter(function(item){return item.action==="update"&&item.targetId&&!item.issues.length}).map(function(item){return item.targetId}));
 const proposed=items.filter(function(item){return(item.action==="create"||item.action==="update")&&item.match.status==="matched"&&!item.issues.length}).map(function(item){
  return ruleRecord(item,item.targetId||"incoming-"+item.rowNumber);
 });
 const activeBase=existing.filter(function(rule){return!updateIds.has(rule.id)});
 const combined=activeBase.concat(proposed);
 proposed.forEach(function(rule){
  const total=combined.filter(function(other){
   return other.recordingId===rule.recordingId&&norm(other.royaltyType)===norm(rule.royaltyType)&&periodsOverlap(other,rule);
  }).reduce(function(sum,other){return sum+Number(other.sharePercentage||0)},0);
  if(total>100.000001){
   const item=items.find(function(candidate){return candidate.rowNumber===Number(String(rule.id).replace("incoming-",""))})||
    items.find(function(candidate){return candidate.targetId===rule.id&&candidate.action==="update"});
   if(item)item.issues.push("同一歌曲、Royalty Type 和重叠有效期的总分成超过 100%（"+total.toFixed(2)+"%）");
  }
 });

 const reviewItems=items.filter(function(item){return item.action==="review"||item.match.status!=="matched"||item.duplicateType==="ambiguous"||item.duplicateType==="file-conflict"});
 const failedItems=items.filter(function(item){return item.issues.length&&!reviewItems.includes(item)});
 const skippedItems=items.filter(function(item){return item.action==="skip"&&!item.issues.length});
 const updatedItems=items.filter(function(item){return item.action==="update"&&!item.issues.length&&item.targetId});
 const importedItems=items.filter(function(item){return item.action==="create"&&!item.issues.length&&item.match.status==="matched"});
 const duplicateItems=items.filter(function(item){return Boolean(item.duplicateType)});
 const missingCount=items.filter(function(item){return item.issues.some(function(issue){return /为空|不存在/.test(issue)})}).length;
 return{
  items:items,
  importedItems:importedItems,
  updatedItems:updatedItems,
  skippedItems:skippedItems,
  failedItems:failedItems,
  reviewItems:reviewItems,
  duplicateItems:duplicateItems,
  missingCount:missingCount,
  total:items.length,
  canImport:importedItems.length+updatedItems.length,
  matched:items.filter(function(item){return item.match.status==="matched"}).length
 };
}
function injectStyles(){
 if(document.getElementById("royaltyMatrixBulkStyles"))return;
 const style=document.createElement("style");
 style.id="royaltyMatrixBulkStyles";
 style.textContent=[
  ".rmbi-header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:4px 0 18px}.rmbi-header h3{margin:0;font-size:20px}.rmbi-header p{margin:7px 0 0;color:var(--muted);font-size:12px;line-height:1.6}",
  ".rmbi-entry-actions{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.rmbi-history{margin-top:18px;padding-top:18px;border-top:1px solid var(--line)}.rmbi-history-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.rmbi-history-head h4{margin:0}",
  ".rmbi-modal{width:min(1240px,100%)}.rmbi-steps{display:grid;grid-template-columns:repeat(7,1fr);gap:7px;margin-bottom:18px}.rmbi-step{display:flex;align-items:center;gap:7px;padding:9px;border:1px solid var(--line);border-radius:12px;color:var(--muted);background:#0e1014;font-size:10px;min-width:0}.rmbi-step span{width:24px;height:24px;flex:0 0 24px;border-radius:8px;background:#24272e;display:grid;place-items:center}.rmbi-step.active{border-color:rgba(249,56,34,.42);background:rgba(249,56,34,.08);color:#ff8a7b}.rmbi-step.active span{background:var(--red);color:#fff}.rmbi-step.done{color:#7be995}.rmbi-step.done span{background:#1d6a34;color:#fff}",
  ".rmbi-drop{padding:46px 22px;border:1px dashed #434751;border-radius:16px;background:#0c0e12;text-align:center}.rmbi-drop.drag{border-color:var(--red);background:rgba(249,56,34,.08)}.rmbi-drop h3{margin:12px 0 7px}.rmbi-drop p{margin:0;color:var(--muted);font-size:12px}.rmbi-formats{display:flex;justify-content:center;gap:8px;margin:17px 0}.rmbi-formats span{padding:6px 9px;border-radius:999px;background:#24272e;color:#c9ccd3;font-size:10px}",
  ".rmbi-file{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin:14px 0}.rmbi-stat{padding:13px;border:1px solid var(--line);border-radius:13px;background:#0e1014}.rmbi-stat span{display:block;color:var(--muted);font-size:10px}.rmbi-stat b{display:block;margin-top:7px;font-size:18px;word-break:break-word}.rmbi-summary{display:grid;grid-template-columns:repeat(5,1fr);gap:9px;margin:14px 0}",
  ".rmbi-mapping{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;max-height:470px;overflow:auto}.rmbi-map{display:grid;grid-template-columns:minmax(145px,.8fr) minmax(170px,1fr);gap:10px;align-items:center;padding:11px;border:1px solid var(--line);border-radius:12px;background:#0e1014}.rmbi-map b{font-size:12px}.rmbi-map small{display:block;margin-top:4px;color:var(--muted)}.rmbi-map select,.rmbi-action-select{height:38px;border:1px solid var(--line);border-radius:10px;background:#0d0f13;color:#fff;padding:0 9px;width:100%}",
  ".rmbi-info{padding:12px 14px;border:1px solid rgba(10,132,255,.25);border-radius:12px;background:rgba(10,132,255,.08);color:#b8d9ff;font-size:11px;line-height:1.6;margin:12px 0}.rmbi-warning{border-color:rgba(255,174,56,.28);background:rgba(255,174,56,.08);color:#ffd39a}",
  ".rmbi-table{max-height:390px;overflow:auto;border:1px solid var(--line);border-radius:14px}.rmbi-table table{width:100%;min-width:1750px;border-collapse:collapse}.rmbi-table th,.rmbi-table td{padding:10px 11px;border-bottom:1px solid var(--line);text-align:left;font-size:10px;white-space:nowrap}.rmbi-table th{position:sticky;top:0;background:#0e1014;color:var(--muted);z-index:1}.rmbi-table td{background:#111317}.rmbi-ok{color:#7be995}.rmbi-review{color:#ffc266}.rmbi-error{color:#ff8171}.rmbi-result{padding:35px 20px;text-align:center;border:1px solid var(--line);border-radius:16px;background:#0e1014}.rmbi-result-icon{width:56px;height:56px;margin:0 auto 14px;border-radius:18px;background:#1d6a34;display:grid;place-items:center;font-size:26px}",
  "@media(max-width:1050px){.rmbi-steps{grid-template-columns:repeat(4,1fr)}.rmbi-summary{grid-template-columns:repeat(2,1fr)}}@media(max-width:820px){.rmbi-mapping,.rmbi-file{grid-template-columns:1fr}.rmbi-map{grid-template-columns:1fr}.rmbi-steps{grid-template-columns:repeat(2,1fr)}.rmbi-entry-actions{width:100%}}"
 ].join("");
 document.head.appendChild(style);
}
function installEntry(){
 const original=window.renderRuleManager;
 if(typeof original!=="function"||original.__royaltyMatrixWrapped)return;
 const wrapped=function(){
  let html=original();
  html=html.replace(
   '<button class="primary" onclick="openFinanceModal(\'rule\')">新增分成规则</button>',
   '<div class="rmbi-entry-actions"><button class="ghost" onclick="openRoyaltyMatrixBulkImport()">批量导入版税规则</button><button class="primary" onclick="openFinanceModal(\'rule\')">新增单条分成规则</button></div>'
  );
  return'<div class="rmbi-header"><div><h3>Royalty Matrix（版税规则）</h3><p>每条规则关联作品、录音版本、收款方、角色、版税类型、比例和有效期，可供后续计算、结算单与数据库复用。</p></div></div>'+html+renderHistory();
 };
 wrapped.__royaltyMatrixWrapped=true;
 window.renderRuleManager=wrapped;
}
function renderHistory(){
 const history=safeJSON(HISTORY_KEY,[]);
 return'<div class="rmbi-history"><div class="rmbi-history-head"><h4>Import History</h4><span class="badge">'+history.length+' 个批次</span></div>'+
  '<div class="finance-table-wrap"><table class="finance-table"><thead><tr><th>批次</th><th>文件</th><th>总行数</th><th>Imported</th><th>Updated</th><th>Skipped</th><th>Failed</th><th>Needs Review</th><th>导入时间</th></tr></thead><tbody>'+
  (history.length?history.slice(0,20).map(function(item){
   return'<tr><td>'+esc(item.id)+'</td><td>'+esc(item.fileName)+'</td><td>'+item.total+'</td><td>'+item.imported+'</td><td>'+item.updated+'</td><td>'+item.skipped+'</td><td>'+item.failed+'</td><td>'+item.needsReview+'</td><td>'+esc(item.createdAt)+'</td></tr>';
  }).join(""):'<tr><td colspan="9" class="finance-empty">尚无批量导入记录</td></tr>')+
  '</tbody></table></div></div>';
}
function ensureModal(){
 let backdrop=document.getElementById("royaltyMatrixBulkModal");
 if(backdrop)return backdrop;
 backdrop=document.createElement("div");
 backdrop.id="royaltyMatrixBulkModal";
 backdrop.className="finance-modal-backdrop";
 backdrop.addEventListener("click",function(event){if(event.target===backdrop)closeRoyaltyMatrixBulkImport()});
 backdrop.innerHTML='<div class="finance-modal rmbi-modal" id="royaltyMatrixBulkContent"></div>';
 document.body.appendChild(backdrop);
 return backdrop;
}
function modalHead(subtitle){
 return'<div class="finance-modal-head"><div><h3>Royalty Matrix Bulk Import</h3><div style="color:var(--muted);font-size:12px;margin-top:5px">'+esc(subtitle)+'</div></div><button class="finance-close" onclick="closeRoyaltyMatrixBulkImport()">×</button></div>';
}
function stepHeader(){
 return'<div class="rmbi-steps">'+steps.map(function(label,index){
  const number=index+1;
  return'<div class="rmbi-step '+(matrixStep===number?"active":matrixStep>number?"done":"")+'"><span>'+(matrixStep>number?"✓":number)+'</span><b>'+label+'</b></div>';
 }).join("")+'</div>';
}
function fileStats(){
 return'<div class="rmbi-file"><div class="rmbi-stat"><span>文件名</span><b>'+esc(matrixState.fileName||"—")+'</b></div><div class="rmbi-stat"><span>文件大小</span><b>'+fileSizeLabel(matrixState.fileSize||0)+'</b></div><div class="rmbi-stat"><span>总行数</span><b>'+matrixState.rows.length.toLocaleString()+'</b></div><div class="rmbi-stat"><span>表头数量</span><b>'+matrixState.headers.length.toLocaleString()+'</b></div></div>';
}
function summary(report){
 return'<div class="rmbi-summary"><div class="rmbi-stat"><span>总记录数</span><b>'+report.total.toLocaleString()+'</b></div><div class="rmbi-stat"><span>可导入数量</span><b class="rmbi-ok">'+report.canImport.toLocaleString()+'</b></div><div class="rmbi-stat"><span>错误数量</span><b class="rmbi-error">'+report.failedItems.length.toLocaleString()+'</b></div><div class="rmbi-stat"><span>重复数量</span><b class="rmbi-review">'+report.duplicateItems.length.toLocaleString()+'</b></div><div class="rmbi-stat"><span>缺失字段数量</span><b>'+report.missingCount.toLocaleString()+'</b></div></div>';
}
function mappingOptions(field){
 return'<option value="">不导入</option>'+matrixState.headers.map(function(header){
  return'<option value="'+esc(header)+'" '+(matrixState.mapping[field.key]===header?"selected":"")+'>'+esc(header)+'</option>';
 }).join("");
}
function statusFor(item){
 if(item.issues.length)return item.action==="review"||item.match.status!=="matched"?["Needs Review","rmbi-review"]:["Failed","rmbi-error"];
 if(item.action==="skip")return["Skipped","rmbi-review"];
 if(item.action==="update")return["Updated","rmbi-ok"];
 return["Imported","rmbi-ok"];
}
function table(items,limit,showAction){
 const display=items.slice(0,limit);
 return'<div class="rmbi-table"><table><thead><tr><th>原始行</th><th>状态</th><th>匹配方式</th><th>Song Title</th><th>Work ID</th><th>ISRC</th><th>Version</th><th>Artist</th><th>Payee</th><th>Role</th><th>Royalty Type</th><th>Share %</th><th>Effective</th><th>End</th><th>Territory</th><th>Platform</th><th>Currency</th><th>问题</th>'+(showAction?"<th>重复处理</th>":"")+'</tr></thead><tbody>'+
  (display.length?display.map(function(item){
   const status=statusFor(item),v=item.values;
   const action=showAction&&item.duplicateType?'<select class="rmbi-action-select" onchange="setRoyaltyMatrixDecision('+item.rowNumber+',this.value)"><option value="skip" '+(item.action==="skip"?"selected":"")+'>Skip</option><option value="update" '+(item.action==="update"?"selected":"")+'>Update Existing</option><option value="create" '+(item.action==="create"?"selected":"")+'>Create New</option><option value="review" '+(item.action==="review"?"selected":"")+'>Review Queue</option></select>':showAction?"—":"";
   return'<tr><td>'+item.rowNumber+'</td><td class="'+status[1]+'">'+status[0]+'</td><td>'+esc(item.match.method||"—")+'</td><td>'+esc(v.songTitle)+'</td><td>'+esc(v.workId)+'</td><td>'+esc(v.isrc||item.match.recording&&item.match.recording.isrc||"")+'</td><td>'+esc(v.versionName)+'</td><td>'+esc(v.artistName)+'</td><td>'+esc(v.payeeName)+'</td><td>'+esc(v.role||v.rawRole)+'</td><td>'+esc(v.royaltyType||v.rawRoyaltyType)+'</td><td>'+esc(Number.isFinite(v.sharePercentage)?v.sharePercentage:"")+'</td><td>'+esc(v.effectiveDate)+'</td><td>'+esc(v.endDate)+'</td><td>'+esc(v.territory)+'</td><td>'+esc(v.platform)+'</td><td>'+esc(v.currency)+'</td><td>'+esc(item.issues.join("；"))+'</td>'+(showAction?"<td>"+action+"</td>":"")+'</tr>';
  }).join(""):'<tr><td colspan="'+(showAction?19:18)+'" class="finance-empty">没有记录</td></tr>')+
  '</tbody></table></div><div style="color:var(--muted);font-size:11px;margin-top:8px">显示 '+Math.min(items.length,limit)+' / '+items.length+' 行</div>';
}
function actions(back,label,next,disabled){
 return'<div class="finance-actions"><button class="ghost" onclick="goRoyaltyMatrixStep('+back+')">上一步</button><button class="primary" '+(disabled?"disabled":"")+' onclick="goRoyaltyMatrixStep('+next+')">'+esc(label)+'</button></div>';
}
function renderUpload(){
 const content=document.getElementById("royaltyMatrixBulkContent");
 const selected=matrixState.rows.length?fileStats()+'<div class="finance-actions"><button class="ghost" onclick="resetRoyaltyMatrixBulkImport()">重新选择文件</button><button class="primary" onclick="goRoyaltyMatrixStep(2)">下一步：字段映射</button></div>':"";
 content.innerHTML=modalHead("Step 1 · 上传 CSV / XLSX / XLS")+stepHeader()+
  '<div id="royaltyMatrixDrop" class="rmbi-drop"><div style="font-size:34px">⇧</div><h3>拖拽版税规则表到这里</h3><p>支持 CSV、XLSX、XLS；文件会先在本机解析、匹配和校验。</p><div class="rmbi-formats"><span>CSV</span><span>XLSX</span><span>XLS</span></div><button class="primary" onclick="document.getElementById(\'royaltyMatrixFile\').click()">选择文件</button><input id="royaltyMatrixFile" type="file" accept=".csv,.xlsx,.xls" hidden></div>'+selected;
 const input=document.getElementById("royaltyMatrixFile"),drop=document.getElementById("royaltyMatrixDrop");
 input.addEventListener("change",function(event){handleRoyaltyMatrixFile(event.target.files)});
 drop.addEventListener("dragover",function(event){event.preventDefault();drop.classList.add("drag")});
 drop.addEventListener("dragleave",function(){drop.classList.remove("drag")});
 drop.addEventListener("drop",function(event){event.preventDefault();drop.classList.remove("drag");handleRoyaltyMatrixFile(event.dataTransfer.files)});
}
function renderMapping(){
 const content=document.getElementById("royaltyMatrixBulkContent");
 content.innerHTML=modalHead("Step 2 · 自动识别中英文表头，可手动调整")+stepHeader()+fileStats()+
  '<div class="rmbi-info">系统标准字段在左，文件列名在右。歌曲将按 ISRC → Work ID → Song Title + Artist Name → Song Title + Version Name 的顺序匹配。</div><div class="rmbi-mapping">'+
  fields.map(function(field){return'<div class="rmbi-map"><div><b>'+field.label+(field.required?" *":"")+'</b><small>'+field.description+'</small></div><select onchange="setRoyaltyMatrixMapping(\''+field.key+'\',this.value)">'+mappingOptions(field)+'</select></div>';}).join("")+
  '</div>'+actions(1,"下一步：数据预览",3,false);
}
function renderPreview(){
 const report=matrixState.report=buildReport(),content=document.getElementById("royaltyMatrixBulkContent");
 content.innerHTML=modalHead("Step 3 · 显示前 20 行")+stepHeader()+fileStats()+summary(report)+table(report.items,20,false)+actions(2,"下一步：歌曲匹配",4,false);
}
function renderMatching(){
 const report=matrixState.report=buildReport(),content=document.getElementById("royaltyMatrixBulkContent");
 content.innerHTML=modalHead("Step 4 · 关联 Song Library 与 Recording")+stepHeader()+summary(report)+
  '<div class="rmbi-info">匹配成功 '+report.matched+' 行；未匹配或多结果行进入 Review Queue，不会创建错误歌曲记录。</div>'+table(report.items,100,false)+actions(3,"下一步：规则校验",5,false);
}
function renderValidation(){
 const report=matrixState.report=buildReport(),content=document.getElementById("royaltyMatrixBulkContent");
 content.innerHTML=modalHead("Step 5 · 比例、日期、角色、ISRC 与总分成校验")+stepHeader()+summary(report)+
  '<div class="rmbi-info rmbi-warning">校验包含：比例 0–100、有效期、Payee、Role、Royalty Type、ISRC、重复规则，以及同歌曲同类型重叠有效期总分成不超过 100%。</div>'+
  table(report.items,100,false)+actions(4,"下一步：重复处理",6,false);
}
function renderDuplicateReview(){
 const report=matrixState.report=buildReport(),content=document.getElementById("royaltyMatrixBulkContent");
 const review=report.reviewItems;
 content.innerHTML=modalHead("Step 6 · Duplicate Detection 与 Review Queue")+stepHeader()+summary(report)+
  '<div class="rmbi-info">默认：完全相同规则 Skip；同歌曲、收款方、类型和有效期但比例不同 Update Existing；无法确认进入 Review Queue。</div>'+
  '<h4>重复规则处理</h4>'+table(report.duplicateItems,100,true)+
  '<h4 style="margin-top:18px">Review Queue</h4>'+table(review,100,false)+
  '<div class="finance-actions"><button class="ghost" onclick="goRoyaltyMatrixStep(5)">上一步</button><button class="ghost" onclick="exportRoyaltyMatrixErrors()">下载错误行 CSV</button><button class="primary" onclick="confirmRoyaltyMatrixImport()">确认导入</button></div>';
}
function renderResult(){
 const result=matrixState.result,content=document.getElementById("royaltyMatrixBulkContent");
 content.innerHTML=modalHead("Step 7 · 导入结果")+stepHeader()+
  '<div class="rmbi-result"><div class="rmbi-result-icon">✓</div><h3>Royalty Matrix 已处理完成</h3><div class="rmbi-summary"><div class="rmbi-stat"><span>Imported</span><b class="rmbi-ok">'+result.imported+'</b></div><div class="rmbi-stat"><span>Updated</span><b class="rmbi-ok">'+result.updated+'</b></div><div class="rmbi-stat"><span>Skipped</span><b>'+result.skipped+'</b></div><div class="rmbi-stat"><span>Failed</span><b class="rmbi-error">'+result.failed+'</b></div><div class="rmbi-stat"><span>Needs Review</span><b class="rmbi-review">'+result.needsReview+'</b></div></div><div class="finance-actions" style="justify-content:center"><button class="ghost" onclick="exportRoyaltyMatrixErrors()">下载错误行 CSV</button><button class="primary" onclick="finishRoyaltyMatrixImport()">返回版税规则</button></div></div>';
}
function renderCurrent(){
 if(matrixStep===1)renderUpload();
 else if(matrixStep===2)renderMapping();
 else if(matrixStep===3)renderPreview();
 else if(matrixStep===4)renderMatching();
 else if(matrixStep===5)renderValidation();
 else if(matrixStep===6)renderDuplicateReview();
 else renderResult();
}

window.openRoyaltyMatrixBulkImport=function(){
 injectStyles();
 matrixStep=1;
 matrixState=emptyState();
 matrixState.batchId="CM-RM-"+Date.now().toString().slice(-10);
 matrixDecisions={};
 ensureModal().classList.add("show");
 renderUpload();
};
window.closeRoyaltyMatrixBulkImport=function(){document.getElementById("royaltyMatrixBulkModal")?.classList.remove("show")};
window.resetRoyaltyMatrixBulkImport=function(){
 const batchId=matrixState.batchId;
 matrixStep=1;matrixState=emptyState();matrixState.batchId=batchId;matrixDecisions={};renderUpload();
};
window.goRoyaltyMatrixStep=function(step){
 if(step>1&&!matrixState.rows.length){alert("请先选择文件。");return}
 matrixStep=Math.max(1,Math.min(7,Number(step)||1));
 matrixState.report=matrixStep>=3?buildReport():null;
 renderCurrent();
};
window.handleRoyaltyMatrixFile=async function(files){
 const file=files&&files[0];
 if(!file)return;
 if(!/\.(csv|xlsx|xls)$/i.test(file.name)){alert("仅支持 CSV、XLSX、XLS 文件。");return}
 if(file.size>50*1024*1024){alert("文件超过 50MB，请拆分后导入。");return}
 try{
  showToastMessage("正在读取版税规则文件…");
  const rows=await parseRows(file);
  if(!rows.length)throw new Error("文件中没有可识别的数据");
  if(rows.length>30000)throw new Error("单次最多导入 30,000 行，请拆分文件");
  const headers=Object.keys(rows[0]);
  matrixState.fileName=file.name;matrixState.fileSize=file.size;matrixState.headers=headers;matrixState.rows=rows;matrixState.mapping=detectMapping(headers);matrixState.report=null;
  renderUpload();
  showToastMessage("已读取 "+rows.length.toLocaleString()+" 行版税规则");
 }catch(error){alert(error.message||"文件解析失败")}
};
window.setRoyaltyMatrixMapping=function(key,header){
 if(header)matrixState.mapping[key]=header;else delete matrixState.mapping[key];
 matrixState.report=null;renderMapping();
};
window.setRoyaltyMatrixDecision=function(rowNumber,action){
 matrixDecisions[rowNumber]=action;matrixState.report=buildReport();renderDuplicateReview();
};
window.exportRoyaltyMatrixErrors=function(){
 const report=buildReport();
 const problems=report.failedItems.concat(report.reviewItems);
 if(!problems.length){alert("没有需要导出的错误或待审核行。");return}
 const sourceHeaders=matrixState.headers.slice();
 const headers=["Original Row","Error Reason"].concat(sourceHeaders);
 const quote=function(value){return'"'+String(value==null?"":value).replace(/"/g,'""')+'"'};
 const lines=[headers.map(quote).join(",")].concat(problems.map(function(item){
  return[item.rowNumber,item.issues.join("；")||item.match.reason].concat(sourceHeaders.map(function(header){return item.values.sourceRow[header]})).map(quote).join(",");
 }));
 const blob=new Blob(["\ufeff"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),link=document.createElement("a");
 link.href=url;link.download=(matrixState.fileName.replace(/\.[^.]+$/,"")||"royalty-matrix")+"-errors.csv";document.body.appendChild(link);link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(url)},1000);
};
window.confirmRoyaltyMatrixImport=function(){
 const report=buildReport();
 const original=financeRules.map(function(rule){return Object.assign({},rule)});
 try{
  const max=financeRules.reduce(function(number,rule){const match=String(rule.id||"").match(/\d+$/);return Math.max(number,Number(match?match[0]:0))},0);
  let sequence=max+1;
  const updateMap=new Map(report.updatedItems.map(function(item){
   const existing=financeRules.find(function(rule){return rule.id===item.targetId})||{};
   const incoming=ruleRecord(item,item.targetId);
   incoming.contractNo=existing.contractNo||incoming.contractNo;
   incoming.basis=existing.basis||incoming.basis;
   return[item.targetId,Object.assign({},existing,incoming)];
  }));
  financeRules=financeRules.map(function(rule){return updateMap.has(rule.id)?updateMap.get(rule.id):rule});
  report.importedItems.forEach(function(item){
   const id="CM-RULE-"+String(sequence++).padStart(4,"0");
   financeRules.push(ruleRecord(item,id));
  });
  saveFinanceData();
  const queue=safeJSON(REVIEW_KEY,[]);
  report.reviewItems.forEach(function(item){
   queue.unshift({id:matrixState.batchId+"-"+item.rowNumber,batchId:matrixState.batchId,rowNumber:item.rowNumber,status:"Needs Review",reason:item.issues.join("；")||item.match.reason,sourceData:item.values.sourceRow,createdAt:new Date().toISOString()});
  });
  saveJSON(REVIEW_KEY,queue.slice(0,5000));
  const result={imported:report.importedItems.length,updated:report.updatedItems.length,skipped:report.skippedItems.length,failed:report.failedItems.length,needsReview:report.reviewItems.length};
  const history=safeJSON(HISTORY_KEY,[]);
  history.unshift(Object.assign({id:matrixState.batchId,fileName:matrixState.fileName,fileSize:matrixState.fileSize,total:report.total,createdAt:new Date().toLocaleString()},result));
  saveJSON(HISTORY_KEY,history.slice(0,100));
  matrixState.report=report;matrixState.result=result;matrixStep=7;renderResult();showToastMessage("Royalty Matrix 批量导入完成");
 }catch(error){
  financeRules=original;
  try{saveFinanceData()}catch(_){}
  alert("导入失败，数据未写入："+(error.message||"未知错误"));
 }
};
window.finishRoyaltyMatrixImport=function(){closeRoyaltyMatrixBulkImport();financeTab="rules";openSection("finance")};

window.__royaltyMatrixBulkImportTest={
 fields:fields,
 roles:roles,
 royaltyTypes:royaltyTypes,
 detectMapping:detectMapping,
 parseRows:parseRows,
 buildReport:buildReport,
 getState:function(){return matrixState},
 setState:function(state){matrixState=state},
 setDecisions:function(decisions){matrixDecisions=decisions||{}},
 historyKey:HISTORY_KEY,
 reviewKey:REVIEW_KEY,
 schemaVersion:SCHEMA_VERSION
};

injectStyles();
installEntry();
})();
