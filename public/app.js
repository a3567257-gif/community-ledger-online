function fmt(n){ return Math.round(n).toLocaleString('zh-TW'); }

// 安全網：任何地方沒有被個別攔截到的錯誤，都會跳出提示，不會讓畫面「靜靜沒反應」
window.addEventListener('unhandledrejection', (event)=>{
  console.error('未預期的錯誤:', event.reason);
  alert('發生未預期的錯誤，請把這段訊息截圖給開發者：\n' + (event.reason && event.reason.message ? event.reason.message : event.reason));
});

let households = [];
let rateSettings = null;
let periodInfo = { period: '', generated: false };
let currentResults = [];
let currentUnmatched = [];
window.__isReadOnly = false;

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> switchTab(btn.dataset.tab));
});
function switchTab(tab){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  document.getElementById('tab-'+tab).classList.add('active');
}

// ---------- 民國年顯示（系統統一寫法：月份 115/07、日期 115/07/15）----------
function rocP(p){
  const m = String(p||'').match(/^(\d{4})-(\d{2})/);
  return m ? `${Number(m[1])-1911}/${m[2]}` : (p||'');
}
function rocD(d){
  const m = String(d||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[1])-1911}/${m[2]}/${m[3]}` : (d||'');
}
function rocRange(r){
  return String(r||'').split('~').map(rocP).join('～');
}

let periodState = null;
function refreshHeader(){
  const range = periodState && periodState.range ? `（${rocD(periodState.range.start)}～${rocD(periodState.range.end)}）` : '';
  document.getElementById('header-sub').textContent =
    `本期 ${rocP(periodInfo.period)}${range} · ${periodInfo.generated ? '本期帳款已產生' : '本期帳款尚未產生'}`;
}

// ---------- 本期管理 ----------
function addMonths(p, n){
  let [y, m] = p.split('-').map(Number);
  m += n; while (m > 12){ m -= 12; y++; } while (m < 1){ m += 12; y--; }
  return `${y}-${String(m).padStart(2,'0')}`;
}

async function refreshPeriod(){
  const res = await window.api.getPeriodState();
  if (!res.ok) return;
  periodState = res;
  // 社區設定：結算日、本期
  const cdSel = document.getElementById('closing-day');
  cdSel.innerHTML = `<option value="0">月底（每月 1 日～月底為一期）</option>` +
    Array.from({length:28},(_,i)=>i+1).map(d=>`<option value="${d}">每月 ${d} 日（${d+1} 日～下月 ${d} 日為一期）</option>`).join('');
  cdSel.value = String(res.closingDay);
  const pSel = document.getElementById('current-period');
  const options = new Set([res.currentPeriod]);
  for (let i = -3; i <= 1; i++) options.add(addMonths(res.suggestedPeriod, i));
  pSel.innerHTML = [...options].sort().map(p=>`<option value="${p}">${rocP(p)}${p===res.suggestedPeriod?'（依今天日期建議）':''}</option>`).join('');
  pSel.value = res.currentPeriod;
  pSel.disabled = res.locked || window.__isReadOnly;
  cdSel.disabled = window.__isReadOnly;
  document.getElementById('period-range-hint').textContent = res.locked
    ? `本期 ${rocP(res.currentPeriod)}（${rocD(res.range.start)}～${rocD(res.range.end)}）。已經有帳款資料，本期不能直接修改，每個月在「月結報表」按「本期結帳」進入下一期。`
    : `本期 ${rocP(res.currentPeriod)}（${rocD(res.range.start)}～${rocD(res.range.end)}）。請在匯入未繳、預繳名單之前確認本期，匯入後就不能再改。`;
  // 結帳卡片
  const closeBtn = document.getElementById('btn-close-period');
  closeBtn.textContent = `本期結帳，進入下一期（${rocP(addMonths(res.currentPeriod, 1))}）`;
  closeBtn.disabled = window.__isReadOnly;
  const last = res.closedPeriods.length ? res.closedPeriods[res.closedPeriods.length-1] : null;
  document.getElementById('close-info').textContent =
    `本期 ${rocP(res.currentPeriod)}：${res.generated ? '應收帳款已產生' : '應收帳款尚未產生'}，本期已匯入 ${res.bankCountThisPeriod} 筆銀行入帳。`
    + (last ? `上一次結帳：${rocP(last.period)}。` : '');
  // 落後提醒（示範版的資料固定在 115/07，不提醒）
  const lag = document.getElementById('period-lag');
  if (!appInfo.isDemo && res.periodConfirmed && res.behind >= 2 && !window.__isReadOnly){
    lag.hidden = false;
    lag.innerHTML = `⚠ 今天是 ${rocD(res.today)}，屬於 ${rocP(res.suggestedPeriod)} 這一期，但系統本期還停在 ${rocP(res.currentPeriod)}。`
      + `請確認 ${rocP(res.currentPeriod)} 是否已經做完月結；做完請到「月結報表」按「本期結帳」。`;
  } else {
    lag.hidden = true;
  }
  refreshHeader();
}

document.getElementById('btn-close-period').addEventListener('click', async ()=>{
  const st = periodState;
  const statusEl = document.getElementById('close-status');
  if (!st.generated){
    statusEl.textContent = `本期（${rocP(st.currentPeriod)}）的應收帳款還沒產生，不能結帳。請先到「本期試算與核對」產生本期帳款。`;
    return;
  }
  let msg = `確定要結束 ${rocP(st.currentPeriod)}，進入 ${rocP(addMonths(st.currentPeriod,1))}？\n\n`;
  if (!st.bankCountThisPeriod) msg += `注意：本期還沒有匯入任何銀行明細。\n\n`;
  msg += `結帳後，${rocP(st.currentPeriod)} 的銀行明細就不能再匯入。請確認已經匯出本期月結報表。\n系統會先自動備份一份。`;
  if (!confirm(msg)) return;
  const res = await window.api.closePeriod();
  if (!res.ok){ statusEl.textContent = res.error; return; }
  statusEl.textContent = `已完成 ${rocP(res.closedPeriod)} 結帳，現在本期是 ${rocP(res.newPeriod)}。下一步：到「本期試算與核對」產生 ${rocP(res.newPeriod)} 的應收帳款。結帳前的資料已自動備份（${res.safetyBackupPath || ''}）。`;
  currentResults = []; currentUnmatched = [];
  document.getElementById('bank-results').innerHTML = '';
  document.getElementById('bank-unmatched').innerHTML = '';
  document.getElementById('bank-rejected').innerHTML = '';
  await init();
});

// ---------- 初始化 ----------
let recoveryNoticeShown = false;
let appInfo = { edition: 'formal', isDemo: false };
async function init(){
  appInfo = await window.api.getAppInfo();
  document.getElementById('edition-badge').hidden = !appInfo.isDemo;
  document.getElementById('demo-samples').hidden = !appInfo.isDemo;
  await refreshLicense();
  periodInfo = await window.api.getPeriodStatus();
  await refreshCommunity();
  await refreshPeriod();
  await refreshRates();
  await refreshHouseholds();
  await refreshChanges();
  await refreshUnpaid();
  await refreshPrepaid();
  await refreshIncome();
  await refreshBackup();
  await refreshSetup();

  if (!recoveryNoticeShown){
    recoveryNoticeShown = true;
    const notice = await window.api.getRecoveryNotice();
    if (notice) alert(notice);
  }
}

async function refreshRates(){
  rateSettings = await window.api.getRates();
  renderRateForm();
  await refreshRateHistory();
}

async function refreshRateHistory(){
  const res = await window.api.getRateHistory();
  const versions = res.ok ? res.versions : [];
  document.getElementById('rate-history-rows').innerHTML = versions.map(v => {
    const catText = escHtml(Object.entries(v.categoryRates).map(([cat, rate]) => `${cat} $${rate}`).join('、'));
    const period = v.effectiveTo ? `${rocP(v.effectiveFrom)} ～ ${rocP(v.effectiveTo)}前` : `${rocP(v.effectiveFrom)} ～ 目前`;
    return `
    <tr>
      <td>${period}${v.isCurrent ? ' <span class="chip">目前生效</span>' : ''}</td>
      <td>${catText}</td>
      <td>$${fmt(v.publicFundFee)}</td>
      <td>$${fmt(v.buildingFundPerPing)} / 坪</td>
      <td>${v.annualDiscount ? Math.round(v.annualDiscount*100)+'折' : '無'}</td>
      <td>${v.semiAnnualDiscount ? Math.round(v.semiAnnualDiscount*100)+'折' : '無'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="muted">目前沒有費率紀錄。</td></tr>`;
}

async function refreshHouseholds(){
  households = await window.api.listHouseholds();
  renderHouseholds();
  await refreshHouseholdImport();
  // 住戶資料變了（例如剛匯入），費率設定頁要重新檢查有沒有「住戶有用、但沒設定單價」的類型
  if (rateSettings) renderRateForm();
}

async function refreshChanges(){
  const changes = await window.api.getChanges();
  periodInfo = await window.api.getPeriodStatus();
  renderChanges(changes);
  await refreshReceivables();
}

// 本期應收帳款明細：產生前是試算，產生後顯示每一戶本期應收、已收、未收
const STATUS_CHIP = { '已繳':'success', '部分繳':'warning', '未繳':'danger', '尚未產生':'neutral' };
async function refreshReceivables(){
  const res = await window.api.getReceivables();
  const title = document.getElementById('receivables-title');
  const body = document.getElementById('receivables-rows');
  if (!res.ok){ body.innerHTML = `<tr><td colspan="13" class="muted">${escHtml(res.error||'讀取失敗')}</td></tr>`; return; }
  const t = res.totals;
  const counts = res.rows.reduce((m, r)=>{ m[r.status] = (m[r.status]||0) + 1; return m; }, {});
  title.innerHTML = res.generated
    ? `<b>本期（${rocP(res.period)}）應收帳款明細</b><span class="muted">　共 ${res.rows.length} 戶，應收 $${fmt(t.due)}、已收 $${fmt(t.paid)}、未收 $${fmt(t.owed)}`
      + `（${Object.entries(counts).map(([k,v])=>`${k} ${v} 戶`).join('、')}）</span>`
    : `<span class="chip trial-chip">試算・尚未產生</span> <b>本期（${rocP(res.period)}）應收帳款試算</b><span class="muted">　帳款還沒產生，以下只是依目前住戶資料與費率先算給您核對的金額（共 ${res.rows.length} 戶，應收 $${fmt(t.due)}）。核對無誤後按上方「確認無誤，產生本期應收帳款」才會正式建立帳款。</span>`;
  // 帳款還沒產生時：表格換成淺色底，已收、未收、狀態這三欄還沒有意義，先隱藏
  document.getElementById('receivables-table').classList.toggle('trial', !res.generated);
  const money = v => v ? `$${fmt(v)}` : '<span class="muted">-</span>';
  body.innerHTML = res.rows.map((r,idx)=>`
    <tr>
      <td class="seq-col">${idx+1}</td><td>${escHtml(r.unit)}</td><td>${escHtml(r.category||'')}</td><td class="num-col">${r.area}</td>
      <td class="num-col">${money(r.base)}</td><td class="num-col">${money(r.publicFund)}</td><td class="num-col">${money(r.buildingFund)}</td><td class="num-col">${money(r.parking)}</td>
      <td class="num-col"><b>$${fmt(r.due)}</b>${r.hasLedger && r.due !== r.estimated ? `<span class="cell-sub">試算 $${fmt(r.estimated)}</span>` : ''}</td>
      <td class="num-col col-paid">${money(r.paid)}</td><td class="num-col col-paid ${r.owed ? 'amt-owed' : ''}">${money(r.owed)}</td>
      <td class="col-paid"><span class="chip ${STATUS_CHIP[r.status]||'neutral'}">${r.status}</span></td>
      <td class="muted">${escHtml(r.note||'')}</td>
    </tr>`).join('') + `
    <tr class="total-row">
      <td colspan="4"><b>合計（${res.rows.length} 戶）</b></td>
      <td class="num-col">$${fmt(t.base)}</td><td class="num-col">$${fmt(t.publicFund)}</td><td class="num-col">$${fmt(t.buildingFund)}</td><td class="num-col">$${fmt(t.parking)}</td>
      <td class="num-col"><b>$${fmt(t.due)}</b></td><td class="num-col col-paid">$${fmt(t.paid)}</td><td class="num-col col-paid amt-owed">$${fmt(t.owed)}</td><td class="col-paid"></td><td></td>
    </tr>`;
}

// ---------- 費率設定 ----------
function renderRateForm(){
  // 除了費率設定裡已有的類型，也把「住戶資料裡有用到、但還沒設定單價」的類型列出來，
  // 避免匯入別的社區資料後（例如類型叫「住宅」），這些住戶的管理費被靜靜地算成 0 元。
  const usedCats = [...new Set((households || []).map(h => h.category).filter(Boolean))];
  const missingCats = usedCats.filter(c => !(c in rateSettings.categoryRates));
  const catInputs = Object.keys(rateSettings.categoryRates).map(cat => `
    <div class="field"><label>${escHtml(cat)} · 每坪單價</label>
      <input type="number" step="0.1" data-rate-cat="${escHtml(cat)}" value="${rateSettings.categoryRates[cat]}"></div>
  `).join('') + missingCats.map(cat => `
    <div class="field"><label style="color:var(--warning-tx);">${escHtml(cat)} · 每坪單價（⚠ 住戶資料有這個類型，但還沒設定單價）</label>
      <input type="number" step="0.1" data-rate-cat="${escHtml(cat)}" value="" placeholder="請輸入單價"></div>
  `).join('') + `
    <div class="field"><label>新增類型（例如「住宅」「店面」「辦公室」，留空代表不新增）</label>
      <div style="display:flex;gap:8px;"><input type="text" id="r-new-cat-name" placeholder="類型名稱" style="flex:2;">
      <input type="number" step="0.1" id="r-new-cat-rate" placeholder="每坪單價" style="flex:1;"></div></div>
  `;
  document.getElementById('rate-form').innerHTML = catInputs + `
    <div class="field"><label>公共基金（固定月費）</label><input type="number" id="r-public" value="${rateSettings.publicFundFee}"></div>
    <div class="field"><label>修繕基金提撥（每坪）</label><input type="number" step="0.1" id="r-bf" value="${rateSettings.buildingFundPerPing}"></div>
    <div class="field"><label>年繳優惠（打幾折，例如95代表95折；留0代表不提供）</label><input type="number" step="1" id="r-annual-discount" value="${Math.round((rateSettings.annualDiscount||0)*100)}"></div>
    <div class="field"><label>半年繳優惠（打幾折；留0代表不提供）</label><input type="number" step="1" id="r-semi-discount" value="${Math.round((rateSettings.semiAnnualDiscount||0)*100)}"></div>
  `;
}
document.getElementById('btn-save-rates').addEventListener('click', async ()=>{
  const categoryRates = {};
  // 單價留空不能當成 0 存起來（會讓這個類型的住戶管理費變成 0 元）
  const emptyCats = [];
  document.querySelectorAll('[data-rate-cat]').forEach(inp=>{
    const v = parseFloat(inp.value);
    if (isNaN(v) || v <= 0) emptyCats.push(inp.dataset.rateCat);
    else categoryRates[inp.dataset.rateCat] = v;
  });
  if (emptyCats.length){
    document.getElementById('rate-save-status').innerHTML = `<span style="color:var(--danger-tx);">「${emptyCats.map(escHtml).join('」「')}」的每坪單價還沒填（或填了 0），沒有儲存任何變更。</span>`;
    return;
  }
  const newCatName = (document.getElementById('r-new-cat-name').value || '').trim();
  if (newCatName) {
    const newCatRate = parseFloat(document.getElementById('r-new-cat-rate').value);
    if (isNaN(newCatRate) || newCatRate <= 0) {
      document.getElementById('rate-save-status').textContent = `請輸入「${newCatName}」的每坪單價，沒有儲存任何變更。`;
      return;
    }
    categoryRates[newCatName] = newCatRate;
  }
  const publicFundFee = parseFloat(document.getElementById('r-public').value) || 0;
  const buildingFundPerPing = parseFloat(document.getElementById('r-bf').value) || 0;
  const annualDiscount = (parseFloat(document.getElementById('r-annual-discount').value) || 0) / 100;
  const semiAnnualDiscount = (parseFloat(document.getElementById('r-semi-discount').value) || 0) / 100;
  await window.api.saveRates({ categoryRates, publicFundFee, buildingFundPerPing, annualDiscount, semiAnnualDiscount });
  document.getElementById('rate-save-status').textContent = '費率設定已更新，住戶總覽與本期試算已同步重新計算。';
  await refreshRates();
  await refreshHouseholds();
  await refreshChanges();
  await refreshSetup();
});

// ---------- 住戶總覽 ----------
function statusTag(status){
  const cls = status==='自有' ? 'accent2' : (status==='租用'||status==='承租') ? 'warning' : status==='已繳' ? 'success' : status==='部分繳' ? 'warning' : status==='未繳' ? 'danger' : 'neutral';
  return `<span class="chip ${cls}">${status}</span>`;
}

function renderHouseholds(){
  const missing = new Map();
  const rows = households.map((h,idx)=>{
    const rate = rateSettings.categoryRates[h.category] || 0;
    if (!rate) missing.set(h.category || '（空白）', (missing.get(h.category || '（空白）') || 0) + 1);
    const bf = Math.round(h.area * rateSettings.buildingFundPerPing);
    const est = Math.round(h.area*rate + rateSettings.publicFundFee + h.area*rateSettings.buildingFundPerPing + (Number(h.carFee)||0) + (Number(h.carRent)||0) + (Number(h.motoFee)||0) + (Number(h.motoRent)||0));
    return `<tr>
      <td>${idx+1}</td><td>${escHtml(h.unit)}</td><td>${escHtml(h.category||'')}</td><td>${escHtml(h.account)}</td><td>${h.area}</td>
      <td>${rate ? rate : '<span class="chip danger" title="費率設定裡沒有這個類型的每坪單價">未設定</span>'}</td><td>${rateSettings.publicFundFee}</td><td>${bf}</td>
      <td>${vehicleCell(h.carFee, h.carRent, h.carStatus)}</td>
      <td>${vehicleCell(h.motoFee, h.motoRent, h.motoStatus)}</td>
      <td><b>$${fmt(est)}</b></td>
      <td>${statusTag(h.latestStatus)}</td>
      <td>${window.__isReadOnly ? '' : `<button class="link" data-edit="${h.id}">編輯</button>`}</td>
    </tr>`;
  }).join('');
  document.getElementById('household-rows').innerHTML = rows;
  const warnEl = document.getElementById('rate-missing-warning');
  if (missing.size){
    warnEl.hidden = false;
    warnEl.innerHTML = `⚠ 有住戶的類型沒有設定每坪單價，這些住戶的每月應繳金額目前少算：`
      + [...missing.entries()].map(([c,n])=>`「${escHtml(c)}」${n} 戶`).join('、')
      + `。<button class="link" id="btn-goto-rates">前往費率設定</button>`;
    document.getElementById('btn-goto-rates').onclick = ()=> switchTab('rates');
  } else {
    warnEl.hidden = true;
  }
  document.getElementById('stat-total').textContent = households.length;
  const paid = households.filter(h=>h.latestStatus==='已繳').length;
  document.getElementById('stat-paid').textContent = paid;
  document.getElementById('stat-unpaid').textContent = households.length - paid;

  document.querySelectorAll('[data-edit]').forEach(b=>{
    b.addEventListener('click', ()=> openEdit(b.dataset.edit));
  });
}

// 車位欄：狀態＋清潔費／租金（兩筆錢分開顯示，一看就知道收的是什麼）
function vehicleCell(fee, rent, status){
  const f = Number(fee)||0, r = Number(rent)||0;
  const parts = [];
  if (f) parts.push(`清潔 $${fmt(f)}`);
  if (r) parts.push(`租金 $${fmt(r)}`);
  return `${statusTag(status||'無')} ${parts.length ? parts.join('／') : '<span class="muted">—</span>'}`;
}

function statusOptions(current){
  const opts = ['無','自有','承租'];
  if (current && !opts.includes(current)) opts.push(current); // 舊資料的「租用」等寫法保留顯示
  return opts.map(s=>`<option value="${s}" ${s===current?'selected':''}>${s}</option>`).join('');
}

let editingId = null;
function openEdit(id){
  editingId = id ? Number(id) : null;
  const h = editingId ? households.find(x=>x.id===editingId) : { id:null, unit:'', category:Object.keys(rateSettings.categoryRates)[0], account:'', area:0, carFee:0, carRent:0, carStatus:'無', motoFee:0, motoRent:0, motoStatus:'無' };
  const rate = rateSettings.categoryRates[h.category] || 0;
  const bf = Math.round((h.area||0) * rateSettings.buildingFundPerPing);
  document.getElementById('edit-error').textContent = '';
  document.getElementById('edit-form').innerHTML = `
    <div class="field"><label>戶號（例如 260-1F）</label><input id="f-unit" value="${escHtml(h.unit)}"></div>
    <div class="field"><label>類型</label>
      <select id="f-category">
        ${Object.keys(rateSettings.categoryRates).map(c=>`<option value="${escHtml(c)}" ${c===h.category?'selected':''}>${escHtml(c)}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>帳號（虛擬帳號）</label><input id="f-account" value="${escHtml(h.account)}"></div>
    <div class="field"><label>坪數</label><input id="f-area" type="number" step="0.01" value="${h.area}"></div>
    <div class="field readonly"><label>每坪單價（依類型帶入，費率設定頁調整）</label><input id="f-rate-display" value="${rate}" readonly></div>
    <div class="field readonly"><label>公共基金（社區統一設定）</label><input value="${rateSettings.publicFundFee}" readonly></div>
    <div class="field readonly"><label>修繕基金提撥（依坪數帶入）</label><input id="f-bf-display" value="${bf}" readonly></div>
    <div class="field"></div>
    <div class="field"><label>汽車位狀態</label><select id="f-carstatus">${statusOptions(h.carStatus||'無')}</select></div>
    <div class="field"><label>汽車清潔費（每月）</label><input id="f-carfee" type="number" step="1" value="${h.carFee||0}"></div>
    <div class="field"><label>汽車租金（每月）</label><input id="f-carrent" type="number" step="1" value="${h.carRent||0}"></div>
    <div class="field"></div>
    <div class="field"><label>機車位狀態</label><select id="f-motostatus">${statusOptions(h.motoStatus||'無')}</select></div>
    <div class="field"><label>機車清潔費（每月）</label><input id="f-motofee" type="number" step="1" value="${h.motoFee||0}"></div>
    <div class="field"><label>機車租金（每月）</label><input id="f-motorent" type="number" step="1" value="${h.motoRent||0}"></div>
  `;
  document.getElementById('edit-card').style.display = 'block';
  document.getElementById('btn-delete-household').hidden = !editingId || window.__isReadOnly;
  const syncDerived = ()=>{
    const cat = document.getElementById('f-category').value;
    const area = parseFloat(document.getElementById('f-area').value) || 0;
    document.getElementById('f-rate-display').value = rateSettings.categoryRates[cat] || 0;
    document.getElementById('f-bf-display').value = Math.round(area * rateSettings.buildingFundPerPing);
  };
  document.getElementById('f-category').addEventListener('change', syncDerived);
  document.getElementById('f-area').addEventListener('input', syncDerived);
}

function escHtml(t){ return String(t).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function showImportResult(html){
  const el = document.getElementById('import-status');
  if (!html){ el.style.display='none'; el.innerHTML=''; return; }
  el.innerHTML = `<button class="close-x" title="關閉這則訊息" id="btn-close-import-status">×</button>` + html;
  el.style.display = 'block';
  document.getElementById('btn-close-import-status').onclick = ()=>showImportResult('');
}

document.getElementById('btn-import-households').addEventListener('click', async ()=>{
  showImportResult('匯入中…');
  try {
    const res = await window.api.importHouseholdsFile();
    if (res.canceled){ showImportResult(''); return; }
    if (!res.ok){ showImportResult('匯入失敗：' + escHtml(res.error || '未知錯誤')); return; }
    let html = `<strong>成功匯入 ${res.createdCount} 戶。</strong>`;
    if (res.headerRow && res.headerRow > 1) html += `（系統自動判斷：第 ${res.headerRow} 列是欄位名稱，上面是報表標題）`;
    html += '<br>原本已有的住戶資料不會被刪除或覆蓋，匯入只會新增帳號不重複的住戶。';
    (res.warnings || []).forEach(w=>{ html += `<div class="warn-line">⚠ ${escHtml(w)}</div>`; });
    if (res.skipped && res.skipped.length){
      html += `<details><summary>略過 ${res.skipped.length} 筆（點開看原因，列號對應 Excel 左側列號）</summary>`
        + res.skipped.map(s=>`第${s.rowIndex}列：${escHtml(s.reason)}`).join('<br>') + '</details>';
    }
    showImportResult(html);
    await refreshHouseholds();
    await refreshChanges();
    await refreshSetup();
  } catch (e) {
    showImportResult('匯入失敗：' + escHtml(e.message || e));
  }
});

// ---------- 匯錯了：復原住戶匯入、刪除住戶 ----------
async function refreshHouseholdImport(){
  const el = document.getElementById('household-last-import');
  const res = await window.api.getLastHouseholdImport();
  const last = res.ok ? res.last : null;
  if (!last || window.__isReadOnly){ el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `最後一次住戶匯入：${escHtml(last.filename)}（${fmtTime(last.importedAt)}，${last.count} 戶）`
    + (last.canUndo
      ? ` <button class="btn secondary" id="btn-undo-households" style="color:var(--danger-tx);">匯錯了，復原這次匯入</button>`
      : `<span>　已經有住戶產生帳款，不能整批復原；資料打錯請按該戶的「編輯」修改。</span>`);
  const btn = document.getElementById('btn-undo-households');
  if (btn) btn.onclick = async ()=>{
    if (!confirm(`確定要復原這次住戶匯入嗎？\n\n會刪除這次匯入的 ${last.count} 戶（${last.filename}），之後可以重新匯入正確的檔案。\n復原前會自動備份目前資料。`)) return;
    const r = await window.api.undoHouseholdImport(last.batchId);
    if (!r.ok){ showImportResult('復原失敗：' + escHtml(r.error)); return; }
    showImportResult(`<strong>已復原：刪除這次匯入的 ${r.count} 戶。</strong>可以重新匯入正確的住戶資料。`);
    await refreshHouseholds(); await refreshChanges(); await refreshSetup();
  };
}

document.getElementById('btn-delete-household').addEventListener('click', async ()=>{
  const h = households.find(x=>x.id===editingId);
  if (!h) return;
  if (!confirm(`確定要刪除 ${h.unit}（帳號 ${h.account}）嗎？\n\n只有還沒有任何帳款、入帳紀錄的住戶才能刪除。`)) return;
  const r = await window.api.deleteHousehold(editingId);
  if (!r.ok){ document.getElementById('edit-error').textContent = r.error; return; }
  document.getElementById('edit-card').style.display = 'none';
  showImportResult(`已刪除 ${escHtml(r.unit)}。`);
  await refreshHouseholds(); await refreshChanges(); await refreshSetup();
});

document.getElementById('btn-cancel').addEventListener('click', ()=>{
  document.getElementById('edit-card').style.display = 'none';
});
document.getElementById('btn-save').addEventListener('click', async ()=>{
  const data = {
    id: editingId,
    unit: document.getElementById('f-unit').value.trim(),
    category: document.getElementById('f-category').value,
    account: document.getElementById('f-account').value.trim(),
    area: parseFloat(document.getElementById('f-area').value) || 0,
    carFee: parseFloat(document.getElementById('f-carfee').value) || 0,
    carRent: parseFloat(document.getElementById('f-carrent').value) || 0,
    carStatus: document.getElementById('f-carstatus').value,
    motoFee: parseFloat(document.getElementById('f-motofee').value) || 0,
    motoRent: parseFloat(document.getElementById('f-motorent').value) || 0,
    motoStatus: document.getElementById('f-motostatus').value,
  };
  if (!data.unit || !data.account){
    document.getElementById('edit-error').textContent = '戶號與虛擬帳號為必填';
    return;
  }
  const res = await window.api.saveHousehold(data);
  if (!res.ok){
    document.getElementById('edit-error').textContent = res.error;
    return;
  }
  document.getElementById('edit-card').style.display = 'none';
  await refreshHouseholds();
  await refreshChanges();
});

// ---------- 本期試算與核對 ----------
function renderChanges(changes){
  const el = document.getElementById('changes-list');
  const btn = document.getElementById('btn-generate');
  if (periodInfo.generated){
    el.innerHTML = `<p class="muted">本期（${rocP(periodInfo.period)}）帳款已產生，共 ${households.length} 戶。</p>`;
    btn.disabled = true;
    btn.textContent = '本期帳款已產生';
    return;
  }
  // 這個按鈕能不能按，同時取決於「本期是否已產生」跟「目前是不是唯讀身份」兩件事，
  // 唯讀模式一律鎖住，不會因為每次重新整理清單而被誤開回可以按。
  btn.disabled = window.__isReadOnly ? true : false;
  btn.textContent = '確認無誤，產生本期應收帳款';
  const changed = changes.filter(c=>!c.noPrior);
  const noPrior = changes.filter(c=>c.noPrior);
  if (!changes.length){
    el.innerHTML = '<p class="muted">目前登記資料跟上期完全一致，沒有需要特別核對的住戶。</p>';
    return;
  }
  let html = '';
  if (changed.length){
    html += `<p style="font-weight:600; color:var(--warning-tx); margin-bottom:8px;">${changed.length} 戶本期試算金額跟上期不同，請核對：</p>` +
      changed.map((c,idx)=>`
        <div class="row-between" style="padding:8px 0; border-top:1px solid var(--line);">
          <div><span class="muted">${idx+1}.</span> <b>${escHtml(c.unit)}</b> <span class="muted">${escHtml(c.account)}</span></div>
          <div class="muted">上期（${rocP(c.lastPeriod)}）$${fmt(c.lastDue)} → 本期試算 $${fmt(c.estimatedTotal)}
            <span class="chip ${c.delta>0?'warning':'danger'}">${c.delta>0?'+':''}${fmt(c.delta)}</span>
          </div>
        </div>`).join('');
  } else if (noPrior.length < households.length) {
    html += '<p class="muted">有上期帳款的住戶，本期試算金額都跟上期相同。</p>';
  }
  // 第一次使用系統時，系統裡還沒有上期的月費帳款可以比對（期初未繳名單登記的是欠款，不是月費），這是正常的
  if (noPrior.length){
    html += `<details class="no-prior" ${changed.length ? '' : 'open'}>
      <summary>${noPrior.length} 戶是第一次產生帳款，沒有上期月費可以比對（第一次使用系統的正常情況）：請確認本期試算金額跟社區原本收的管理費一樣</summary>
      <div class="scroll" style="margin-top:8px;"><table>
        <thead><tr><th class="seq-col">序號</th><th>戶號</th><th>帳號</th><th class="num-col">本期試算</th></tr></thead>
        <tbody>${noPrior.map((c,idx)=>`<tr><td class="seq-col">${idx+1}</td><td>${escHtml(c.unit)}</td><td>${escHtml(c.account)}</td><td class="num-col">$${fmt(c.estimatedTotal)}</td></tr>`).join('')}</tbody>
      </table></div>
    </details>`;
  }
  el.innerHTML = html;
}

document.getElementById('btn-generate').addEventListener('click', async ()=>{
  const res = await window.api.generatePeriod();
  if (!res.ok){
    document.getElementById('generate-status').textContent = res.error;
    return;
  }
  document.getElementById('generate-status').textContent =
    `本期應收帳款已產生：新增 ${res.created} 戶${res.skippedExisting ? `，另外 ${res.skippedExisting} 戶本期已有資料（期初已繳或預繳）略過，不會重複建立` : ''}。下一步到「銀行明細比對」匯入本期銀行明細。`;
  await refreshChanges();
  document.getElementById('close-status').textContent = '';
  await refreshPeriod();
  await refreshUnpaid();
  await refreshPrepaid();
});

// ---------- 未繳名單 ----------
// 未繳、預繳名單：一戶一列，月份往右逐月排開（跟社區原本的 Excel 報表一樣）
function unitSort(a, b){ return String(a).localeCompare(String(b), 'zh-Hant', { numeric: true }); }

function pivotByHousehold(rows){
  const months = [...new Set(rows.map(r=>r.period))].sort();
  const map = new Map();
  rows.forEach(r=>{
    if (!map.has(r.unit)) map.set(r.unit, { unit: r.unit, account: r.account, cells: {}, notes: new Set() });
    const h = map.get(r.unit);
    h.cells[r.period] = r;
    if (r.note) h.notes.add(r.note.split('（')[0]);
  });
  return { months, list: [...map.values()].sort((a,b)=>unitSort(a.unit,b.unit)) };
}

async function refreshUnpaid(){
  const res = await window.api.getUnpaidList();
  const rows = res.ok ? res.rows : [];
  // 開帳時匯錯可以清除重來：只在本期帳款產生前顯示（後端也會再檢查一次）
  document.getElementById('btn-clear-unpaid').hidden = window.__isReadOnly || periodInfo.generated || !rows.some(r=>r.note==='未繳名單匯入');
  const { months, list } = pivotByHousehold(rows);
  document.getElementById('unpaid-head').innerHTML =
    `<tr><th class="seq-col">序號</th><th>戶號</th>${months.map(m=>`<th class="num-col">${rocP(m)}</th>`).join('')}<th class="num-col">未繳合計</th><th>備註</th></tr>`;
  if (!list.length){
    document.getElementById('unpaid-rows').innerHTML = `<tr><td colspan="${months.length+4}" class="muted">目前沒有未繳資料。</td></tr>`;
    return;
  }
  const colTotals = months.map(()=>0);
  let grand = 0;
  const body = list.map((h,idx)=>{
    let sum = 0;
    const cells = months.map((m,i)=>{
      const r = h.cells[m];
      if (!r) return '<td></td>';
      sum += r.amountOwed; colTotals[i] += r.amountOwed;
      const partial = r.amountPaid > 0 ? ` <span class="chip warning" title="應繳 $${fmt(r.amountDue)}，已繳 $${fmt(r.amountPaid)}">部分</span>` : '';
      return `<td class="num-col amt-owed">$${fmt(r.amountOwed)}${partial}</td>`;
    }).join('');
    grand += sum;
    return `<tr><td class="seq-col">${idx+1}</td><td>${escHtml(h.unit)}</td>${cells}<td class="num-col amt-owed"><b>$${fmt(sum)}</b></td><td class="muted">${escHtml([...h.notes].filter(n=>n!=='未繳名單匯入').join('、'))}</td></tr>`;
  }).join('');
  const totalRow = `<tr class="total-row"><td colspan="2"><b>合計（${list.length} 戶）</b></td>${colTotals.map(t=>`<td class="num-col amt-owed"><b>${t?'$'+fmt(t):''}</b></td>`).join('')}<td class="num-col amt-owed"><b>$${fmt(grand)}</b></td><td></td></tr>`;
  document.getElementById('unpaid-rows').innerHTML = body + totalRow;
}

document.getElementById('btn-import-unpaid').addEventListener('click', async ()=>{
  const statusEl = document.getElementById('unpaid-import-status');
  const warnEl = document.getElementById('unpaid-warnings');
  statusEl.textContent = '匯入中…';
  warnEl.innerHTML = '';
  try {
    const res = await window.api.importUnpaidFile();
    if (res.canceled){ statusEl.textContent = ''; return; }
    if (!res.ok){ statusEl.textContent = '匯入失敗：' + (res.error || '未知錯誤'); return; }
    statusEl.textContent = '';
    warnEl.innerHTML = `<div class="import-result">${importResultHtml(`成功登記 ${res.createdCount} 筆未繳資料。`, res, res.warnings)}</div>`;
    await refreshUnpaid();
    await refreshHouseholds();
    await refreshChanges();
    await refreshSetup();
    await refreshPeriod();
  } catch (e) {
    statusEl.textContent = '匯入失敗：' + (e.message || e);
  }
});

// 匯入結果訊息：成功筆數＋黃色提醒＋可收合的略過清單（列號對應 Excel 左側列號）
function importResultHtml(okText, res, warningTexts){
  let html = `<strong>${okText}</strong>`;
  (warningTexts || []).forEach(w=>{ html += `<div class="warn-line">⚠ ${escHtml(w)}</div>`; });
  if (res.skipped && res.skipped.length){
    html += `<details><summary>略過 ${res.skipped.length} 筆（點開看原因）</summary>`
      + res.skipped.map(s=> (s.rowIndex ? `第${s.rowIndex}列：` : '') + escHtml(s.reason)).join('<br>') + '</details>';
  }
  return html;
}

// ---------- 預繳名單 ----------
async function refreshPrepaid(){
  const res = await window.api.getPrepaidList();
  const rows = res.ok ? res.rows : [];
  const opening = res.ok ? (res.currentOpening || []) : [];
  document.getElementById('btn-clear-prepaid').hidden = window.__isReadOnly || periodInfo.generated || !(rows.length || opening.length);
  const cp = res.currentPeriod;
  const { months, list } = pivotByHousehold(rows.concat(opening));
  const futureMonths = months.filter(m=>m !== cp);
  const hasCurrent = opening.length > 0;
  const headCur = hasCurrent ? `<th class="num-col" title="系統啟用前就已經繳了本期，不算預繳">${rocP(cp)}<span class="cell-sub">本期已繳（期初）</span></th>` : '';
  document.getElementById('prepaid-head').innerHTML =
    `<tr><th class="seq-col">序號</th><th>戶號</th>${headCur}${futureMonths.map(m=>`<th class="num-col">${rocP(m)}</th>`).join('')}<th class="num-col">預繳合計</th><th>備註</th></tr>`;
  if (!list.length){
    document.getElementById('prepaid-rows').innerHTML = `<tr><td colspan="${futureMonths.length+4+(hasCurrent?1:0)}" class="muted">目前沒有預繳資料。</td></tr>`;
    return;
  }
  const colTotals = futureMonths.map(()=>0);
  let grand = 0, curTotal = 0;
  const body = list.map((h,idx)=>{
    let sum = 0;
    let curCell = '';
    if (hasCurrent){
      const r = h.cells[cp];
      if (r){ curTotal += r.amountPaid; curCell = `<td class="num-col muted">$${fmt(r.amountPaid)}</td>`; } else curCell = '<td></td>';
    }
    const cells = futureMonths.map((m,i)=>{
      const r = h.cells[m];
      if (!r) return '<td></td>';
      sum += r.amountPaid; colTotals[i] += r.amountPaid;
      const partial = r.amountPaid < r.amountDue ? ` <span class="chip warning" title="應繳 $${fmt(r.amountDue)}，已繳 $${fmt(r.amountPaid)}">部分</span>` : '';
      return `<td class="num-col amt-prepaid">$${fmt(r.amountPaid)}${partial}</td>`;
    }).join('');
    grand += sum;
    return `<tr><td class="seq-col">${idx+1}</td><td>${escHtml(h.unit)}</td>${curCell}${cells}<td class="num-col amt-prepaid"><b>${sum?'$'+fmt(sum):''}</b></td><td class="muted">${escHtml([...h.notes].filter(n=>n!=='預繳名單匯入'&&n!=='本期已繳').join('、'))}</td></tr>`;
  }).join('');
  const totalRow = `<tr class="total-row"><td colspan="2"><b>合計（${list.length} 戶）</b></td>${hasCurrent?`<td class="num-col muted"><b>$${fmt(curTotal)}</b></td>`:''}${colTotals.map(t=>`<td class="num-col amt-prepaid"><b>${t?'$'+fmt(t):''}</b></td>`).join('')}<td class="num-col amt-prepaid"><b>$${fmt(grand)}</b></td><td></td></tr>`;
  document.getElementById('prepaid-rows').innerHTML = body + totalRow;
}

document.getElementById('btn-import-prepaid').addEventListener('click', async ()=>{
  const statusEl = document.getElementById('prepaid-import-status');
  const warnEl = document.getElementById('prepaid-warnings');
  statusEl.textContent = '匯入中…';
  warnEl.innerHTML = '';
  try {
    const res = await window.api.importPrepaidFile();
    if (res.canceled){ statusEl.textContent = ''; return; }
    if (!res.ok){ statusEl.textContent = '匯入失敗：' + (res.error || '未知錯誤'); return; }
    statusEl.textContent = '';
    const cp = res.currentPeriod || ''; const period = cp ? `${Number(cp.slice(0,4))-1911}/${cp.slice(5)}` : '';
    warnEl.innerHTML = `<div class="import-result">${importResultHtml(
      `成功登記 ${res.createdCount} 筆（本期 ${period} 之後的月份算預繳；本期欄有金額的登記為本期已繳）。`,
      res, (res.warnings || []).map(w=>w.message))}</div>`;
    await refreshPrepaid();
    await refreshHouseholds();
    await refreshChanges();
    await refreshSetup();
    await refreshPeriod();
  } catch (e) {
    statusEl.textContent = '匯入失敗：' + (e.message || e);
  }
});

// ---------- 月結報表 ----------
// ---------- 匯錯了：清除期初名單、復原銀行明細匯入 ----------
async function clearOpening(kind){
  const label = kind === 'unpaid' ? '期初未繳名單' : '期初預繳名單';
  const statusEl = document.getElementById(kind === 'unpaid' ? 'unpaid-import-status' : 'prepaid-import-status');
  if (!confirm(`確定要清除${label}嗎？\n\n清除後可以重新匯入正確的檔案。只有在產生本期帳款、匯入銀行明細之前才能清除。\n清除前會自動備份目前資料。`)) return;
  const r = kind === 'unpaid' ? await window.api.clearOpeningUnpaid() : await window.api.clearOpeningPrepaid();
  if (!r.ok){ statusEl.textContent = '清除失敗：' + r.error; return; }
  document.getElementById(kind === 'unpaid' ? 'unpaid-warnings' : 'prepaid-warnings').innerHTML = '';
  statusEl.textContent = `已清除${label}（${r.removed} 筆），可以重新匯入正確的檔案。`;
  await refreshUnpaid(); await refreshPrepaid(); await refreshHouseholds(); await refreshChanges(); await refreshSetup(); await refreshPeriod();
}
document.getElementById('btn-clear-unpaid').addEventListener('click', ()=> clearOpening('unpaid'));
document.getElementById('btn-clear-prepaid').addEventListener('click', ()=> clearOpening('prepaid'));

async function refreshBankImports(){
  const card = document.getElementById('bank-imports-card');
  const res = await window.api.getBankImports();
  const list = res.ok ? res.imports : [];
  card.hidden = !list.length;
  document.getElementById('bank-imports-rows').innerHTML = list.map(x=>`
    <tr>
      <td>${fmtTime(x.importedAt)}</td><td>${escHtml(x.filename)}</td>
      <td class="num-col">${x.count}</td><td class="num-col">$${fmt(x.amount)}</td>
      <td>${x.undoneAt ? `<span class="chip neutral">已復原（${fmtTime(x.undoneAt)}）</span>` : '<span class="chip success">已沖帳</span>'}</td>
      <td>${!x.undoneAt && x.canUndo && !window.__isReadOnly ? `<button class="btn secondary" data-undo-bank="${x.batchId}" style="color:var(--danger-tx); padding:4px 10px;">匯錯了，復原這次匯入</button>`
        : (!x.undoneAt && x.undoBlockedReason ? `<span class="muted">${escHtml(x.undoBlockedReason)}</span>` : '')}</td>
    </tr>`).join('');
  document.querySelectorAll('[data-undo-bank]').forEach(b=> b.onclick = async ()=>{
    const x = list.find(i=>i.batchId===Number(b.dataset.undoBank));
    if (!confirm(`確定要復原這次匯入嗎？\n\n${x.filename}：${x.count} 筆、共 $${fmt(x.amount)}\n這次匯入沖的帳會全部退回，之後可以重新匯入正確的檔案。\n復原前會自動備份目前資料。`)) return;
    const r = await window.api.undoBankImport(x.batchId);
    const st = document.getElementById('bank-undo-status');
    if (!r.ok){ st.textContent = '復原失敗：' + r.error; return; }
    st.textContent = `已復原「${r.filename}」：${r.count} 筆、$${fmt(r.amount)} 已退回，未繳、預繳名單已經更新。現在可以重新匯入正確的銀行明細。`;
    currentResults = []; currentUnmatched = [];
    ['bank-results','bank-unmatched','bank-rejected'].forEach(id=> document.getElementById(id).innerHTML = '');
    await refreshPeriod(); await refreshHouseholds(); await refreshUnpaid(); await refreshPrepaid(); await refreshIncome(); await refreshReceivables();
  });
}

async function refreshIncome(){
  await refreshBankImports();
  const res = await window.api.getIncomeDetail();
  const rows = res.ok ? res.rows : [];
  const sum = k => rows.reduce((t, r)=> t + (r[k] || 0), 0);
  const households = new Set(rows.map(r=>r.unit)).size;
  document.getElementById('income-rows').innerHTML = rows.length ? rows.map((r,idx)=>`
    <tr>
      <td class="seq-col">${idx+1}</td>
      <td>${rocD(r.date)}</td><td>${escHtml(r.unit || '')}</td><td>${escHtml(r.account || '')}</td><td>${rocRange(r.periodRange)}</td>
      <td>${r.prior?('$'+fmt(r.prior)):''}</td><td>${r.current?('$'+fmt(r.current)):''}</td>
      <td>${r.prepay?('$'+fmt(r.prepay)):''}</td><td><b>$${fmt(r.total)}</b></td>
    </tr>`).join('') + `
    <tr class="total-row">
      <td colspan="5"><b>合計（${rows.length} 筆入帳，${households} 戶）</b></td>
      <td><b>$${fmt(sum('prior'))}</b></td><td><b>$${fmt(sum('current'))}</b></td><td><b>$${fmt(sum('prepay'))}</b></td><td><b>$${fmt(sum('total'))}</b></td>
    </tr>` : `<tr><td colspan="9" class="muted">本期還沒有比對成功的入帳紀錄。</td></tr>`;
}

document.getElementById('btn-export-report').addEventListener('click', async ()=>{
  const statusEl = document.getElementById('report-export-status');
  statusEl.textContent = '匯出中…';
  try {
    const res = await window.api.exportMonthlyReport();
    if (res.canceled){ statusEl.textContent = ''; return; }
    if (!res.ok){ statusEl.textContent = '匯出失敗：' + (res.error || '未知錯誤'); return; }
    statusEl.textContent = `已下載：${res.filePath}（在瀏覽器的「下載」資料夾）`;
  } catch (e) {
    statusEl.textContent = '匯出失敗：' + (e.message || e);
  }
});

// ---------- 銀行明細比對 ----------
function showNeedGenerateMessage(){
  document.getElementById('bank-results').innerHTML = `
    <div class="card" style="border-color:var(--danger-tx);">
      <p style="color:var(--danger-tx); font-weight:600; margin-top:0;">還沒有本期帳款可以沖抵</p>
      <p class="muted">請先到「本期試算與核對」頁核對後產生本期帳款，才能在這裡跑沖帳比對。</p>
      <button class="btn" id="btn-jump-preview">前往「本期試算與核對」</button>
    </div>`;
  document.getElementById('bank-unmatched').innerHTML = '';
  document.getElementById('btn-jump-preview').addEventListener('click', ()=> switchTab('preview'));
}

function renderBankResults(){
  if (!currentResults.length && !currentUnmatched.length){
    document.getElementById('bank-results').innerHTML = `
      <div class="card" style="border-color:var(--danger-tx);">
        <p style="color:var(--danger-tx); font-weight:600; margin-top:0;">有讀到檔案，但沒有辨識出任何一筆交易</p>
        <p class="muted">請確認檔案裡有「虛擬帳號」和「存入金額」欄，而且金額是正數。上方如果有「沒有處理」的清單，可以看每一列的原因。</p>
      </div>`;
    document.getElementById('bank-unmatched').innerHTML = '';
    return;
  }
  const hasAnnual = rateSettings && rateSettings.annualDiscount > 0;
  const hasSemi = rateSettings && rateSettings.semiAnnualDiscount > 0;

  document.getElementById('bank-results').innerHTML = currentResults.map(r=>`
    <div class="result-card">
      <div class="row-between">
        <div><b>${escHtml(r.household.unit)}</b> ${r.manual?'<span class="chip pro">人工比對</span>':''}
          <div class="muted">${rocD(r.date)} · ${escHtml(r.account)}${r.remark && r.remark!==r.account?' · '+escHtml(r.remark):''}</div>${r.matchNote?`<div class="muted" style="font-size:11px;">${escHtml(r.matchNote)}</div>`:''}
        </div>
        <div><b>$${fmt(r.amount)}</b></div>
      </div>
      <div class="bar">${r.allocations.map(a=>{
        const w=(a.amount/r.amount*100).toFixed(1);
        const c = a.type==='前期補繳' ? 'var(--danger-tx)' : a.type==='當月管理費' ? 'var(--accent2-tx)' : a.type==='預繳管理費' ? 'var(--pro-tx)' : 'var(--danger-tx)';
        return `<div style="width:${w}%; background:${c};"></div>`;
      }).join('')}</div>
      ${r.allocations.map(a=>{
        const cls = a.type==='前期補繳'?'danger':a.type==='當月管理費'?'accent2':a.type==='預繳管理費'?'pro':'danger';
        return `<div class="row-between" style="font-size:12px; padding:2px 0;">
          <span><span class="chip ${cls}">${a.type}</span> <span class="muted">${a.period?rocP(a.period):'-'}</span></span>
          <span>$${fmt(a.amount)}</span>
        </div>`;
      }).join('')}
      ${(hasAnnual || hasSemi) && !window.__isReadOnly ? `
      <div class="row-between" style="margin-top:8px; padding-top:8px; border-top:1px solid var(--line);">
        <span class="muted">如果這筆是年繳/半年繳優惠（跟一般補繳/預繳不同），點這裡套用折扣：</span>
        <span style="display:flex; gap:6px;">
          ${hasAnnual ? `<button class="btn secondary" data-discount-tx="${r.transactionId}" data-discount-plan="annual">套用年繳優惠</button>` : ''}
          ${hasSemi ? `<button class="btn secondary" data-discount-tx="${r.transactionId}" data-discount-plan="semiAnnual">套用半年繳優惠</button>` : ''}
        </span>
      </div>
      <p class="muted" id="discount-status-${r.transactionId}" style="margin:6px 0 0;"></p>
      ` : ''}
    </div>
  `).join('');

  document.querySelectorAll('[data-discount-tx]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const txId = Number(btn.dataset.discountTx);
      const planType = btn.dataset.discountPlan;
      const label = planType === 'annual' ? '年繳優惠' : '半年繳優惠';
      if (!confirm(`確定要把這筆入帳套用「${label}」嗎？套用後，這幾期的應繳金額會改成優惠後的金額，並標記備註。`)) return;
      const statusEl = document.getElementById(`discount-status-${txId}`);
      const res = await window.api.applyDiscount(txId, planType);
      if (!res.ok){ statusEl.textContent = '套用失敗：' + res.error; return; }
      const r = res.result;
      let msg = `已套用${r.label}：${rocP(r.periods[0])}～${rocP(r.lastPeriod)} 共${r.periods.length}期，最後一期（${rocP(r.lastPeriod)}）應繳調整為 $${fmt(r.lastDue)}（原價$${fmt(r.fullFee)}）。`;
      if (r.mismatch){
        msg += ` 提醒：這筆實際入帳金額跟優惠總額差 $${fmt(Math.abs(r.mismatch.diff))}，請人工核對是否金額有誤。`;
      }
      statusEl.textContent = msg;
      await refreshUnpaid();
      await refreshPrepaid();
      await refreshHouseholds();
    });
  });

  document.getElementById('bank-unmatched').innerHTML = currentUnmatched.length ? `
    <div class="card" style="border-color:var(--danger-tx);">
      <p style="color:var(--danger-tx); font-weight:600;">${currentUnmatched.length} 筆無法比對戶號，待人工確認</p>
      ${currentUnmatched.map(u=>`
        <div class="row-between" style="padding:6px 0; border-top:1px solid var(--line);">
          <span class="muted">${rocD(u.date)} · ${escHtml(u.account)} · $${fmt(u.amount)}${u.remark?' · '+escHtml(u.remark):''}${u.reason?'<br><span style="color:var(--warning-tx);">'+escHtml(u.reason)+'</span>':''}</span>
          <select data-match-tx="${u.transactionId}" style="width:auto;" ${window.__isReadOnly ? 'disabled' : ''}>
            <option value="" selected disabled>指定住戶…</option>
            ${households.map(h=>`<option value="${h.id}">${escHtml(h.unit)}</option>`).join('')}
          </select>
        </div>`).join('')}
    </div>` : '';

  document.querySelectorAll('[data-match-tx]').forEach(sel=>{
    sel.addEventListener('change', async (e)=>{
      const txId = Number(e.target.dataset.matchTx);
      const householdId = Number(e.target.value);
      const res = await window.api.manualMatch(txId, householdId);
      if (!res.ok){ alert(res.error); return; }
      currentUnmatched = currentUnmatched.filter(u=>u.transactionId!==txId);
      currentResults.push(res.result);
      renderBankResults();
      await refreshHouseholds();
      await refreshUnpaid();
      await refreshPrepaid();
      await refreshIncome(); await refreshReceivables();
    });
  });
}

async function runReconciliation(fetcher){
  document.getElementById('bank-results').innerHTML = '<p class="muted">比對中…</p>';
  document.getElementById('bank-unmatched').innerHTML = '';
  try {
    periodInfo = await window.api.getPeriodStatus();
    if (!periodInfo.generated){
      showNeedGenerateMessage();
      return;
    }
    const res = await fetcher();
    if (res.canceled){
      document.getElementById('bank-results').innerHTML = '';
      return;
    }
    if (!res.ok){
      document.getElementById('bank-results').innerHTML = `<p class="muted" style="color:var(--danger-tx);">${escHtml(res.error||'匯入失敗，原因不明')}</p>`;
      return;
    }
    currentResults = res.results;
    currentUnmatched = res.unmatched;
    renderBankRejected(res.rejected || [], res.outOfRange || [], res.range, res.duplicates || []);
    await refreshPeriod();
    renderBankResults();
    await refreshHouseholds();
    await refreshUnpaid();
    await refreshPrepaid();
    await refreshIncome(); await refreshReceivables();
  } catch (e) {
    document.getElementById('bank-results').innerHTML = `<p class="muted" style="color:var(--danger-tx);">發生錯誤：${e.message || e}</p>`;
  }
}

document.getElementById('btn-pick-file').addEventListener('click', ()=>{
  runReconciliation(()=> window.api.pickBankFile());
});

// 帳號或金額有問題、不處理的列（負數、0 元、沒有帳號），一定列出來給人看
function renderBankRejected(list, outOfRange, range, duplicates){
  const el = document.getElementById('bank-rejected');
  let html = '';
  if (duplicates && duplicates.length){
    html += `<div class="card" style="border-color:var(--warning-tx);">
      <p style="color:var(--warning-tx); font-weight:600; margin:0 0 6px;">有 ${duplicates.length} 筆以前已經匯入過（日期、帳號、金額都相同），這次沒有重複沖帳：</p>
      ${duplicates.map(r=>`<div class="muted" style="padding:2px 0;">第${r.rowIndex}列：${escHtml(rocD(r.date))}　${escHtml(r.account)}　$${fmt(r.amount)}　— 已在「${escHtml(r.previousFile)}」匯入過</div>`).join('')}
    </div>`;
  }
  if (list.length){
    html += `<div class="card" style="border-color:var(--warning-tx);">
      <p style="color:var(--warning-tx); font-weight:600; margin:0 0 6px;">有 ${list.length} 列沒有處理，請確認是否正確：</p>
      ${list.map(r=>`<div class="muted" style="padding:2px 0;">第${r.rowIndex}列：${escHtml(rocD(r.date))}　${escHtml(r.account||'（無帳號）')}　$${fmt(r.amount||0)}　— ${escHtml(r.reason)}</div>`).join('')}
    </div>`;
  }
  if (outOfRange && outOfRange.length && range){
    html += `<div class="card" style="border-color:var(--warning-tx);">
      <p style="color:var(--warning-tx); font-weight:600; margin:0 0 6px;">有 ${outOfRange.length} 筆的交易日期不在本期範圍（${rocD(range.start)}～${rocD(range.end)}），已照常沖帳並算在本期，請確認是否匯錯月份的明細：</p>
      ${outOfRange.map(r=>`<div class="muted" style="padding:2px 0;">${escHtml(rocD(r.date))}　${escHtml(r.account)}　$${fmt(r.amount)}</div>`).join('')}
    </div>`;
  }
  el.innerHTML = html;
}

// ---------- 授權與唯讀 ----------
// 授權有效＝正常使用；授權到期＝唯讀（可以查看、匯出月結報表、備份，不能匯入或修改帳務）。
// 後端也會擋，這裡停用按鈕只是讓畫面一看就知道不能按。
let licenseState = null;

function applyReadOnly(readOnly){
  window.__isReadOnly = readOnly;
  const mutatingButtonIds = [
    'btn-import-households', 'btn-save-rates', 'btn-generate',
    'btn-pick-file', 'btn-import-unpaid', 'btn-import-prepaid', 'btn-clear-unpaid', 'btn-clear-prepaid', 'btn-delete-household',
    'btn-restore-file', 'btn-save-community', 'btn-close-period',
  ];
  mutatingButtonIds.forEach(id=>{
    const el = document.getElementById(id);
    if (el) el.disabled = window.__isReadOnly;
  });
  // 清空資料、還原示範資料只在示範版提供；正式版看不到
  document.getElementById('blank-community-card').style.display = (window.__isReadOnly || !appInfo.isDemo) ? 'none' : 'block';
  document.getElementById('reset-demo-card').style.display = (window.__isReadOnly || !appInfo.isDemo) ? 'none' : 'block';
}

document.getElementById('btn-reset-demo').addEventListener('click', async ()=>{
  if (!confirm('確定要還原成示範資料嗎？\n\n目前所有住戶、帳款、銀行明細都會換回內建的「幸福花園社區（示範）」。\n還原前會自動備份目前資料。')) return;
  const statusEl = document.getElementById('reset-demo-status');
  const res = await window.api.resetData();
  if (!res.ok){ statusEl.textContent = '還原失敗：' + (res.error || '未知錯誤'); return; }
  currentResults = []; currentUnmatched = [];
  ['bank-results','bank-unmatched','bank-rejected','unpaid-warnings','prepaid-warnings'].forEach(id=> document.getElementById(id).innerHTML = '');
  ['bank-status','unpaid-import-status','prepaid-import-status','generate-status','close-status','report-export-status'].forEach(id=> document.getElementById(id).textContent = '');
  showImportResult('');
  await init();
  statusEl.textContent = '已還原成示範資料。還原前的資料已自動備份（' + (res.safetyBackupPath || '') + '）。';
});

// 每次重新整理畫面（init）都會先跑這裡：結帳進入下一期、輸入新授權碼後，唯讀狀態會跟著更新。
async function refreshLicense(){
  const s = await window.api.getLicenseStatus();
  if (!s.ok) return;
  licenseState = s;
  applyReadOnly(!s.active);

  const badge = document.getElementById('license-badge');
  if (s.active){
    badge.textContent = `授權至 ${rocP(s.until)} 期`;
    badge.className = 'chip success';
  } else {
    badge.textContent = s.status === 'missing' ? '尚未設定授權・唯讀模式' : '授權到期・唯讀模式';
    badge.className = 'chip danger';
  }

  const banner = document.getElementById('license-banner');
  if (!s.active){
    banner.className = 'card license-banner expired';
    banner.innerHTML = `<b>授權已到期，目前是唯讀模式。</b>${escHtml(s.message)}<br>`
      + `仍然可以查看資料、匯出月結報表、下載備份，但不能匯入或修改帳務。請聯絡系統提供者延長授權。`;
    banner.hidden = false;
  } else if (s.isLastPeriod){
    banner.className = 'card license-banner notice';
    banner.innerHTML = `授權使用至 <b>${rocP(s.until)}</b> 期。這一期可以照常做完月結；<b>本期結帳後需要延長授權</b>才能繼續記帳，請事先聯絡系統提供者。`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  document.getElementById('license-info').innerHTML = `
    <p class="muted" style="margin:2px 0;">狀態：${s.active ? '<span class="chip success">有效</span>' : '<span class="chip danger">到期（唯讀）</span>'}　${escHtml(s.message)}</p>
    <p class="muted" style="margin:2px 0;">授權期別那一期可以完整做完月結；結帳進入下一期，或超過期限（授權期別結束後 ${s.graceDays} 天）時，系統會改成唯讀，資料不會消失。</p>`;
}

// ---------- 開啟流程：登入（login.html）→ 選社區 → 進入系統 ----------
function showOnly(id){
  ['boot-loading', 'no-community', 'app-shell'].forEach(x=>{
    document.getElementById(x).style.display = x === id ? 'block' : 'none';
  });
}

let me = null;
function refreshPasswordStatus(){
  document.getElementById('password-status').textContent = me
    ? `目前登入：${me.user.displayName || me.user.login}（帳號 ${me.user.login}，${me.user.roleLabel}${me.user.companyName ? '，' + me.user.companyName : ''}）`
    : '';
}

async function enterApp(){
  showOnly('app-shell');
  await init();
  refreshPasswordStatus();
}

async function logout(){
  await window.api.logout();
  location.href = '/login';
}

async function boot(){
  me = await window.api.me();
  if (!me.ok){ location.href = '/login'; return; }
  document.getElementById('user-label').textContent = me.user.displayName || me.user.login;
  document.getElementById('link-admin').hidden = !['super_admin','company_admin'].includes(me.user.role);
  if (!me.communities.length){
    if (me.user.role !== 'community_user') document.getElementById('no-community-msg').innerHTML = '目前還沒有任何社區。<a href="/admin">前往後台管理</a>新增社區。';
    showOnly('no-community');
    return;
  }
  const ids = me.communities.map(c=>c.id);
  const wanted = [window.api.currentCommunity(), window.api.lastCommunity()].find(id=> id && ids.includes(id)) || ids[0];
  window.api.setCommunity(wanted);
  const sw = document.getElementById('community-switch');
  sw.hidden = me.communities.length < 2;
  const multiCompany = new Set(me.communities.map(c=>c.companyName)).size > 1;
  sw.innerHTML = me.communities.map(c=>`<option value="${c.id}">${escHtml(multiCompany ? c.companyName + '｜' + c.name : c.name)}${c.edition==='demo' && !c.name.includes('示範')?'（示範）':''}</option>`).join('');
  sw.value = String(wanted);
  history.replaceState(null, '', `/?c=${wanted}`);
  await enterApp();
}

// 切換社區：重新載入頁面，畫面上所有狀態都換成新社區的
document.getElementById('community-switch').addEventListener('change', e=>{
  window.api.setCommunity(e.target.value);
  location.href = `/?c=${Number(e.target.value)}`;
});
document.getElementById('btn-logout').addEventListener('click', logout);
document.getElementById('btn-logout-empty').addEventListener('click', logout);

document.getElementById('btn-start-blank').addEventListener('click', async ()=>{
  const statusEl = document.getElementById('blank-status');
  if (document.getElementById('blank-confirm').value.trim() !== '清空'){
    statusEl.textContent = '請先在左邊欄位輸入「清空」兩個字，確認你真的要清空目前所有資料。';
    return;
  }
  statusEl.textContent = '處理中…';
  const res = await window.api.startBlankCommunity();
  if (!res.ok){ statusEl.textContent = '清空失敗：' + (res.error || '未知錯誤'); return; }
  document.getElementById('blank-confirm').value = '';
  showImportResult('');
  await init();
  statusEl.textContent = '已清空，現在是空白社區。清空前的資料已自動備份（' + (res.safetyBackupPath || '') + '）'
    + '。下一步：先到「費率設定」新增社區的類型與每坪單價，再到「住戶總覽」匯入住戶資料。';
});

document.getElementById('btn-save-password').addEventListener('click', async ()=>{
  const currentPassword = document.getElementById('pw-current').value;
  const newPassword = document.getElementById('pw-new').value;
  const statusEl = document.getElementById('password-save-status');
  const res = await window.api.changeMyPassword(currentPassword, newPassword);
  if (!res.ok){ statusEl.textContent = '變更失敗：' + res.error; return; }
  document.getElementById('pw-current').value = '';
  document.getElementById('pw-new').value = '';
  statusEl.textContent = '密碼已變更。其他裝置上的登入已經自動登出。';
});

// ---------- 備份與還原 ----------
function fmtBytes(n){
  if (!n) return '0 KB';
  const kb = n / 1024;
  if (kb < 1024) return Math.round(kb) + ' KB';
  return (kb / 1024).toFixed(1) + ' MB';
}
function fmtTime(iso){
  if (!iso) return '';
  return new Date(iso).toLocaleString('zh-TW', { hour12: false });
}

const SNAPSHOT_REASONS = {
  'auto-daily': '每日自動備份', 'before-restore': '還原前自動備份', 'before-undo-bank': '復原銀行明細匯入前',
  'before-clear-unpaid': '清除期初未繳名單前', 'before-clear-prepaid': '清除期初預繳名單前', 'before-undo-households': '復原住戶匯入前',
  'before-reset-demo': '還原示範資料前', 'before-new-community': '清空社區前',
};
function snapshotLabel(b){
  if (SNAPSHOT_REASONS[b.reason]) return SNAPSHOT_REASONS[b.reason];
  const m = String(b.reason).match(/^before-close-(\d{4}-\d{2})$/);
  return m ? `${rocP(m[1])} 結帳前` : b.reason;
}

async function refreshBackup(){
  const res = await window.api.getBackupStatus();
  if (!res.ok){
    document.getElementById('backup-info').innerHTML = `<p class="muted" style="color:var(--danger-tx);">讀取備份狀態失敗：${escHtml(res.error||'未知錯誤')}</p>`;
    return;
  }
  const s = res.status;
  document.getElementById('backup-info').innerHTML = `
    <p class="muted">資料大小：${fmtBytes(s.dataSize)}　最後更新時間：${fmtTime(s.updatedAt)}</p>
  `;
  document.getElementById('backup-rows').innerHTML = s.backups.map(b => `
    <tr>
      <td>${escHtml(snapshotLabel(b))}<span class="cell-sub">${escHtml(b.label)}</span></td>
      <td>${fmtTime(b.createdAt)}</td>
      <td>${fmtBytes(b.size)}</td>
      <td><button class="link" data-download-snap="${b.id}">下載</button>
        ${window.__isReadOnly ? '' : `<button class="btn secondary" data-restore-auto="${b.id}" data-restore-name="${escHtml(snapshotLabel(b) + ' ' + fmtTime(b.createdAt))}">還原這份備份</button>`}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="muted">目前還沒有自動備份，第一次修改資料後就會自動產生。</td></tr>`;

  document.querySelectorAll('[data-download-snap]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const r = await window.api.downloadSnapshot(btn.dataset.downloadSnap);
      if (!r.ok) alert(r.error);
    });
  });
  document.querySelectorAll('[data-restore-auto]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const name = btn.getAttribute('data-restore-name');
      if (!confirm(`確定要用這份備份（${name}）覆蓋目前的資料嗎？\n\n還原前系統會自動先把「目前的資料」也存一份備份，還原後如果發現不對，可以再從那份備份救回來。`)) return;
      const statusEl = document.getElementById('backup-action-status');
      statusEl.textContent = '還原中…';
      try {
        const r = await window.api.restoreFromAuto(Number(btn.dataset.restoreAuto));
        if (!r.ok){ statusEl.textContent = '還原失敗：' + (r.error || '未知錯誤'); return; }
        await init();
        statusEl.textContent = `已還原完成。還原前的資料已自動備份（${r.safetyBackupPath}）。`;
      } catch (e) {
        statusEl.textContent = '還原失敗：' + (e.message || e);
      }
    });
  });
}

