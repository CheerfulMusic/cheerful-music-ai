console.log("Cheerful Finance Loaded");
(function(){
'use strict';
const KEY='cm_finance_imports_v131';
const PKEY='cm_finance_preview_v131';
const platforms=[
['spotify','Spotify','国际'],['apple','Apple Music','国际'],['youtube','YouTube Music','国际'],
['amazon','Amazon Music','国际'],['tiktok','TikTok / 汽水音乐','短视频'],['meta','Meta / Facebook / Instagram','短视频'],
['qq','QQ音乐 / 酷狗 / 酷我','中国'],['netease','网易云音乐','中国'],['douyin','抖音','中国'],
['bilibili','Bilibili','中国'],['migu','咪咕音乐','中国'],['kkbox','KKBOX','亚洲'],
['melon','Melon / Genie / Bugs','韩国'],['line','LINE MUSIC / AWA','日本'],['boomplay','Boomplay / Audiomack','非洲']
];
let currentPlatform='spotify';
let imports=JSON.parse(localStorage.getItem(KEY)||'[]');
let preview=JSON.parse(localStorage.getItem(PKEY)||'null');

function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function pname(id){return (platforms.find(p=>p[0]===id)||[id,id])[1]}
function save(){localStorage.setItem(KEY,JSON.stringify(imports)); preview?localStorage.setItem(PKEY,JSON.stringify(preview)):localStorage.removeItem(PKEY)}
function detectPlatform(name){
 const n=name.toLowerCase(), map=[['spotify',/spotify/],['apple',/apple|itunes/],['youtube',/youtube/],['amazon',/amazon/],['tiktok',/tiktok|qishui|汽水/],['meta',/meta|facebook|instagram/],['qq',/qq|kugou|kuwo|酷狗|酷我/],['netease',/netease|163|网易/],['douyin',/douyin|抖音/],['bilibili',/bilibili|b站/],['migu',/migu|咪咕/],['kkbox',/kkbox/],['melon',/melon|genie|bugs/],['line',/line|awa/],['boomplay',/boomplay|audiomack/]];
 return (map.find(x=>x[1].test(n))||[currentPlatform])[0]
}
function nk(s){return String(s??'').trim().toLowerCase().replace(/[\s_\-()./\\]+/g,'')}
const aliases={title:['songtitle','tracktitle','title','songname','trackname','歌曲','歌曲名称','歌名','作品名'],artist:['artist','artistname','performer','主艺人','艺人','演唱者','歌手'],isrc:['isrc','recordingcode','录音编码'],country:['country','territory','market','region','国家','地区','市场'],quantity:['streams','streamcount','plays','views','units','quantity','播放量','数量','次数'],revenue:['revenue','amount','netrevenue','netamount','earnings','royalty','payable','收入','金额','版税','收益'],currency:['currency','currencycode','币种','货币'],period:['period','salesperiod','reportingperiod','month','date','结算周期','月份','期间']};
function detectColumns(headers){const out={};headers.forEach(h=>{const n=nk(h);Object.entries(aliases).forEach(([f,a])=>{if(!out[f]&&a.some(x=>n===nk(x)||n.includes(nk(x))))out[f]=h})});return out}
function parseCSV(text){
 const rows=[];let row=[],cell='',q=false;
 for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(c==='"'&&q&&n==='"'){cell+='"';i++;continue}if(c==='"'){q=!q;continue}if(c===','&&!q){row.push(cell);cell='';continue}if((c==='\n'||c==='\r')&&!q){if(c==='\r'&&n==='\n')i++;row.push(cell);cell='';if(row.some(v=>String(v).trim()))rows.push(row);row=[];continue}cell+=c}
 row.push(cell);if(row.some(v=>String(v).trim()))rows.push(row);if(!rows.length)return[];
 const headers=rows[0].map((h,i)=>String(h||`Column ${i+1}`).trim());
 return rows.slice(1).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??''])))
}
function readFile(file){return new Promise((res,rej)=>{const ext=file.name.split('.').pop().toLowerCase(),fr=new FileReader();fr.onerror=()=>rej(new Error('读取文件失败'));if(ext==='csv'){fr.onload=e=>res(parseCSV(String(e.target.result||'')));fr.readAsText(file,'UTF-8')}else if(['xlsx','xls'].includes(ext)){fr.onload=e=>{try{if(!window.XLSX)throw new Error('Excel解析组件未加载，请刷新页面');const wb=XLSX.read(e.target.result,{type:'array'}),ws=wb.Sheets[wb.SheetNames[0]];res(XLSX.utils.sheet_to_json(ws,{defval:''}))}catch(err){rej(err)}};fr.readAsArrayBuffer(file)}else rej(new Error('仅支持 CSV、XLSX、XLS'))})}
function summary(rows,map){const songs=new Set(),curr=new Set(),periods=new Set();let rev=0;rows.forEach(r=>{const k=map.isrc?r[map.isrc]:(map.title?r[map.title]:'');if(String(k||'').trim())songs.add(String(k).trim());const v=Number(String(map.revenue?r[map.revenue]:0).replace(/[^0-9.\-]/g,''));if(Number.isFinite(v))rev+=v;if(map.currency&&r[map.currency])curr.add(String(r[map.currency]).trim());if(map.period&&r[map.period])periods.add(String(r[map.period]).trim())});return{rowCount:rows.length,songCount:songs.size,revenue:rev,currency:[...curr].slice(0,3).join(', ')||'未识别',period:[...periods].slice(0,2).join(', ')||'待确认'}}
function styles(){if(document.getElementById('riStyles'))return;const s=document.createElement('style');s.id='riStyles';s.textContent=`
.ri-platform-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}.ri-platform{padding:14px;border:1px solid var(--line);border-radius:14px;background:#0e1014;color:#d1d4db;text-align:left}.ri-platform.active{border-color:rgba(249,56,34,.5);background:rgba(249,56,34,.1);color:#ff8b7d}.ri-platform b{display:block;font-size:12px}.ri-platform small{display:block;color:var(--muted);font-size:10px;margin-top:5px}.ri-drop{padding:36px 24px;border:1px dashed #434751;border-radius:16px;background:#0c0e12;text-align:center}.ri-drop.drag{border-color:var(--red);background:rgba(249,56,34,.08)}.ri-drop h3{margin:10px 0 6px}.ri-drop p{margin:0;color:var(--muted);font-size:12px}.ri-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.ri-stat{padding:14px;border:1px solid var(--line);border-radius:13px;background:#0e1014}.ri-stat span{display:block;color:var(--muted);font-size:10px}.ri-stat b{display:block;margin-top:7px;font-size:18px}.ri-map{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.ri-map span{padding:6px 8px;border-radius:999px;background:#20232a;color:#c9ccd3;font-size:10px}@media(max-width:1150px){.ri-platform-grid{grid-template-columns:repeat(3,1fr)}}@media(max-width:820px){.ri-platform-grid{grid-template-columns:repeat(2,1fr)}.ri-stats{grid-template-columns:repeat(2,1fr)}}`;document.head.appendChild(s)}
window.renderRoyaltyImportManager=function(){
 styles();
 return `<div class="finance-toolbar"><div><h3 style="margin:0 0 5px">平台版税导入</h3><div style="color:var(--muted);font-size:12px">选择平台并上传 CSV / XLSX / XLS 报表，系统将自动识别字段并预览前20行。</div></div><button class="primary" onclick="openRoyaltyImportModal()">上传平台报表</button></div>
 <div class="ri-platform-grid">${platforms.map(p=>`<button class="ri-platform ${p[0]===currentPlatform?'active':''}" onclick="selectRoyaltyPlatform('${p[0]}')"><b>${esc(p[1])}</b><small>${esc(p[2])} · CSV / XLSX</small></button>`).join('')}</div>
 <div id="royaltyDropZone" class="ri-drop" onclick="document.getElementById('royaltyFileInput').click()"><div style="font-size:32px">⇧</div><h3>拖拽平台报表到这里</h3><p>当前平台：${esc(pname(currentPlatform))} · 支持 CSV、XLSX、XLS</p><button class="primary" style="margin-top:16px" type="button">选择文件</button><input id="royaltyFileInput" type="file" accept=".csv,.xlsx,.xls" hidden onchange="handleRoyaltyFiles(this.files)"></div>
 ${preview?renderPreview(preview):''}
 <div style="margin-top:18px"><div class="panel-head"><h3>导入历史</h3><span class="finance-chip">${imports.length} 个批次</span></div><div class="finance-table-wrap"><table class="finance-table"><thead><tr><th>批次编号</th><th>平台</th><th>文件名</th><th>结算周期</th><th>数据行</th><th>识别歌曲</th><th>收入</th><th>状态</th><th>操作</th></tr></thead><tbody>${imports.length?imports.map(i=>`<tr><td>${esc(i.id)}</td><td>${esc(pname(i.platform))}</td><td>${esc(i.fileName)}</td><td>${esc(i.period)}</td><td>${i.rowCount}</td><td>${i.songCount}</td><td>${esc(i.currency)} ${Number(i.revenue).toLocaleString(undefined,{maximumFractionDigits:2})}</td><td><span class="finance-chip ok">已解析</span></td><td><button class="finance-link" onclick="viewRoyaltyImport('${i.id}')">预览</button><button class="finance-link finance-danger" onclick="deleteRoyaltyImport('${i.id}')">删除</button></td></tr>`).join(''):`<tr><td colspan="9" class="finance-empty">尚未导入平台报表</td></tr>`}</tbody></table></div></div>
 <div class="finance-note">V1.3.1 已实现本地解析和预览。接入 Supabase 后，原始文件将进入 Storage，解析数据将写入数据库。</div>`
}
function renderPreview(i){return `<div class="ri-stats"><div class="ri-stat"><span>数据行数</span><b>${i.rowCount}</b></div><div class="ri-stat"><span>识别歌曲</span><b>${i.songCount}</b></div><div class="ri-stat"><span>收入合计</span><b>${esc(i.currency)} ${Number(i.revenue).toLocaleString(undefined,{maximumFractionDigits:2})}</b></div><div class="ri-stat"><span>结算周期</span><b style="font-size:13px">${esc(i.period)}</b></div></div><div class="panel-head"><h3>字段识别与数据预览</h3><span class="finance-chip">${esc(i.fileName)}</span></div><div class="ri-map">${Object.entries(i.mapping||{}).map(([f,c])=>`<span>${esc(f)} ← ${esc(c)}</span>`).join('')||'<span>未识别到标准字段</span>'}</div><div class="finance-table-wrap"><table class="finance-table"><thead><tr>${i.headers.slice(0,8).map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${i.rows.slice(0,20).map(r=>`<tr>${i.headers.slice(0,8).map(h=>`<td>${esc(r[h])}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="finance-actions"><button class="ghost" onclick="showToastMessage('AI自动匹配歌曲将在 V1.3.2 接入')">下一步：AI自动匹配歌曲 →</button></div>`}
window.selectRoyaltyPlatform=id=>{currentPlatform=id;openSection('finance')}
window.openRoyaltyImportModal=()=>setTimeout(()=>document.getElementById('royaltyFileInput')?.click(),0)
window.handleRoyaltyFiles=async files=>{const file=files&&files[0];if(!file)return;if(file.size>25*1024*1024){alert('前端原型暂时只处理25MB以下文件');return}try{showToastMessage('正在读取平台报表…');currentPlatform=detectPlatform(file.name);const rows=await readFile(file);if(!rows.length)throw new Error('文件中没有可识别的数据');const headers=Object.keys(rows[0]),mapping=detectColumns(headers),sum=summary(rows,mapping),id='CM-IMP-'+Date.now().toString().slice(-10),item={id,platform:currentPlatform,fileName:file.name,headers,mapping,rows:rows.slice(0,20),status:'已解析',...sum};imports.unshift(item);preview=item;save();openSection('finance');showToastMessage(`已解析 ${sum.rowCount} 行数据`)}catch(e){alert(e.message||'文件解析失败')}finally{const input=document.getElementById('royaltyFileInput');if(input)input.value=''}}
window.viewRoyaltyImport=id=>{preview=imports.find(i=>i.id===id)||null;save();openSection('finance')}
window.deleteRoyaltyImport=id=>{if(!confirm('确认删除这个导入批次吗？'))return;imports=imports.filter(i=>i.id!==id);if(preview&&preview.id===id)preview=null;save();openSection('finance')}
document.addEventListener('dragover',e=>{const z=document.getElementById('royaltyDropZone');if(!z)return;e.preventDefault();z.classList.add('drag')});
document.addEventListener('dragleave',e=>{const z=document.getElementById('royaltyDropZone');if(z&&!e.relatedTarget)z.classList.remove('drag')});
document.addEventListener('drop',e=>{const z=document.getElementById('royaltyDropZone');if(!z)return;e.preventDefault();z.classList.remove('drag');if(e.dataTransfer?.files?.length)handleRoyaltyFiles(e.dataTransfer.files)});
styles();
})();
