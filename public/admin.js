// 後台管理畫面
function escHtml(t){ return String(t == null ? '' : t).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmt(n){ return Math.round(n || 0).toLocaleString('zh-TW'); }
function rocP(p){ const m = String(p||'').match(/^(\d{4})-(\d{2})/); return m ? `${Number(m[1])-1911}/${m[2]}` : ''; }
function fmtTime(iso){ return iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : ''; }
function monthsBetween(a, b){ const [ay, am] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + (bm - am); }

async function api(method, url, body){
  try {
    const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    if (res.status === 401){ location.href = '/login'; return new Promise(()=>{}); }
    return await res.json();
  } catch (e) {
    return { ok: false, error: '連不上伺服器，請確認網路連線後再試一次。' };
  }
}

document.querySelectorAll('.tab-btn').forEach(btn=> btn.addEventListener('click', ()=>{
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  if (btn.dataset.tab === 'audit') loadAudit();
}));

let data = null;
let me = null;
const ROLE_LABEL = { super_admin: '樓管家管理者', company_admin: '物業公司管理者', community_user: '社區經理／秘書' };
const companyName = id => (data.companies.find(c=>c.id===id) || {}).name || '';
const communityName = id => (data.communities.find(c=>c.id===id) || {}).name || `#${id}`;

async function load(){
  const m = await api('GET', '/api/me');
  if (!m.ok){ location.href = '/login'; return; }
  me = m.user;
  if (!['super_admin','company_admin'].includes(me.role)){ location.href = '/'; return; }
  document.getElementById('user-label').textContent = `${me.displayName || me.login}（${me.roleLabel}）`;
  data = await api('GET', '/api/admin/overview');
  if (!data.ok){ document.getElementById('header-sub').textContent = data.error; return; }
  document.getElementById('header-sub').textContent = data.isSuper
    ? `共 ${data.companies.length} 家物業公司、${data.communities.length} 個社區`
    : `${me.companyName || ''}：${data.communities.length} 個社區`;
  document.querySelectorAll('.super-only').forEach(el=> el.hidden = !data.isSuper);
  renderCommunities();
  renderCompanies();
  renderUsers();
  renderNewUserForm();
  renderAuditFilter();
}

// ---------- 社區總覽 ----------
function renderCommunities(){
  const curToday = data.today.slice(0, 7);
  document.getElementById('community-rows').innerHTML = data.communities.map(c=>{
    // 示範社區的資料固定在 115/07，不提醒落後
    const lag = c.behind >= 2 && c.edition !== 'demo' ? `<span class="chip warning" title="本期落後今天 ${c.behind} 期">落後 ${c.behind} 期</span>` : '';
    const lic = !c.licenseUntil ? '<span class="chip danger">未設定</span>'
      : c.licenseActive
        ? `<span class="chip ${monthsBetween(curToday, c.licenseUntil) <= 1 ? 'warning' : 'success'}">至 ${rocP(c.licenseUntil)}</span>`
        : `<span class="chip danger" title="${escHtml(c.licenseMessage)}">到期（唯讀）</span>`;
    return `<tr${c.active ? '' : ' class="row-inactive"'}>
      <td>${escHtml(companyName(c.companyId))}</td>
      <td><a href="/?c=${c.id}">${escHtml(c.name)}</a>${c.edition === 'demo' ? ' <span class="chip edition-chip">示範</span>' : ''}${c.active ? '' : ' <span class="chip neutral">停用</span>'}</td>
      <td>${rocP(c.currentPeriod)} ${lag}</td>
      <td>${c.generated ? '<span class="chip success">已產生</span>' : '<span class="chip neutral">未產生</span>'}</td>
      <td class="num-col">${c.households}</td>
      <td class="num-col">${c.unpaidHouseholds || ''}</td>
      <td class="num-col ${c.unpaidAmount ? 'amt-owed' : ''}">${c.unpaidAmount ? '$' + fmt(c.unpaidAmount) : ''}</td>
      <td>${lic}</td>
      <td class="muted">${fmtTime(c.updatedAt)}</td>
      <td>${data.isSuper ? `<button class="link" data-edit-community="${c.id}">設定</button>` : ''}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="muted">目前還沒有社區。</td></tr>';
  document.querySelectorAll('[data-edit-community]').forEach(b=> b.onclick = ()=> openEditCommunity(Number(b.dataset.editCommunity)));

  document.getElementById('nc-company').innerHTML = data.companies.map(c=>`<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
}

let editingCommunity = null;
function openEditCommunity(id){
  const c = data.communities.find(x=>x.id===id);
  editingCommunity = c;
  document.getElementById('ec-title').textContent = `社區設定：${c.name}`;
  document.getElementById('ec-name').value = c.name;
  document.getElementById('ec-license').value = c.licenseUntil || '';
  document.getElementById('ec-active').value = c.active ? '1' : '0';
  document.getElementById('ec-status').textContent = '';
  const card = document.getElementById('edit-community-card');
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
document.getElementById('btn-cancel-community').onclick = ()=>{ document.getElementById('edit-community-card').hidden = true; };
document.getElementById('btn-save-community').onclick = async ()=>{
  const r = await api('PATCH', `/api/admin/communities/${editingCommunity.id}`, {
    name: document.getElementById('ec-name').value,
    licenseUntil: document.getElementById('ec-license').value || null,
    active: document.getElementById('ec-active').value === '1',
  });
  if (!r.ok){ document.getElementById('ec-status').textContent = r.error; return; }
  document.getElementById('edit-community-card').hidden = true;
  await load();
};

document.getElementById('btn-new-community').onclick = async ()=>{
  const st = document.getElementById('nc-status');
  const r = await api('POST', '/api/admin/communities', {
    companyId: Number(document.getElementById('nc-company').value),
    name: document.getElementById('nc-name').value,
    edition: document.getElementById('nc-edition').value,
    licenseUntil: document.getElementById('nc-license').value || null,
  });
  if (!r.ok){ st.textContent = r.error; return; }
  document.getElementById('nc-name').value = '';
  st.textContent = '社區已新增。接著到「帳號管理」新增這個社區的經理／秘書帳號。';
  await load();
};

function renderCompanies(){
  document.getElementById('company-list').innerHTML = data.companies.map(c=>{
    const n = data.communities.filter(x=>x.companyId===c.id).length;
    return `<div class="row-between" style="padding:4px 0; border-top:1px solid var(--line-soft);"><span>${escHtml(c.name)}</span><span>${n} 個社區</span></div>`;
  }).join('') || '目前還沒有物業公司。';
}
document.getElementById('btn-new-company').onclick = async ()=>{
  const st = document.getElementById('company-status');
  const r = await api('POST', '/api/admin/companies', { name: document.getElementById('new-company-name').value });
  if (!r.ok){ st.textContent = r.error; return; }
  document.getElementById('new-company-name').value = '';
  st.textContent = '已新增。';
  await load();
};

// ---------- 帳號 ----------
function renderUsers(){
  document.getElementById('user-rows').innerHTML = data.users.map(u=>{
    const comms = u.role === 'community_user'
      ? (u.communityIds.map(communityName).map(escHtml).join('、') || '<span class="muted">（還沒指派）</span>')
      : u.role === 'company_admin' ? '<span class="muted">公司所有社區</span>' : '<span class="muted">全部</span>';
    const canEdit = data.isSuper || u.role === 'community_user';
    return `<tr${u.active ? '' : ' class="row-inactive"'}>
      <td>${escHtml(u.login)}</td><td>${escHtml(u.displayName)}</td><td>${escHtml(u.roleLabel)}</td>
      <td>${escHtml(companyName(u.companyId))}</td><td>${comms}</td>
      <td>${u.active ? '<span class="chip success">使用中</span>' : '<span class="chip neutral">停用</span>'}</td>
      <td class="muted">${fmtTime(u.lastLoginAt)}</td>
      <td>${canEdit ? `<button class="link" data-edit-user="${u.id}">修改</button>` : ''}</td>
    </tr>`;
  }).join('');
  document.querySelectorAll('[data-edit-user]').forEach(b=> b.onclick = ()=> openEditUser(Number(b.dataset.editUser)));
}

function communityChecks(companyId, selected){
  const list = data.communities.filter(c=>c.companyId===companyId && c.active);
  if (!list.length) return '<span class="muted">這家公司還沒有社區。</span>';
  return list.map(c=>`<label class="check"><input type="checkbox" value="${c.id}" ${selected.includes(c.id) ? 'checked' : ''}> ${escHtml(c.name)}</label>`).join('');
}
const checkedIds = el => [...el.querySelectorAll('input[type=checkbox]:checked')].map(i=>Number(i.value));

let editingUser = null;
function openEditUser(id){
  const u = data.users.find(x=>x.id===id);
  editingUser = u;
  document.getElementById('eu-title').textContent = `修改帳號：${u.login}（${u.roleLabel}）`;
  document.getElementById('eu-name').value = u.displayName;
  document.getElementById('eu-password').value = '';
  document.getElementById('eu-active').value = u.active ? '1' : '0';
  document.getElementById('eu-communities-wrap').hidden = u.role !== 'community_user';
  document.getElementById('eu-communities').innerHTML = communityChecks(u.companyId, u.communityIds);
  document.getElementById('eu-status').textContent = '';
  const card = document.getElementById('edit-user-card');
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
document.getElementById('btn-cancel-user').onclick = ()=>{ document.getElementById('edit-user-card').hidden = true; };
document.getElementById('btn-save-user').onclick = async ()=>{
  const body = { displayName: document.getElementById('eu-name').value, active: document.getElementById('eu-active').value === '1' };
  const pw = document.getElementById('eu-password').value;
  if (pw) body.password = pw;
  if (editingUser.role === 'community_user') body.communityIds = checkedIds(document.getElementById('eu-communities'));
  const r = await api('PATCH', `/api/admin/users/${editingUser.id}`, body);
  if (!r.ok){ document.getElementById('eu-status').textContent = r.error; return; }
  document.getElementById('edit-user-card').hidden = true;
  await load();
};

function renderNewUserForm(){
  const roles = data.isSuper ? ['community_user', 'company_admin', 'super_admin'] : ['community_user'];
  const roleSel = document.getElementById('nu-role');
  const keepRole = roleSel.value;
  roleSel.innerHTML = roles.map(r=>`<option value="${r}">${ROLE_LABEL[r]}</option>`).join('');
  if (roles.includes(keepRole)) roleSel.value = keepRole;
  const coSel = document.getElementById('nu-company');
  const keepCo = coSel.value;
  coSel.innerHTML = data.companies.map(c=>`<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
  if (keepCo) coSel.value = keepCo;
  syncNewUserForm();
}
function syncNewUserForm(){
  const role = document.getElementById('nu-role').value;
  document.getElementById('nu-company-wrap').hidden = !data.isSuper || role === 'super_admin';
  document.getElementById('nu-communities-wrap').hidden = role !== 'community_user';
  const companyId = data.isSuper ? Number(document.getElementById('nu-company').value) : (data.companies[0] || {}).id;
  document.getElementById('nu-communities').innerHTML = communityChecks(companyId, []);
}
document.getElementById('nu-role').onchange = syncNewUserForm;
document.getElementById('nu-company').onchange = syncNewUserForm;
document.getElementById('btn-new-user').onclick = async ()=>{
  const st = document.getElementById('nu-status');
  const role = document.getElementById('nu-role').value;
  const r = await api('POST', '/api/admin/users', {
    login: document.getElementById('nu-login').value,
    displayName: document.getElementById('nu-name').value,
    password: document.getElementById('nu-password').value,
    role,
    companyId: Number(document.getElementById('nu-company').value),
    communityIds: role === 'community_user' ? checkedIds(document.getElementById('nu-communities')) : [],
  });
  if (!r.ok){ st.textContent = r.error; return; }
  ['nu-login','nu-name','nu-password'].forEach(id=> document.getElementById(id).value = '');
  st.textContent = '帳號已新增。請把帳號和密碼交給使用者，並提醒他第一次登入後到「備份・帳號」頁變更密碼。';
  await load();
};

// ---------- 操作紀錄 ----------
function renderAuditFilter(){
  const sel = document.getElementById('audit-community');
  const keep = sel.value;
  sel.innerHTML = `<option value="">全部社區</option>` + data.communities.map(c=>`<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
  sel.value = keep;
}
document.getElementById('audit-community').onchange = loadAudit;
function detailText(d){
  if (!d) return '';
  return Object.entries(d).map(([k, v])=> `${k}: ${Array.isArray(v) ? v.join(',') : v}`).join('；');
}
async function loadAudit(){
  const cid = document.getElementById('audit-community').value;
  const r = await api('GET', '/api/admin/audit' + (cid ? `?communityId=${cid}` : ''));
  document.getElementById('audit-rows').innerHTML = r.ok ? (r.rows.map(a=>`
    <tr><td>${fmtTime(a.at)}</td><td>${escHtml(a.community_name || '')}</td><td>${escHtml(a.display_name || a.login || '')}</td>
      <td>${escHtml(a.action)}</td><td class="muted">${escHtml(detailText(a.detail))}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">沒有紀錄。</td></tr>')
    : `<tr><td colspan="5" class="muted">${escHtml(r.error)}</td></tr>`;
}

document.getElementById('btn-logout').onclick = async ()=>{
  await api('POST', '/api/auth/logout');
  location.href = '/login';
};

load();