document.getElementById('btn-export-backup').addEventListener('click', async ()=>{
  const statusEl = document.getElementById('backup-action-status');
  statusEl.textContent = '下載中…';
  const res = await window.api.exportBackup();
  if (!res.ok){ statusEl.textContent = '下載失敗：' + (res.error || '未知錯誤'); return; }
  statusEl.textContent = `已下載：${res.destPath}（在瀏覽器的「下載」資料夾）。請另外存到隨身碟或雲端硬碟。`;
});

document.getElementById('btn-restore-file').addEventListener('click', async ()=>{
  if (!confirm('選擇的備份檔案會覆蓋目前的資料，確定要繼續嗎？\n\n還原前系統會自動先把「目前的資料」也存一份備份。')) return;
  const statusEl = document.getElementById('backup-action-status');
  try {
    const res = await window.api.restoreFromFile();
    if (res.canceled){ return; }
    if (!res.ok){ statusEl.textContent = '還原失敗：' + (res.error || '未知錯誤'); return; }
    await init();
    statusEl.textContent = `已還原完成。還原前的資料已自動備份（${res.safetyBackupPath}）。`;
  } catch (e) {
    statusEl.textContent = '還原失敗：' + (e.message || e);
  }
});


// ---------- 社區名稱 ----------
async function refreshCommunity(){
  const info = await window.api.getCommunityInfo();
  const name = (info && info.name) || '';
  document.getElementById('community-name').value = name;
  document.getElementById('header-title').textContent = name ? `社區AI帳房｜${name}` : '社區AI帳房';
}

