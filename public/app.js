const q = (selector, root = document) => root.querySelector(selector);
const workspace = q('#workspace');
const dialog = q('#dialog');
const live = q('#live');
const timezones = {'Asia/Macau':'澳門 UTC+8','Asia/Hong_Kong':'香港 UTC+8','Asia/Taipei':'台北 UTC+8','Asia/Singapore':'新加坡 UTC+8','Asia/Tokyo':'東京 UTC+9','UTC':'UTC'};
const personas = [
  ['manager','林澄','主管 · 張貼及確認補班'],
  ['worker1','何小嵐','員工 · 接待、盤點'],
  ['worker2','周木生','員工 · 補貨、場務'],
  ['worker3','梁雨禾','員工 · 接待、場務']
];
const statuses = {open:'徵求中',filled:'已安排',canceled:'已取消', pending:'待回覆',confirmed:'已確認',declined:'未獲選',withdrawn:'已撤回'};
const state = {data:null,tab:'board',filter:'all',expanded:new Set(),busy:false};
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const h = escapeHTML;
const duration = mins => {
  const hours = Math.floor(mins / 60), rest = mins % 60;
  return [hours > 0 ? hours + ' 小時' : '', rest > 0 ? rest + ' 分鐘' : ''].filter(Boolean).join(' ');
};
const isManager = () => state.data?.user?.role === 'manager';
function localLabel(value, includeDate = true) {
  if (!value) return '';
  const [date, hhmm] = value.split('T');
  return includeDate ? date.replaceAll('-','/') + ' ' + hhmm : hhmm;
}
function instantLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(+date)) return String(value);
  return new Intl.DateTimeFormat('zh-Hant', {timeZone:'Asia/Macau',dateStyle:'medium',timeStyle:'short',hourCycle:'h23'}).format(date) + '（澳門）';
}
function formatRange(shift) {
  const crossDay = shift.start.slice(0,10) !== shift.end.slice(0,10);
  return localLabel(shift.start) + ' 至 ' + localLabel(shift.end,crossDay) + (crossDay ? '（跨日）' : '');
}
const timeOffsets = {'Asia/Macau':8,'Asia/Hong_Kong':8,'Asia/Taipei':8,'Asia/Singapore':8,'Asia/Tokyo':9,'UTC':0};
function instantFor(local, zone) {
  return Date.parse(local + 'Z') - timeOffsets[zone] * 3600000;
}
function workerConflict(shift) {
  return state.data.shifts.find(other => other.id !== shift.id && other.status === 'filled' && other.application?.status === 'confirmed'
    && instantFor(other.start, other.timezone) < instantFor(shift.end, shift.timezone)
    && instantFor(shift.start, shift.timezone) < instantFor(other.end, other.timezone));
}
function pill(status) {
  return `<span class="pill ${h(status)}">${h(statuses[status] || status)}</span>`;
}
function tags(skills) {
  return skills?.length ? `<div class="tags">${skills.map(s=>`<span class="tag">${h(s)}</span>`).join('')}</div>` : '<p class="subtle">無指定技能</p>';
}
function personasMarkup() {
  return `<div class="personas">${personas.map(([id,name,detail])=>`<button type="button" class="persona" data-action="login" data-id="${id}"><span class="avatar" aria-hidden="true">${name[0]}</span><span>${name}<small>${detail}</small></span></button>`).join('')}</div>`;
}
function empty(title, note, symbol = '○') {
  return `<div class="empty"><div class="empty-symbol" aria-hidden="true">${symbol}</div><h3>${h(title)}</h3><p>${h(note)}</p></div>`;
}
function button(action, label, id = '', kind = 'ghost', other = '') {
  return `<button type="button" class="${kind}" data-action="${action}" data-id="${h(id)}" ${other}>${label}</button>`;
}
function candidateMarkup(c, shift) {
  const actionable = c.status === 'pending' && shift.status === 'open';
  return `<article class="candidate" aria-label="${h(c.name)}"><div class="candidate-row"><strong>${h(c.name)}</strong>${pill(c.status)}</div>
    ${tags(c.skills)}
    ${c.mismatch?.length && actionable ? `<p class="warn">技能未完全相符：尚未列出 ${h(c.mismatch.join('、'))}。這是提醒，不會自動排除。</p>` : ''}
    ${c.conflict && actionable ? `<p class="warn">時段衝突，無法確認。與「${h(c.conflict.location)}」已確認的班次重疊：${h(formatRange(c.conflict))}（${h(timezones[c.conflict.timezone] || c.conflict.timezone)}）。</p>` : ''}
    ${actionable ? `<div class="actions">${button('confirm','確認補班',shift.id,'solid',`data-candidate="${h(c.id)}" ${c.conflict ? 'disabled' : ''}`)}${button('decline','拒絕候選',shift.id,'ghost',`data-candidate="${h(c.id)}"`)}</div>` : ''}
  </article>`;
}
function shiftMarkup(shift) {
  const [,,day] = shift.start.slice(0,10).split('-');
  const month = Number(shift.start.slice(5,7));
  const app = shift.application;
  const conflict = !isManager() && shift.status === 'open' && workerConflict(shift);
  const mismatch = !isManager() && (shift.skills || []).filter(skill => !state.data.user.skills.includes(skill));
  const actions = !isManager() && shift.status === 'open' && [
    (!app || app.status === 'withdrawn') ? button('apply',app ? '再次自願補班' : '我願意補班',shift.id,'solid') : '',
    app?.status === 'pending' ? button('withdraw','撤回意願',shift.id) : ''
  ].join('');
  return `<article class="card" aria-label="${h(shift.task)}">
    <div class="entry"><div class="entry-grid">
      <div class="date-tile" aria-hidden="true"><small>${month} 月</small><strong>${day}</strong></div>
      <div><div class="entry-title"><h3>${h(shift.task)}</h3>${pill(shift.status)}</div>
      <p class="meta"><b>${h(shift.location)}</b> · ${h(duration(shift.duration))}<br>${h(formatRange(shift))}<br><span>${h(timezones[shift.timezone] || shift.timezone)}</span></p>
      ${tags(shift.skills)}
      ${!isManager() && app ? `<p class="subtle schedule-hint">${shift.status === 'canceled' ? '取消前的候選狀態：' : '我的候選：'}${pill(app.status)}</p>` : ''}
      ${conflict ? `<p class="warn">這個時段與你已確認的「${h(conflict.location)}」重疊，主管目前無法確認你補班。</p>` : ''}
      ${mismatch?.length && shift.status === 'open' ? `<p class="warn">技能提醒：你尚未列出 ${h(mismatch.join('、'))}，仍可表達意願。</p>` : ''}
      ${shift.status === 'canceled' ? `<p class="cancel-note"><b>取消原因：</b>${h(shift.cancelReason)}</p>` : ''}
      ${actions ? `<div class="actions">${actions}</div>` : ''}
    </div></div></div>
    ${isManager() ? `<details class="card-details" data-shift="${h(shift.id)}" ${state.expanded.has(String(shift.id)) ? 'open' : ''}><summary>候選與班次管理<span class="count">${shift.candidates?.filter(c=>c.status==='pending').length || 0} 位待回覆</span></summary>
      ${shift.candidates?.length ? shift.candidates.map(c=>candidateMarkup(c,shift)).join('') : '<p class="subtle">暫無候選。員工可自行表達補班意願。</p>'}
      ${shift.status === 'canceled' ? '' : `<div class="actions">${shift.status === 'open' ? button('edit','編輯班次',shift.id) : ''}${button('cancel','取消班次',shift.id,'danger')}</div>`}
    </details>` : ''}
  </article>`;
}
function renderBoard() {
  const {shifts,user} = state.data;
  const manager = isManager();
  const filtered = shifts.filter(shift => state.filter === 'all' || (state.filter === 'mine' ? !!shift.application && shift.application.status !== 'withdrawn' : shift.status === state.filter));
  const options = manager ? [['all','全部'],['open','徵求中'],['filled','已安排'],['canceled','已取消']] : [['all','全部可見'],['open','徵求中'],['mine','我的候選']];
  return `<div class="layout"><section class="source" aria-labelledby="board-title"><div class="section-title"><div><h2 id="board-title">${manager ? '補班工作板' : '補班機會'}</h2><p>${filtered.length} 個班次 · 時間依各班次所列時區顯示</p></div>
  <div class="filters" role="group" aria-label="篩選班次">${options.map(([id,label])=>button('filter',label,id,'filter',`aria-pressed="${id === state.filter}"`)).join('')}</div></div>
  <div class="cards">${filtered.length ? filtered.map(shiftMarkup).join('') : empty('沒有符合條件的班次',manager ? '切換篩選，或新增班次讓員工自願候選。' : '可切換篩選，或稍後重新整理查看新班次。')}</div></section>
  <aside class="sidebar" aria-label="補班說明"><section class="side-block"><span class="side-label">工作區概覽</span><h3>${manager ? '需要補位的班次' : '我的一般技能'}</h3>${manager ? `<p><strong>${shifts.filter(s=>s.status==='open').length}</strong> 個班次正在徵求自願補班</p>` : tags(user.skills)}</section>
  <section class="side-block"><span class="side-label">快速上手</span><h3>先表達意願，再確認</h3><div class="step"><b>01</b><span>主管張貼明確的地點、時段和任務。</span></div><div class="step"><b>02</b><span>員工自行候選，決定前可以撤回。</span></div><div class="step"><b>03</b><span>主管確認一人，結果只在 App 通知。</span></div></section></aside></div>`;
}
const auditNames = {
  create:'張貼班次',edit:'編輯班次',update:'編輯班次',cancel:'取消班次',apply:'自願候選',withdraw:'撤回意願',confirm:'確認補班',decline:'拒絕候選',
  created:'張貼班次',edited:'編輯班次',canceled:'取消班次',shift_created:'張貼班次',shift_updated:'編輯班次',shift_canceled:'取消班次',applied:'自願候選',withdrawn:'撤回意願',confirmed:'確認補班',declined:'拒絕候選'
};
function records() {
  const audits = state.tab === 'audit';
  const rows = audits ? state.data.audit : state.data.notifications;
  const title = audits ? '班次稽核紀錄' : '站內通知';
  const auditNote = '查看每筆班次操作、操作者與時間。';
  return `<section aria-labelledby="records-title"><div class="section-title"><div><h2 id="records-title">${title}</h2><p>${audits ? auditNote : '這裡只顯示你的通知，不會發送電郵或短訊。'}</p></div></div>
  ${rows.length ? `<div class="side-block">${rows.map(row=>`<article class="record"><div class="record-top"><strong>${audits ? h(auditNames[row.action] || row.action) : h(row.message)}</strong><time class="subtle" datetime="${h(row.time)}">${h(instantLabel(row.time))}</time></div>${audits ? `<p class="subtle">${h(row.actor)} · 班次 ${h(row.shiftId)}</p>${row.detail ? `<p>${h(row.detail)}</p>` : ''}` : ''}</article>`).join('')}</div>` : empty(audits ? '沒有班次異動' : '目前沒有通知',audits ? '建立班次後，操作會依序記錄在這裡。' : '當你參與的班次有更新，消息會出現在這裡。', '⋯')}
  </section>`;
}
function render() {
  workspace.setAttribute('aria-busy','false');
  const user = state.data?.user;
  const manager = isManager();
  q('#hero-note').textContent = user ? (manager ? '先徵求意願，確認時段無衝突後再安排。' : '有空、有意願才候選。收到確認才算安排。') : '清楚知道誰有空，再確認由誰補班。';
  q('#account').innerHTML = user ? `<button type="button" class="ghost account-button" data-action="account" aria-label="切換示範身分，目前是${h(user.name)}"><span class="avatar" aria-hidden="true">${h(user.name[0])}</span><span>${h(user.name)} <span class="role-long">· ${manager ? '主管' : '員工'}</span></span></button>` : '<span class="tag">合成資料示範</span>';
  if (!user) {
    workspace.innerHTML = `<section class="login-panel" aria-labelledby="login-title"><h2 id="login-title">選擇示範身分</h2><p class="subtle">免註冊。每個瀏覽器會話只以目前身分操作。</p>${personasMarkup()}</section>`;
    return;
  }
  const nav = [['board','班次'],['notifications','通知'],...(manager ? [['audit','稽核']] : [])];
  workspace.innerHTML = `<div class="board-top"><nav class="tabs" aria-label="工作區">${nav.map(([id,label])=>button('tab',`<span class="tab-label">${label}</span>${id==='notifications' && state.data.notifications.length ? `<span class="count">${state.data.notifications.length}</span>` : ''}`,id,'ghost',id===state.tab ? 'aria-current="page"' : '')).join('')}</nav>
  <div class="board-actions actions">${button('refresh','重新整理')}${manager ? button('new','＋ 張貼班次','','solid') : ''}</div></div>${state.tab === 'board' ? renderBoard() : records()}`;
}
async function api(url, method='GET', body) {
  const response = await fetch(url, {method,headers:{'Accept':'application/json',...(body ? {'Content-Type':'application/json'} : {})},...(body ? {body:JSON.stringify(body)} : {})});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || '無法完成這項操作。');
  return result;
}
function notify(text='', error=false) {
  live.className = error ? 'notice error' : 'notice';
  live.textContent = text;
}
let focusBeforeDialog;
dialog.addEventListener('close', () => {
  if (document.contains(focusBeforeDialog)) focusBeforeDialog.focus();
});
function openDialog(title, content) {
  focusBeforeDialog = document.activeElement;
  dialog.innerHTML = `<div class="dialog-inner"><div class="dialog-top"><h2 id="dialog-title">${title}</h2>${button('close','關閉')}</div>${content}</div>`;
  dialog.showModal();
  q('input,textarea,select,.persona',dialog)?.focus();
}
function editShift(shift) {
  openDialog(shift ? '編輯班次' : '張貼補班班次', `<form data-form="shift" data-id="${h(shift?.id)}">
    <label class="field">地點<input name="location" required maxlength="80" value="${h(shift?.location)}" placeholder="例：杏葉館・入口"></label>
    <label class="field">任務<input name="task" required maxlength="240" value="${h(shift?.task)}" placeholder="例：展覽接待補位"></label>
    <div class="form-grid"><label class="field">開始時間<input type="datetime-local" name="start" required value="${h(shift?.start)}"></label><label class="field">結束時間<input type="datetime-local" name="end" required value="${h(shift?.end)}"></label></div>
    <label class="field">班次時區<select name="timezone">${Object.entries(timezones).map(([id,label])=>`<option value="${id}" ${(shift?.timezone || 'Asia/Macau')===id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <p class="subtle schedule-hint" id="duration-preview" aria-live="polite">跨午夜時，請選擇隔日作為結束日期。工時依班次時間計算。</p>
    <label class="field">一般技能（以逗號分隔，可留空）<input name="skills" maxlength="220" value="${h(shift?.skills?.join('、'))}" placeholder="例：接待、盤點"></label>
    ${shift ? '<p class="warn">修改班次後，尚未決定的候選者須看過更新並重新表示意願。</p>' : ''}
    <p class="subtle schedule-hint">只輸入虛構的任務與地點，不要填寫姓名、私人聯絡方式或健康資訊。</p>
    <p class="inline-error" role="alert"></p><div class="actions"><button type="submit" class="solid">${shift ? '儲存變更' : '張貼班次'}</button></div>
  </form>`);
}
function cancelShift(shift) {
  openDialog('取消班次',`<form data-form="cancel" data-id="${h(shift.id)}">
    <p class="subtle">${h(shift.task)} · ${h(shift.location)}。班次會停止徵求，並釋出已確認人員的時段。紀錄仍會保留。</p>
    <label class="field">取消原因<textarea required maxlength="160" name="reason" placeholder="例：活動時段已調整"></textarea></label>
    <p class="inline-error" role="alert"></p><div class="actions"><button type="submit" class="danger">確認取消班次</button></div></form>`);
}
async function run(request, success, actionButton, resetView=false) {
  if (state.busy) return;
  state.busy = true;
  actionButton?.setAttribute('aria-disabled','true');
  const saved = actionButton?.closest('form') ? focusBeforeDialog?.dataset : actionButton?.dataset;
  try {
    const data = await request();
    if (dialog.open) dialog.close();
    if (resetView) {state.tab = 'board'; state.filter = 'all'; state.expanded.clear();}
    state.data = data;
    render();
    notify(success);
    const buttons = [...document.querySelectorAll('button[data-action]')];
    const restored = buttons.find(b => b.dataset.action === saved?.action && b.dataset.id === saved?.id && b.dataset.candidate === saved?.candidate);
    if (restored) restored.focus();
    else if (actionButton) {
      const fallback = saved?.id && [...document.querySelectorAll('details[data-shift]')].find(el => el.dataset.shift === saved.id);
      (fallback ? q('summary',fallback) : q('#main')).focus();
    }
  } catch (error) {
    const target = q('.inline-error',dialog);
    if (dialog.open && target) target.textContent = error.message;
    else notify(error.message, true);
  } finally {
    state.busy = false;
    actionButton?.removeAttribute('aria-disabled');
  }
}
document.addEventListener('toggle', event => {
  const details = event.target;
  if (details.matches?.('details[data-shift]')) {
    if (details.open) state.expanded.add(details.dataset.shift);
    else state.expanded.delete(details.dataset.shift);
  }
}, true);
document.addEventListener('click', event => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const {action,id,candidate} = control.dataset;
  const shift = state.data?.shifts.find(item => String(item.id) === id);
  switch (action) {
    case 'login': return run(()=>api('/api/login','POST',{persona:id}),'已切換示範身分。',control,true);
    case 'logout': return run(()=>api('/api/logout','POST',{}),'已登出示範身分。',control,true);
    case 'account': return openDialog('切換示範身分',`<p class="subtle schedule-hint">切換會替換本瀏覽器的會話。要同時以兩種身分操作，請另開無痕視窗。</p><div class="schedule-hint">${personasMarkup()}</div><div class="actions">${button('logout','登出')}</div>`);
    case 'close': return dialog.close();
    case 'new': return editShift();
    case 'edit': return shift && editShift(shift);
    case 'cancel': return shift && cancelShift(shift);
    case 'tab':
    case 'filter':
      state[action] = id; render();
      [...document.querySelectorAll('button[data-action]')].find(b=>b.dataset.action === action && b.dataset.id === id)?.focus();
      return;
    case 'refresh': return run(()=>api('/api/state'),'班次與通知已更新。',control);
    case 'apply':
    case 'withdraw':
    case 'confirm':
    case 'decline': {
      const path = `/api/shifts/${encodeURIComponent(id)}/${candidate ? 'candidates/' + encodeURIComponent(candidate) + '/' : ''}${action}`;
      const notes = {apply:'已表達補班意願，請等候主管確認。',withdraw:'已撤回這個班次的補班意願。',confirm:'已確認補班人選。',decline:'已拒絕這位候選。'};
      return run(()=>api(path,'POST',{}),notes[action],control);
    }
  }
});
dialog.addEventListener('input', event => {
  if (event.target.name !== 'start' && event.target.name !== 'end') return;
  const form = event.target.form;
  const start = form.elements.start.value, end = form.elements.end.value;
  const target = q('#duration-preview',dialog);
  if (start && end) {
    const mins = Math.round((new Date(end+'Z') - new Date(start+'Z'))/60000);
    target.textContent = mins > 0 ? '工時：' + duration(mins) + (start.slice(0,10) !== end.slice(0,10) ? '（跨日）' : '') : '結束需晚於開始；跨午夜時請選擇隔日。';
  } else target.textContent = '跨午夜時，請選擇隔日作為結束日期。工時依班次時間計算。';
});
dialog.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  const values = Object.fromEntries(new FormData(form));
  const id = form.dataset.id;
  const url = '/api/shifts' + (id ? '/' + encodeURIComponent(id) : '');
  if (form.dataset.form === 'cancel') return run(()=>api(url+'/cancel','POST',{reason:values.reason}),'班次已取消，原本保留的時段已釋出。',event.submitter);
  values.skills = values.skills.split(/[、,，]/).map(s=>s.trim()).filter(Boolean);
  if (values.end <= values.start) {q('.inline-error',dialog).textContent = '結束時間必須晚於開始時間。'; return;}
  run(()=>api(url,id?'PATCH':'POST',values),id?'班次變更已儲存。':'已張貼班次。',event.submitter);
});
async function initialize() {
  try {state.data = await api('/api/state'); render();}
  catch {
    workspace.setAttribute('aria-busy','false');
    workspace.innerHTML = empty('工作區未能載入','請確認本機示範伺服器正在運作，然後重新載入頁面。');
  }
}
initialize();