document.getElementById('btn-save-community').addEventListener('click', async ()=>{
  const statusEl = document.getElementById('community-save-status');
  const res = await window.api.saveCommunityInfo({ name: document.getElementById('community-name').value });
  if (!res.ok){ statusEl.textContent = res.error; return; }
  const pSel = document.getElementById('current-period');
  const pr = await window.api.savePeriodSettings({
    closingDay: Number(document.getElementById('closing-day').value),
    currentPeriod: pSel.disabled ? undefined : pSel.value,
  });
  if (!pr.ok){ statusEl.textContent = pr.error; return; }
  statusEl.textContent = '社區設定已儲存。';
  periodInfo = await window.api.getPeriodStatus();
  await refreshCommunity();
  await refreshPeriod();
  await refreshRates();
  await refreshChanges();
  await refreshSetup();
});

// ---------- 開帳檢查清單 ----------
async function refreshSetup(){
  const card = document.getElementById('setup-card');
  const res = await window.api.getSetupStatus();
  if (!res.ok || res.allDone || window.__isReadOnly){ card.hidden = true; return; }
  card.hidden = false;
  document.getElementById('setup-list').innerHTML = res.items.map(i=>{
    const state = i.done
      ? `<span class="step-state ok">${i.none ? '已確認沒有' : '完成'}</span>`
      : `<span class="step-state todo">未完成</span>`;
    const go = !i.done ? `<button class="link" data-setup-go="${i.where}">前往</button>` : '';
    const none = i.canMarkNone && !i.done
      ? `<button class="link" data-setup-none="${i.key}">本社區沒有${i.key==='unpaid'?'期初欠繳':'期初預繳'}</button>` : '';
    const undo = i.canMarkNone && i.none ? `<button class="link" data-setup-undo="${i.key}">取消</button>` : '';
    return `<li class="${i.done?'done':''}"><span class="step-label">${escHtml(i.label)}</span>${state} ${go} ${none} ${undo}</li>`;
  }).join('');
  document.querySelectorAll('[data-setup-go]').forEach(b=> b.onclick = ()=> switchTab(b.dataset.setupGo));
  document.querySelectorAll('[data-setup-none]').forEach(b=> b.onclick = async ()=>{ await window.api.markSetupNone(b.dataset.setupNone, true); await refreshSetup(); });
  document.querySelectorAll('[data-setup-undo]').forEach(b=> b.onclick = async ()=>{ await window.api.markSetupNone(b.dataset.setupUndo, false); await refreshSetup(); });
}

// ---------- 下載空白範本 ----------
document.querySelectorAll('[data-template]').forEach(btn=>{
  btn.addEventListener('click', async ()=>{
    const res = await window.api.saveTemplate(btn.dataset.template);
    if (res.canceled) return;
    if (!res.ok) alert(`下載失敗：${res.error}`);
  });
});

// ---------- 示範社區：下載示範檔案 ----------
document.querySelectorAll('[data-demo-sample]').forEach(btn=>{
  btn.addEventListener('click', async ()=>{
    const res = await window.api.downloadDemoSample(btn.dataset.demoSample);
    if (!res.ok) alert(res.error);
  });
});

boot();
