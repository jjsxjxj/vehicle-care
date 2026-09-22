'use strict';

// ---------------- 基础工具 ----------------
const $ = (sel, root) => (root || document).querySelector(sel);
const view = () => $('#view');

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, isErr) {
  const old = $('.toast');
  if (old) old.remove();
  const d = document.createElement('div');
  d.className = 'toast' + (isErr ? ' err' : '');
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), isErr ? 4200 : 2400);
}

// ---------------- 居中弹层 ----------------
// 浏览器原生 prompt/confirm 在电脑上会贴在窗口顶部，而且完全没法改样式，
// 所以自己做一个垂直+水平居中的弹层：Esc 取消，Enter 确定。
function closeModal(wrap) {
  if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
  if (!document.querySelector('.modal')) document.body.classList.remove('modal-open');
}

function buildModal(inner) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML =
    '<div class="modal-scrim" data-act="cancel"></div>' +
    '<div class="modal-box" role="dialog" aria-modal="true">' + inner + '</div>';
  document.body.appendChild(wrap);
  document.body.classList.add('modal-open');
  return wrap;
}

/** 确认弹层 -> Promise<boolean> */
function askConfirm(opts) {
  const o = typeof opts === 'string' ? { body: opts } : (opts || {});
  return new Promise((resolve) => {
    const wrap = buildModal(
      '<h3 class="modal-title">' + esc(o.title || '请确认') + '</h3>' +
      (o.body ? '<div class="modal-body">' + esc(o.body) + '</div>' : '') +
      '<div class="modal-acts">' +
      '<button class="btn" data-act="cancel">' + esc(o.cancelText || '取消') + '</button>' +
      '<button class="btn ' + (o.danger ? 'danger' : 'primary') + '" data-act="ok">' + esc(o.okText || '确定') + '</button>' +
      '</div>');
    const finish = (v) => { document.removeEventListener('keydown', onKey); closeModal(wrap); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    };
    wrap.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => finish(b.dataset.act === 'ok'); });
    document.addEventListener('keydown', onKey);
    const ok = wrap.querySelector('[data-act="ok"]');
    if (ok) ok.focus();
  });
}

/** 表单弹层 -> Promise<{key: value}|null>（取消返回 null）
 *  字段类型：text/number/date（默认 input）、textarea（多行）、
 *           select（options:[{value,label}]）、checkbox（返回布尔） */
function askForm(opts) {
  const o = opts || {};
  const fields = o.fields || [];
  return new Promise((resolve) => {
    const fieldHtml = (f) => {
      const key = esc(f.key);
      if (f.type === 'checkbox') {
        return '<label class="row" style="gap:8px;align-items:center;margin:2px 0 14px">' +
          '<input type="checkbox" data-mf="' + key + '"' + (f.value ? ' checked' : '') + ' style="width:auto">' +
          '<span>' + esc(f.label || '') + '</span></label>';
      }
      if (f.type === 'select') {
        const opts2 = (f.options || []).map((op) =>
          '<option value="' + esc(op.value) + '"' + (String(op.value) === String(f.value === undefined || f.value === null ? '' : f.value) ? ' selected' : '') + '>' + esc(op.label) + '</option>'
        ).join('');
        return '<label class="field"><span>' + esc(f.label || '') + '</span><select data-mf="' + key + '">' + opts2 + '</select></label>';
      }
      if (f.type === 'textarea') {
        // 多行输入：不绑回车提交（textarea 里的回车应该是换行）
        return '<label class="field"><span>' + esc(f.label || '') + '</span>' +
          '<textarea data-mf="' + key + '" rows="' + esc(String(f.rows || 6)) + '"' +
          (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') +
          '>' + esc(f.value === null || f.value === undefined ? '' : f.value) + '</textarea></label>';
      }
      return '<label class="field"><span>' + esc(f.label || '') + '</span>' +
        '<input type="' + esc(f.type || 'text') + '" data-mf="' + key + '"' +
        ' value="' + esc(f.value === null || f.value === undefined ? '' : f.value) + '"' +
        (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') +
        (f.inputmode ? ' inputmode="' + esc(f.inputmode) + '"' : '') + '></label>';
    };
    const wrap = buildModal(
      '<h3 class="modal-title">' + esc(o.title || '') + '</h3>' +
      (o.body ? '<div class="modal-body">' + esc(o.body) + '</div>' : '') +
      fields.map(fieldHtml).join('') +
      (o.hint ? '<div class="hint" style="margin:-4px 0 14px">' + esc(o.hint) + '</div>' : '') +
      '<div class="modal-acts">' +
      '<button class="btn" data-act="cancel">' + esc(o.cancelText || '取消') + '</button>' +
      '<button class="btn primary" data-act="ok">' + esc(o.okText || '确定') + '</button>' +
      '</div>');
    const read = () => {
      const out = {};
      wrap.querySelectorAll('[data-mf]').forEach((i) => {
        out[i.dataset.mf] = i.type === 'checkbox' ? i.checked : i.value;
      });
      return out;
    };
    const finish = (v) => { document.removeEventListener('keydown', onKey); closeModal(wrap); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    wrap.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => finish(b.dataset.act === 'ok' ? read() : null);
    });
    wrap.querySelectorAll('input[data-mf]').forEach((i) => {
      i.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(read()); } };
    });
    document.addEventListener('keydown', onKey);
    const first = wrap.querySelector('[data-mf]');
    if (first) {
      first.focus();
      if (first.tagName === 'INPUT' && first.type !== 'checkbox') first.select();
    }
  });
}


async function api(path, opts) {
  const o = Object.assign({ credentials: 'same-origin' }, opts || {});
  // BUG-019：缓存复用——任何写操作（非 GET）都让首屏缓存与月份缓存失效，下次进页面重新拉真实数据。
  if ((o.method || 'GET').toUpperCase() !== 'GET') { state.bootFresh = false; state.recordsCache = {}; }
  if (o.body && !(o.body instanceof FormData)) {
    o.headers = Object.assign({ 'content-type': 'application/json' }, o.headers || {});
    o.body = JSON.stringify(o.body);
  }
  let res;
  try {
    res = await fetch(path, o);
  } catch (e) {
    throw new Error('网络请求失败，请检查连接');
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { ok: false, error: text.slice(0, 200) }; }
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || ('请求失败 ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

// BUG-024：下载导出文件。走 fetch 而不是直接改 location.href，
// 这样接口报错能看到原因，文件名也能从 Content-Disposition 里取回中文名。
async function downloadFile(path, fallbackName) {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('导出失败 ' + res.status);
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  let name = fallbackName;
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (m) { try { name = decodeURIComponent(m[1]); } catch (e) { /* 用兜底名 */ } }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// ---------------- 主题 ----------------
// 只存本地：外观是"这台设备"的偏好，不该跟着账号跑到别的手机上。
function getThemePref() {
  try {
    const v = localStorage.getItem('vc_theme');
    return (v === 'light' || v === 'dark') ? v : 'system';
  } catch (e) { return 'system'; }
}
function setThemePref(v) {
  try {
    if (v === 'system') localStorage.removeItem('vc_theme'); else localStorage.setItem('vc_theme', v);
  } catch (e) { /* 无痕模式下忽略 */ }
  if (window.__vcApplyTheme) window.__vcApplyTheme();
}

// ---------------- 车牌格式化 ----------------
// 手机输入法经常打出全角字母；先归一化，再统一大写，再补分隔点。
// 分隔点位置：普通车牌在第 2 位之后（粤B·8T9X2）；
// 新能源 8 位车牌（沪AD12345）按习惯放在第 3 位之后。
function plateDotAt(clean) {
  return (clean.length === 8 && /[DF]/.test(clean.charAt(2))) ? 3 : 2;
}

function formatPlate(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw)
    .replace(/[\uff21-\uff3a\uff41-\uff5a\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase()
    .replace(/[^\u4e00-\u9fa5A-Z0-9]/g, '');
  if (s.length > 8) s = s.slice(0, 8);
  const at = plateDotAt(s);
  if (s.length > at) s = s.slice(0, at) + '·' + s.slice(at);
  return s;
}

// 数出"会被保留的字符"个数（不含分隔点），用于换算光标位置
function plateCleanLen(str) {
  return String(str === null || str === undefined ? '' : str)
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9\uff21-\uff3a\uff41-\uff5a\uff10-\uff19]/g, '').length;
}

// 边打边格式化，并把光标放回它原本对应的字符后面（否则打字时会被弹到末尾）
function bindPlateInput(root) {
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.dataset || t.dataset.f !== 'plate') return;
    const before = t.value;
    const next = formatPlate(before);
    if (next === before) return;
    const at = plateDotAt(next.replace(/·/g, ''));
    const pos = t.selectionStart === null ? before.length : t.selectionStart;
    const n = plateCleanLen(before.slice(0, pos));
    let newPos = n > at ? n + 1 : n; // 光标落在分隔点之后就得多跳一位
    newPos = Math.max(0, Math.min(newPos, next.length));
    t.value = next;
    try { t.setSelectionRange(newPos, newPos); } catch (x) { /* 忽略 */ }
  });
}

// ---------------- 客户端密码派生 ----------------
function hexToBytes(hex) {
  const s = String(hex || '');
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
async function deriveVerifier(password, saltHex, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations: iterations || 210000 },
    key, 256
  );
  return bytesToHex(bits);
}

// ---------------- 图片压缩 ----------------
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法读取')); };
    img.src = url;
  });
}
function drawToBlob(img, maxSide, quality) {
  return new Promise((resolve, reject) => {
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, w, h);
    cx.drawImage(img, 0, 0, w, h);
    cv.toBlob((b) => b ? resolve(b) : reject(new Error('图片处理失败')), 'image/jpeg', quality);
  });
}
async function shrinkImage(file) {
  const img = await loadImage(file);
  const main = await drawToBlob(img, 1280, 0.82);
  const thumb = await drawToBlob(img, 360, 0.62);
  const thumbDataUrl = await new Promise((r) => {
    const fr = new FileReader();
    fr.onload = () => r(String(fr.result));
    fr.readAsDataURL(thumb);
  });
  return { blob: main, thumbDataUrl };
}

// ---------------- 状态 ----------------
const state = {
  user: null, meta: null,
  tab: 'board',
  authPage: 'login',
  openPlans: {},
  vehicles: [], currentVehicleId: null,
  plans: [], records: [], settings: null, catalog: [],
  pending: null,
  about: {},          // 「关于」卡片外链（FEAT-001/002）
  announcements: [],  // 未读公告，登录后弹一次（FEAT-003）
};

const TABS = {
  board: { title: '保养看板', sub: '到期与临期项目一目了然' },
  upload: { title: '上传识别', sub: '截图丢进来，AI 自动归类' },
  records: { title: '养车账本', sub: '加油、保养、杂项，一笔记清楚' },
  settings: { title: '通知设置', sub: 'Bark 推送与识别通道' },
  admin: { title: '管理控制台', sub: '用户、数据与周期表管理' },
};

function setTab(tab) {
  state.tab = tab;
  // 底部 Tab 与 PC 侧边栏是同一套入口，选中态两边都要同步
  $('#tabbar').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#sidebar').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#title').textContent = TABS[tab].title;
  $('#subtitle').textContent = TABS[tab].sub;
  render();
}

// 异步渲染防串台：每个异步 render 开头领一个序号，请求回来后发现 tab 已切走就放弃写视图。
// 不加的话：记录页加载慢 → 马上点设置 → 记录页响应回来把设置页整页覆盖（tab 高亮在设置、内容却是账本）。
let renderSeq = 0;
function renderBegin() { return ++renderSeq; }
function renderStale(seq) { return seq !== renderSeq; }

function render() {
  if (!state.user) return renderAuth();
  if (state.tab === 'board') return renderBoard();
  if (state.tab === 'upload') return renderUpload();
  if (state.tab === 'records') return renderRecords();
  if (state.tab === 'settings') return renderSettings();
  if (state.tab === 'admin') return renderAdmin();
}

// ---------------- 落地页 ----------------
// 未登录时先介绍产品，点「登录 / 立即开始使用」才进登录页（报告第十章）
const LAND_FEATS = [
  { ico: '📸', title: 'AI 识别上传', desc: '上传维修保养截图，自动识别项目、金额、周期' },
  { ico: '⏰', title: '到期自动提醒', desc: '按周期推算下次保养，Bark 推送到手机，不再忘记' },
  { ico: '💰', title: '养车账本', desc: '加油、保养、杂项费用一笔记录，花了多少一目了然' },
];

function renderLanding() {
  document.body.classList.remove('is-auth');
  document.body.classList.add('is-landing');
  $('#tabbar').style.display = 'none';
  $('#logoutBtn').style.display = 'none';
  const cards = LAND_FEATS.map((f) => `
    <div class="card land-card">
      <div class="land-ico">${f.ico}</div>
      <h3>${esc(f.title)}</h3>
      <p>${esc(f.desc)}</p>
    </div>`).join('');
  view().innerHTML = `
    <div class="land-hero">
      <div class="land-nav">
        <div class="land-brand">
          <span class="sb-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
                 stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2.6l7 3v5.6c0 4.3-2.9 8.2-7 9.2-4.1-1-7-4.9-7-9.2V5.6z"/>
              <path d="M8.6 12.1l2.3 2.3 4.5-4.6"/>
            </svg>
          </span>车辆保养助手
        </div>
        <button class="btn primary" data-land="login">登录</button>
      </div>
      <h1 class="land-title">智能养车，省心省力</h1>
      <p class="land-sub">上传保养单据，AI 自动识别归档，到期自动推送提醒</p>
      <button class="btn primary" data-land="login" style="min-width:180px">立即开始使用</button>
    </div>
    <div class="land-section"><div class="land-cards">${cards}</div></div>
    <div class="land-trust">
      <span class="sb-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor"
             stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2.6l7 3v5.6c0 4.3-2.9 8.2-7 9.2-4.1-1-7-4.9-7-9.2V5.6z"/>
          <path d="M8.6 12.1l2.3 2.3 4.5-4.6"/>
        </svg>
      </span>
      <div class="muted">密码本地加密，服务器只存密文</div>
      <div class="muted">多账号独立，数据互不可见</div>
    </div>`;
  view().querySelectorAll('[data-land]').forEach((b) => { b.onclick = () => showAuth(); });
}

function showAuth() {
  document.body.classList.remove('is-landing');
  state.authPage = 'login';
  renderAuth();
}

// ---------------- 登录 / 注册（报告 4.1：两个独立页面，纯居中卡片） ----------------
// 登录页与注册页各自独立、互相跳转，不再在同一个页面用分段控件切换。
const ICO = {
  shield: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.6l7 3v5.6c0 4.3-2.9 8.2-7 9.2-4.1-1-7-4.9-7-9.2V5.6z"/><path d="M8.6 12.1l2.3 2.3 4.5-4.6"/></svg>',
  mail: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.6 7.6l7.3 5.2a2 2 0 0 0 2.2 0l7.3-5.2"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 12S6.2 6.4 12 6.4 21.4 12 21.4 12 17.8 17.6 12 17.6 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l16 16"/><path d="M9.9 5.2A10 10 0 0 1 12 5c5.8 0 9.4 7 9.4 7a17.4 17.4 0 0 1-3.4 4.2M6.6 7.3A16.8 16.8 0 0 0 2.6 12S6.2 19 12 19a9.6 9.6 0 0 0 4.2-1"/></svg>',
};

function authHead(title) {
  return `<div class="auth-head">
    <span class="auth-logo">${ICO.shield}</span>
    <h2 class="auth-title">${esc(title)}</h2>
  </div>`;
}
function ipt(icon, inputHtml, withEye) {
  return `<span class="ipt">${icon}${inputHtml}` +
    (withEye ? '<button type="button" class="ipt-eye" id="eyeBtn" aria-label="显示密码">' + ICO.eye + '</button>' : '') +
    '</span>';
}
const AUTH_HINT = `<div class="hint auth-hint">
        密码先在你的设备上加密，再发送给服务器保存——服务器拿到的只是密文，看不到原始密码。
      </div>`;

function renderAuth() {
  document.body.classList.add('is-auth');
  $('#tabbar').style.display = 'none';
  $('#logoutBtn').style.display = 'none';
  if (state.authPage === 'reg') renderRegister();
  else renderLogin();
}

function renderLogin() {
  $('#title').textContent = '车辆保养助手';
  $('#subtitle').textContent = '上传保养单据，自动归档并到期提醒';
  view().innerHTML = `
    <div class="card auth-card">
      ${authHead('车辆保养助手')}
      <form id="authForm" novalidate>
        <label class="field"><span>邮箱</span>
          ${ipt(ICO.mail, '<input type="email" id="email" autocomplete="username" placeholder="you@example.com">')}</label>
        <label class="field"><span>密码</span>
          ${ipt(ICO.lock, '<input type="password" id="password" autocomplete="current-password" placeholder="输入密码">', true)}</label>
        <div id="err"></div>
        <button class="btn primary block" id="submit" type="submit">登录</button>
      </form>
      <div class="auth-foot">
        ${regOpen()
          ? '<button type="button" class="linkbtn" id="toReg">新用户？注册账号</button>'
          : '<span class="muted">本站已关闭注册，如需账号请联系管理员</span>'}
      </div>
      ${AUTH_HINT}
    </div>`;
  bindAuth();
}

function renderRegister() {
  // 管理员关了注册：直接拦在页面这一层，别让用户白填一遍表单再被后端拒
  if (!regOpen()) {
    $('#title').textContent = '注册已关闭';
    $('#subtitle').textContent = '本站暂不开放自助注册';
    view().innerHTML = `
      <div class="card auth-card">
        ${authHead('注册已关闭')}
        <div class="hint" style="text-align:center;margin:10px 0">管理员已关闭注册，如需账号请联系管理员开通。</div>
        <button type="button" class="btn primary block" id="toLogin">返回登录</button>
        ${AUTH_HINT}
      </div>`;
    bindAuth();
    return;
  }
  $('#title').textContent = '注册账号';
  $('#subtitle').textContent = '创建一个只属于你的养车档案';
  view().innerHTML = `
    <div class="card auth-card">
      ${authHead('注册账号')}
      <form id="authForm" novalidate>
        <label class="field"><span>邮箱</span>
          ${ipt(ICO.mail, '<input type="email" id="email" autocomplete="username" placeholder="you@example.com">')}</label>
        <label class="field"><span>密码</span>
          ${ipt(ICO.lock, '<input type="password" id="password" autocomplete="new-password" placeholder="至少 8 位">', true)}</label>
        <label class="field"><span>确认密码</span>
          ${ipt(ICO.lock, '<input type="password" id="password2" autocomplete="new-password" placeholder="再输入一次">')}</label>
        <div id="err"></div>
        <button class="btn primary block" id="submit" type="submit">注册</button>
      </form>
      <div class="auth-foot">
        <button type="button" class="linkbtn" id="toLogin">已有账号？去登录</button>
      </div>
      ${AUTH_HINT}
    </div>`;
  bindAuth();
}

function bindAuth() {
  const eye = $('#eyeBtn');
  if (eye) eye.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const p = $('#password');
    const show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    eye.innerHTML = show ? ICO.eyeOff : ICO.eye;
    eye.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  };
  const toReg = $('#toReg');
  if (toReg) toReg.onclick = () => { state.authPage = 'reg'; renderAuth(); };
  const toLogin = $('#toLogin');
  if (toLogin) toLogin.onclick = () => { state.authPage = 'login'; renderAuth(); };
  // 包在 <form> 里，浏览器才会把密码框当密码框；回车提交也顺带有了（BUG-002）
  // 注意：关闭注册时注册页是一张没有 #authForm 的提示卡，这里必须判空，
  // 否则 renderRegister 会抛 TypeError（能看见卡片，但控制台报错）。
  const form = $('#authForm');
  if (form) form.onsubmit = (e) => { e.preventDefault(); submitAuth(); };
}

async function submitAuth() {
  const page = state.authPage === 'reg' ? 'reg' : 'login';
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const errBox = $('#err');
  errBox.innerHTML = '';
  if (!email || !password) { errBox.innerHTML = '<div class="error-box">请填写邮箱和密码</div>'; return; }
  if (page === 'reg') {
    if (password.length < 8) { errBox.innerHTML = '<div class="error-box">密码至少 8 位</div>'; return; }
    const p2 = $('#password2');
    if (p2 && p2.value !== password) { errBox.innerHTML = '<div class="error-box">两次输入的密码不一致</div>'; return; }
  }
  const btn = $('#submit');
  btn.disabled = true; btn.textContent = '处理中…';
  try {
    const s = await api('/api/auth/salt', { method: 'POST', body: { email } });
    const verifier = await deriveVerifier(password, s.salt, s.iterations);
    const path = page === 'reg' ? '/api/auth/register' : '/api/auth/login';
    const r = await api(path, { method: 'POST', body: { email, verifier } });
    state.user = r.user;
    await bootAfterLogin();
  } catch (e) {
    errBox.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
    btn.disabled = false; btn.textContent = page === 'reg' ? '注册' : '登录';
  }
}

// ---------------- 看板 ----------------
// BUG-026：下拉框/列表里的车辆名。截图识别常把「品牌 车系」写进 nickname，
// 直接拼接就会变成「吉利 帝豪L 吉利 帝豪L 2022款」。这里以单一标题为基准，
// 逐项做包含判定去重，只补标题里没有的信息（通常只剩年款）。
function vehicleLabel(v) {
  if (!v) return '未选择车辆';
  const title = vehicleTitle(v); // 车牌 > 昵称 > 「品牌 车系」
  const rest = [v.brand, v.series, v.model_year]
    .filter(Boolean).map(String)
    .filter((s) => !String(title).includes(s));
  const uniq = [];
  rest.forEach((s) => { if (!uniq.some((u) => u.includes(s) || s.includes(u))) uniq.push(s); });
  return [title].concat(uniq).join(' ');
}

async function loadBoard() {
  const v = await api('/api/vehicles');
  state.vehicles = v.vehicles || [];
  if (!state.vehicles.find((x) => x.id === state.currentVehicleId)) {
    state.currentVehicleId = state.vehicles.length ? state.vehicles[0].id : null;
  }
  const q = state.currentVehicleId ? ('?vehicle_id=' + state.currentVehicleId) : '';
  // 记录只用来算看板上那两个数字，拿不到也不该拖垮整个看板
  const [p, r] = await Promise.all([
    api('/api/plans' + q),
    api('/api/records' + q).catch(() => ({ records: [] })),
  ]);
  state.plans = p.plans || [];
  state.today = p.today;
  state.records = r.records || [];
  state.totals = r.totals || null;
  // months 是各月汇总：看板的趋势图与「今年花费」都用它。
  // 单独存一份 boardMonths —— recordsMonths 会被记录页的月份视图改写（BUG-025）。
  state.boardMonths = r.months || [];
  state.recordsMonths = r.months || [];
}

const LEVEL_TEXT = { overdue: '已到期', soon: '即将到期', ok: '正常', unknown: '缺依据' };

// 弹窗顶部的车辆标题：与看板 hero 同规则取单一标题（车牌 > 昵称 > 品牌车系），
// 避免截图识别把「品牌 车系」写进昵称时，弹窗里「吉利 帝豪L 吉利 帝豪L」重复出现两遍。
function vehicleTitle(v) {
  if (!v) return '';
  return String(v.plate || v.nickname || [v.brand, v.series].filter(Boolean).join(' ') || '未命名车辆');
}
const BASIS_TEXT = { warranty: '单据质保期', catalog: '通用周期表', override: '我的自定义周期', manual: '手动设置', from_today: '按当天推算', none: '无依据' };

function money(v) {
  const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/[^\d.\-]/g, ''));
  if (!isFinite(n)) return '¥0';
  return '¥' + n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
// ---------------- 骨架屏 ----------------
// 子页面进来的第一屏用骨架屏顶住，比"加载中…"三个字更像真的在加载（BUG-010）
function skeletonBoard() {
  return `<div class="sk sk-hero">
      <div class="sk-hero-main">
        <div class="sk-line w60"></div><div class="sk-line w40"></div><div class="sk-line w80"></div>
      </div><div class="sk-circle"></div>
    </div>
    <div class="sk"><div class="sk-box sm"></div></div>
    <div class="sk"><div class="sk-box"></div><div class="sk-box sm"></div></div>`;
}
function skeletonList(n) {
  let s = '';
  for (let i = 0; i < (n || 3); i++) s += '<div class="sk"><div class="sk-box sm"></div></div>';
  return s;
}
function skeletonForm() {
  return `<div class="sk"><div class="sk-line w40"></div><div class="sk-box"></div></div>
    <div class="sk"><div class="sk-line w40"></div><div class="sk-box sm"></div></div>`;
}

// ---------------- 空状态 ----------------
// 插画 + 引导文案 + 操作按钮（BUG-009）
const ILLU = {
  car: '<svg class="empty-illu" viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 58h68v-14l-10-6-8-14H32l-8 14-10 6z"/><circle cx="30" cy="62" r="7"/><circle cx="66" cy="62" r="7"/></svg>',
  book: '<svg class="empty-illu" viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20h40a8 8 0 0 1 8 8v52H28a8 8 0 0 1-8-8z"/><path d="M68 28h8v52H28"/><path d="M34 38h18M34 50h18"/></svg>',
  check: '<svg class="empty-illu" viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="48" cy="48" r="30"/><path d="M34 49l11 11 18-20"/></svg>',
  photo: '<svg class="empty-illu" viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="24" width="68" height="48" rx="6"/><circle cx="36" cy="44" r="7"/><path d="M20 68l18-18 14 14 10-8 14 12"/></svg>',
};
function emptyBox(opts) {
  const o = opts || {};
  const illu = ILLU[o.illu] || ILLU.check;
  const acts = (o.acts || []).map((a) =>
    `<button class="btn ${a.primary ? 'primary' : ''}" data-empty-act="${esc(a.act)}">${esc(a.label)}</button>`).join('');
  return `<div class="card"><div class="empty">
    ${illu}
    <div class="empty-title">${esc(o.title || '')}</div>
    ${o.desc ? '<div class="empty-desc">' + esc(o.desc) + '</div>' : ''}
    ${acts ? '<div class="empty-acts">' + acts + '</div>' : ''}
  </div></div>`;
}

// ---------------- 数据可视化 ----------------
// 近 6 个月花费柱状图（BUG-011）。months 来自 /api/records，按 m 升序取最后 6 条
function trendChartHtml(months) {
  const src = (months || []).slice().sort((a, b) => String(a.m).localeCompare(String(b.m))).slice(-6);
  if (!src.length) return '';
  const max = Math.max.apply(null, src.map((x) => Number(x.amount) || 0)) || 1;
  const bars = src.map((x) => {
    const h = Math.max(2, Math.round(((Number(x.amount) || 0) / max) * 100));
    const label = String(x.m).slice(5).replace(/^0/, '') + '月';
    return `<div class="bar" title="${esc(x.m)}：${esc(money(x.amount))}">
      <div class="bar-val">${esc(money(x.amount))}</div>
      <div class="bar-track"><div class="bar-fill" style="height:${h}%"></div></div>
      <div class="bar-cap">${esc(label)}</div>
    </div>`;
  }).join('');
  return `<div class="card chart-card">
    <h3 class="chart-title">近 ${src.length} 个月养车花费</h3>
    <div class="bars">${bars}</div>
  </div>`;
}

// 注：费用分类饼图（原 pieChartHtml）已按报告 BUG-018 整体移除，不再保留实现。

function kmText(v) {
  const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n.toLocaleString('zh-CN') + ' km' : esc(String(v)) + ' km';
}
function ymd(v) { return v ? esc(String(v).slice(0, 10)) : ''; }

// 状态环：正常项占比。颜色跟着整体状态走，红环配低百分比，读起来才不矛盾。
// 直径 96 / 环宽 7：环内直径约 82，装 16px 的百分比 + 12px 说明不会顶边（BUG-006）
function ringSvg(pct, token) {
  const C = 238.8; // 2πr, r = 38
  const on = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  const dash = (C * on / 100).toFixed(1);
  // 0% 时不画弧：圆头线帽会留下一个小圆点，看起来像渲染残渣
  const arc = on > 0
    ? `<circle cx="48" cy="48" r="38" fill="none" stroke="var(--${token})" stroke-width="7"
              stroke-linecap="round" stroke-dasharray="${dash} ${C}" transform="rotate(-90 48 48)"/>`
    : '';
  return `<div class="ringwrap">
    <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="保养状态 ${on}%">
      <circle cx="48" cy="48" r="38" fill="none" stroke="var(--surface-3)" stroke-width="7"/>
      ${arc}
    </svg>
    <div class="ring-label">
      <span class="ring-num">${pct === null ? '—' : on + '%'}</span>
      <span class="ring-cap">保养状态</span>
    </div>
  </div>`;
}

function urgencyHeadline(p) {
  if (p.daysLeft !== null && p.daysLeft !== undefined) {
    return p.daysLeft <= 0 ? ('已逾期 ' + Math.abs(p.daysLeft) + ' 天') : ('还剩 ' + p.daysLeft + ' 天');
  }
  if (p.kmLeft !== null && p.kmLeft !== undefined) {
    return p.kmLeft <= 0 ? ('已超 ' + Math.abs(p.kmLeft) + ' 公里') : ('还剩 ' + p.kmLeft + ' 公里');
  }
  return '待确认';
}

// 保养进度：上次做完 -> 下次到期 之间走了多少
function planProgress(p, today) {
  if (!p.next_due_at || !p.last_done_at || !today) return null;
  const s = Date.parse(String(p.last_done_at).slice(0, 10) + 'T00:00:00Z');
  const e = Date.parse(String(p.next_due_at).slice(0, 10) + 'T00:00:00Z');
  const t = Date.parse(String(today).slice(0, 10) + 'T00:00:00Z');
  if (!isFinite(s) || !isFinite(e) || !isFinite(t) || e <= s) return null;
  return { pct: Math.max(0, Math.min(100, Math.round(((t - s) / (e - s)) * 100))) };
}

async function renderBoard() {
  const seq = renderBegin();
  // BUG-019：首屏数据已在登录后一次性取回时直接渲染，切 tab 不再发请求、也不再闪骨架屏
  if (!state.bootFresh) {
    view().innerHTML = skeletonBoard();
    try { await loadBoard(); state.bootFresh = true; }
    catch (e) { if (!renderStale(seq)) view().innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; return; }
    if (renderStale(seq)) return;
  }

  if (!state.vehicles.length) {
    view().innerHTML = emptyBox({
      illu: 'car',
      title: '还没有车辆档案',
      desc: '先上传一张「我的车辆」截图让 AI 识别，或者直接手动建一辆车。',
      acts: [
        { act: 'goto-upload', label: '去上传车辆截图', primary: true },
        { act: 'new-vehicle', label: '手动新建车辆' },
      ],
    });
    bindBoard();
    return;
  }

  const cur = state.vehicles.find((x) => x.id === state.currentVehicleId);
  // 已暂停的项目不再计入「已到期/临期/正常」，也不参与「最紧急」挑选，避免一直红着吓人
  const activePlans = state.plans.filter((p) => p.status !== 'paused');
  const pausedCount = state.plans.length - activePlans.length;
  const counts = { overdue: 0, soon: 0, ok: 0, unknown: 0 };
  activePlans.forEach((p) => { counts[p.level] = (counts[p.level] || 0) + 1; });
  const total = activePlans.length;
  const normalPct = total ? Math.round((counts.ok / total) * 100) : null;
  const ringToken = counts.overdue ? 'danger' : (counts.soon ? 'warn' : 'ok');
  const urgent = activePlans.find((p) => p.level === 'overdue' || p.level === 'soon') || null;

  // 今年花费 / 累计记录
  // BUG-025：看板的数字一律走「全时段 SQL 聚合」（months 月度小计 / totals 累计），
  // 绝不用 state.records —— 那是记录页的月份视图，去一趟记录页它就被换成单月数据，
  // 于是「今年花费」和「累计记录」会随你怎么点页面而变（1248.42/2笔 ↔ 6.9/1笔）。
  const year = String(state.today || '').slice(0, 4);
  const yearSpend = (state.boardMonths || [])
    .filter((x) => String(x.m).slice(0, 4) === year)
    .reduce((s, x) => s + (Number(x.amount) || 0), 0);

  let html = '';

  // ① 车辆主卡：大标题 = 车牌 > 昵称 > 「品牌 车系」；副标题只保留标题里没有的信息。
  //    截图识别常把「品牌 车系」写进昵称，直接拼接会上下重复，所以这里逐项做包含判定。
  const nick = cur.nickname ? String(cur.nickname) : '';
  const heroTitle = cur.plate || nick || [cur.brand, cur.series].filter(Boolean).join(' ') || '我的车';
  const subParts = [];
  if (nick && nick !== heroTitle && !String(heroTitle).includes(nick)) subParts.push(nick);
  [cur.brand, cur.series, cur.model_year].forEach((x) => {
    if (!x) return;
    const s = String(x);
    if (String(heroTitle).includes(s)) return;
    if (subParts.some((p) => p.includes(s))) return;
    subParts.push(s);
  });
  const heroSub = subParts.join(' ');
  html += `<div class="hero">
    <div class="hero-main">
      <div class="hero-plate">${esc(heroTitle)}</div>
      ${heroSub ? `<div class="hero-sub">${esc(heroSub)}</div>` : ''}
      <div class="hero-meta">里程 ${cur.current_km ? kmText(cur.current_km) : '未填写'}${cur.km_updated_at ? ' · ' + ymd(cur.km_updated_at) + ' 更新' : ''}${cur.fuel_consumption ? ' · 油耗 ' + esc(String(cur.fuel_consumption)) + ' L/100km' : ''}${cur.vin ? '<br>车架号 ' + esc(cur.vin) : ''}</div>
      <div class="hero-acts">
        <button class="btn sm ghost" data-km="${cur.id}">更新里程</button>
        <button class="btn sm ghost" data-editveh="${cur.id}">编辑车辆</button>
      </div>
    </div>
    ${ringSvg(normalPct, ringToken)}
  </div>`;

  // 多车才给切换器，一辆车时别占地方
  if (state.vehicles.length > 1) {
    html += `<div class="card" style="padding:12px 14px">
      <label class="field" style="margin:0"><span>切换车辆</span>
        <select id="vehSel">${state.vehicles.map((v) => `<option value="${v.id}" ${v.id === state.currentVehicleId ? 'selected' : ''}>${esc(vehicleLabel(v))}</option>`).join('')}</select>
      </label></div>`;
  }

  // ② 状态计数
  html += `<div class="kpis">
    <div class="kpi danger${counts.overdue ? '' : ' zero'}"><span>已到期</span><b>${counts.overdue}</b></div>
    <div class="kpi warn${counts.soon ? '' : ' zero'}"><span>临期</span><b>${counts.soon}</b></div>
    <div class="kpi ok${counts.ok ? '' : ' zero'}"><span>正常</span><b>${counts.ok}</b></div>
  </div>`;

  // ③ 最紧急的一件事
  if (urgent) {
    html += `<div class="urgent ${urgent.level}">
      <div class="urgent-top">
        <span class="urgent-tag">最紧急</span>
        <span class="urgent-days">${esc(urgencyHeadline(urgent))}</span>
      </div>
      <div class="urgent-name">${esc(urgent.item_name)}${urgent.spec ? '<span class="spec">' + esc(urgent.spec) + '</span>' : ''}</div>
      <div class="urgent-meta">依据：${esc(BASIS_TEXT[urgent.basis] || urgent.basis || '—')}${urgent.interval_months ? ' · 每 ' + urgent.interval_months + ' 个月' : ''}${urgent.interval_km ? ' / ' + urgent.interval_km + ' km' : ''}${urgent.next_due_at ? ' · 下次 ' + ymd(urgent.next_due_at) : ''}</div>
      <div class="urgent-acts">
        <button class="btn sm primary" data-done="${urgent.id}">已保养</button>
        <button class="btn sm" data-adjust="${urgent.id}">改周期</button>
      </div>
    </div>`;
  } else if (total) {
    html += `<div class="urgent">
      <div class="urgent-top"><span class="urgent-tag">状态</span></div>
      <div class="urgent-name">暂时没有到期或临期项目</div>
      <div class="urgent-meta">${total} 个项目都在正常周期内，到期前会在手机上提醒你。</div>
    </div>`;
  }

  // ④ 四个数字：今年总花费 / 累计记录 / 累计加油 / 累计杂项
  const tt = state.totals || { fuel_amount: 0, fuel_liters: 0, beauty_amount: 0, maintenance_amount: 0, count: 0 };
  html += `<div class="stats">
    <div class="stat"><span>今年养车花费</span><b>${esc(money(yearSpend))}</b></div>
    <div class="stat"><span>累计记录</span><b>${Number(tt.count || 0)}<span class="unit">笔</span></b></div>
    <div class="stat"><span>累计加油</span><b>${esc(money(tt.fuel_amount))}</b>${tt.fuel_liters ? '<i class="stat-sub">共 ' + esc(String(tt.fuel_liters)) + ' 升</i>' : ''}</div>
    <div class="stat"><span>累计杂项</span><b>${esc(money(tt.beauty_amount))}</b></div>
  </div>`;

  // ⑤ 数据可视化：月度花费趋势
  // BUG-018：首页「费用分类」模块已按报告要求整块砍掉，不再渲染饼图/分类列表
  const trend = trendChartHtml(state.boardMonths);
  if (trend) html += trend;

  // ⑥ 项目清单（含已暂停，方便随时重新启用）
  html += `<div class="sec-label">保养项目${total ? ' · ' + total : ''}${pausedCount ? ' · 已暂停 ' + pausedCount : ''}</div>`;
  if (!state.plans.length) {
    html += emptyBox({
      illu: 'check',
      title: '这辆车还没有保养项目',
      desc: '上传一张保养订单截图，AI 会识别项目并按通用周期表算出下次到期时间。',
      acts: [{ act: 'goto-upload', label: '去上传保养截图', primary: true }],
    });
  } else {
    html += state.plans.map(planCard).join('');
  }

  // ⑥ 底部工具
  html += `<div class="card"><div class="row between">
      <span class="muted">今天 ${esc(state.today || '')}</span>
      <button class="btn sm" id="scanBtn">立即检查并推送</button>
    </div></div>`;

  view().innerHTML = html;
  bindBoard();
}

function bindBoard() {
  const sel = $('#vehSel');
  if (sel) sel.onchange = () => { state.currentVehicleId = sel.value; render(); };
  $('#view').querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => setTab(b.dataset.goto); });
  $('#view').querySelectorAll('[data-newvehicle]').forEach((b) => { b.onclick = () => editVehicle(null); });
  // BUG-013：点项目名切换「截断 / 完整标题」
  $('#view').querySelectorAll('[data-nm]').forEach((el) => {
    el.onclick = () => {
      state.openPlans[el.dataset.nm] = !state.openPlans[el.dataset.nm];
      render();
    };
  });
  // 空状态里的引导按钮
  $('#view').querySelectorAll('[data-empty-act]').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.emptyAct;
      if (a === 'goto-upload') setTab('upload');
      else if (a === 'new-vehicle') editVehicle(null);
      else if (a === 'goto-records') setTab('records');
    };
  });
  $('#view').querySelectorAll('[data-editveh]').forEach((b) => { b.onclick = () => editVehicle(b.dataset.editveh); });
  $('#view').querySelectorAll('[data-km]').forEach((b) => { b.onclick = () => updateKm(b.dataset.km); });
  $('#view').querySelectorAll('[data-done]').forEach((b) => { b.onclick = () => markDone(b.dataset.done); });
  $('#view').querySelectorAll('[data-adjust]').forEach((b) => { b.onclick = () => adjustPlan(b.dataset.adjust); });
  $('#view').querySelectorAll('[data-pause]').forEach((b) => { b.onclick = () => pausePlan(b.dataset.pause); });
  $('#view').querySelectorAll('[data-resume]').forEach((b) => { b.onclick = () => resumePlan(b.dataset.resume); });
  const sb = $('#scanBtn');
  if (sb) sb.onclick = async () => {
    sb.disabled = true; sb.textContent = '检查中…';
    try {
      const r = await api('/api/push/scan', { method: 'POST' });
      const n = (r.pushed || []).length;
      toast(n ? `已推送 ${n} 条提醒` : '没有新的到期项目');
      await renderBoard();
    } catch (e) { toast(e.message, true); sb.disabled = false; sb.textContent = '立即检查并推送'; }
  };
}

function planCard(p) {
  const paused = p.status === 'paused';
  const due = [];
  if (p.next_due_at) due.push(ymd(p.next_due_at));
  if (p.next_due_km) due.push('或 ' + kmText(p.next_due_km));
  const pr = paused ? null : planProgress(p, state.today);
  // BUG-013：超长项目名默认截断（约 14 字），点项目名展开看完整标题
  const nm = String(p.item_name || '');
  const longName = nm.length > 14;
  const nmOpen = !!(state.openPlans && state.openPlans[p.id]);
  const nmShow = (longName && !nmOpen) ? nm.slice(0, 14) + '…' : nm;
  const acts = paused
    ? `<button class="btn sm primary" data-resume="${p.id}">重新启用</button>
       <button class="btn sm" data-adjust="${p.id}">改周期</button>`
    : `<button class="btn sm" data-done="${p.id}">已保养</button>
       <button class="btn sm" data-adjust="${p.id}">改周期</button>
       <button class="btn sm ghost" data-pause="${p.id}">暂停</button>`;
  return `<div class="plan ${p.level}${paused ? ' paused' : ''}">
    <div class="row between">
      <div class="grow">
        <div class="name${longName ? ' has-more' : ''}"${longName ? ' data-nm="' + esc(p.id) + '"' : ''}>${esc(nmShow)}${longName ? '<span class="nm-more">' + (nmOpen ? '收起' : '展开') + '</span>' : ''}${p.spec ? '<span class="spec">' + esc(p.spec) + '</span>' : ''}</div>
        <div class="meta">
          ${due.length ? '下次：' + due.join(' ') : '未设置下次时间'}
          ${p.last_done_at ? '<br>上次：' + ymd(p.last_done_at) + (p.last_km ? ' · ' + kmText(p.last_km) : '') : ''}
          <br>依据：${esc(BASIS_TEXT[p.basis] || p.basis || '—')}${p.interval_months ? ' · 每 ' + p.interval_months + ' 个月' : ''}${p.interval_km ? ' / ' + p.interval_km + ' km' : ''}
          ${paused ? '<br>提醒已暂停：重新启用后会继续按上面时间提醒' : ''}
        </div>
      </div>
      <div style="text-align:right;white-space:nowrap">
        <span class="badge">${paused ? '已暂停' : (LEVEL_TEXT[p.level] || p.level)}</span>
        ${paused ? '' : (p.reason ? '<div class="reason">' + esc(p.reason) + '</div>' : '')}
      </div>
    </div>
    ${pr ? `<div class="progress">
      <div class="progress-track"><div class="progress-fill" style="width:${pr.pct}%"></div></div>
      <div class="progress-cap"><span>上次 ${ymd(p.last_done_at)}</span><span>到期 ${ymd(p.next_due_at)}</span></div>
    </div>` : ''}
    <div class="row" style="margin-top:10px">${acts}</div>
  </div>`;
}

async function updateKm(vid) {
  const v = state.vehicles.find((x) => x.id === vid);
  const r = await askForm({
    title: '更新里程',
    fields: [{
      key: 'km', label: '当前总里程（公里）', type: 'number', inputmode: 'numeric', placeholder: '例如 45000',
      value: v && v.current_km ? v.current_km : '',
    }],
  });
  if (!r) return;
  const km = parseInt(String(r.km).replace(/[^\d]/g, ''), 10);
  if (!isFinite(km) || km <= 0) return toast('里程数不合法', true);
  try {
    await api('/api/vehicles/' + vid, { method: 'PATCH', body: { current_km: km } });
    toast('里程已更新');
    await renderBoard();
  } catch (e) { toast(e.message, true); }
}

async function markDone(pid) {
  const p = state.plans.find((x) => x.id === pid);
  const cur = state.vehicles.find((x) => x.id === (p && p.vehicle_id));
  const r = await askForm({
    title: '标记为已做',
    body: p ? p.item_name : '',
    fields: [{
      key: 'km', label: '本次保养时的里程（公里，可留空）', type: 'number', inputmode: 'numeric',
      value: cur && cur.current_km ? cur.current_km : '',
    }],
  });
  if (!r) return;
  const km = String(r.km).trim() ? parseInt(String(r.km).replace(/[^\d]/g, ''), 10) : null;
  try {
    await api('/api/plans/' + pid, { method: 'PATCH', body: { action: 'done', current_km: km } });
    toast('已记录，并顺延下次时间');
    await renderBoard();
  } catch (e) { toast(e.message, true); }
}

async function adjustPlan(pid) {
  const p = state.plans.find((x) => x.id === pid);
  const r = await askForm({
    title: '调整「' + (p ? p.item_name : '该项目') + '」',
    hint: '日期留空表示清掉到期时间；月/公里留空表示保持原值。',
    fields: [
      { key: 'next_due_at', label: '下次到期日期（YYYY-MM-DD）', value: p && p.next_due_at ? p.next_due_at : '' },
      { key: 'interval_months', label: '每隔多少个月提醒', type: 'number', inputmode: 'numeric', value: p && p.interval_months ? p.interval_months : '' },
      { key: 'interval_km', label: '每隔多少公里提醒', type: 'number', inputmode: 'numeric', value: p && p.interval_km ? p.interval_km : '' },
    ],
  });
  if (!r) return;
  const d = String(r.next_due_at || '');
  const m = String(r.interval_months || '');
  const k = String(r.interval_km || '');
  const body = {};
  if (d.trim() === '') body.next_due_at = ''; else if (/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) body.next_due_at = d.trim();
  if (m.trim()) body.interval_months = parseInt(m, 10);
  if (k.trim()) body.interval_km = parseInt(k, 10);
  try {
    await api('/api/plans/' + pid, { method: 'PATCH', body });
    toast('已更新');
    await renderBoard();
  } catch (e) { toast(e.message, true); }
}

async function pausePlan(pid) {
  const yes = await askConfirm({
    title: '暂停提醒',
    body: '暂停这个项目后不再提醒，之后可以随时重新启用。',
    okText: '暂停', danger: true,
  });
  if (!yes) return;
  try {
    await api('/api/plans/' + pid, { method: 'PATCH', body: { status: 'paused' } });
    toast('已暂停');
    await renderBoard();
  } catch (e) { toast(e.message, true); }
}

/** 重新启用被暂停的提醒 */
async function resumePlan(pid) {
  try {
    await api('/api/plans/' + pid, { method: 'PATCH', body: { status: 'active' } });
    toast('已重新启用，到期会继续提醒');
    await renderBoard();
  } catch (e) { toast(e.message, true); }
}

// ---------------- 车辆编辑 ----------------
function editVehicle(vid) {
  const v = state.vehicles.find((x) => x.id === vid) || {};
  const PLATE_ATTR = 'maxlength="9" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="粤B·8T9X2"';
  const rows = [
    ['nickname', '昵称', v.nickname || '', ''],
    ['brand', '品牌', v.brand || '', ''],
    ['series', '车系/车型', v.series || '', ''],
    ['model_year', '年款', v.model_year || '', ''],
    ['plate', '车牌号', formatPlate(v.plate || ''), PLATE_ATTR],
    ['vin', '车架号 VIN', v.vin || '', ''],
    ['purchase_date', '购车日期', v.purchase_date || '', ''],
    ['current_km', '当前里程(km)', v.current_km || '', ''],
    ['fuel_consumption', '油耗(L/100km)', v.fuel_consumption || '', 'inputmode="decimal" placeholder="例如 7.5"'],
  ];
  view().innerHTML = `<div class="card form2">
    <h2>${vid ? '编辑车辆' : '新建车辆'}</h2>
    ${rows.map(([k, label, val, extra]) => `<label class="field"><span>${label}</span><input type="text" data-f="${k}" value="${esc(val)}" ${extra || ''}></label>`).join('')}
    <div class="row">
      <button class="btn primary grow" id="saveVeh">保存</button>
      <button class="btn" id="cancelVeh">取消</button>
      ${vid ? `<button class="btn danger" id="delVeh">删除</button>` : ''}
    </div>
  </div>`;
  $('#cancelVeh').onclick = () => setTab('board');
  $('#saveVeh').onclick = async () => {
    const body = {};
    view().querySelectorAll('[data-f]').forEach((i) => { body[i.dataset.f] = i.value.trim() || null; });
    try {
      const r = await api(vid ? '/api/vehicles/' + vid : '/api/vehicles', { method: vid ? 'PATCH' : 'POST', body });
      if (!vid) state.currentVehicleId = r.id;
      toast('已保存');
      setTab('board');
    } catch (e) { toast(e.message, true); }
  };
  const del = $('#delVeh');
  if (del) del.onclick = async () => {
    const yes = await askConfirm({
      title: '删除车辆',
      body: '删除车辆会同时删除它的保养记录和保养计划，且无法恢复。',
      okText: '删除', danger: true,
    });
    if (!yes) return;
    try { await api('/api/vehicles/' + vid, { method: 'DELETE' }); toast('已删除'); state.currentVehicleId = null; setTab('board'); }
    catch (e) { toast(e.message, true); }
  };
}

// ---------------- 上传识别 ----------------
const GUIDE = {
  vehicle: `打开【途虎养车】App → 底部【我的】→【我的车辆】→ 点开你的车 → 截图这一页（能看到车牌、车型、VIN）。
也可以在【我的】→【车辆管理】里先添加/补全车辆信息，再截图。`,
  record: `打开【途虎养车】App → 底部【我的】→【我的订单】或【养护记录】→ 找到已完成的那笔保养/换胎订单 → 点进订单详情 → 截图。
尤其是带「养护记录已生成，可查看全部记录」和「质保截止至 X 年 X 月 X 日」的那一屏。`,
};

function renderUpload() {
  const hasVeh = state.vehicles.length > 0;
  view().innerHTML = `
    <div class="card">
      <h2>1. 这张截图是什么？</h2>
      <div class="row">
        <button class="btn ${state.upTarget === 'record' ? 'primary' : ''}" data-t="record" style="flex:1">保养订单</button>
        <button class="btn ${state.upTarget === 'vehicle' ? 'primary' : ''}" data-t="vehicle" style="flex:1">车辆信息</button>
      </div>
      ${state.upTarget === 'record' && !hasVeh ? '<div class="hint" style="color:#b45309">当前还没有车辆档案，建议先上传「车辆信息」截图，这样保养记录才能挂到车上。</div>' : ''}
      ${state.upTarget === 'record' && hasVeh ? `
      <label class="field" style="margin-top:12px"><span>挂到哪辆车</span>
        <select id="upVeh">${state.vehicles.map((v) => `<option value="${v.id}" ${v.id === state.currentVehicleId ? 'selected' : ''}>${esc(vehicleLabel(v))}</option>`).join('')}</select>
      </label>` : ''}
    </div>

    <details class="card"><summary>去哪截图？点开看步骤</summary>
      <div class="guide" style="margin-top:10px"><b>${state.upTarget === 'vehicle' ? '车辆信息截图路径' : '保养记录截图路径'}</b>
        <div style="margin-top:6px;white-space:pre-line">${esc(GUIDE[state.upTarget])}</div>
        <div class="hint">截图越完整（包含金额、质保期、施工日期）识别越准。</div>
      </div>
    </details>

    <div class="card">
      <h2>2. 选择或拍摄截图</h2>
      <div class="drop" id="drop">
        <input type="file" accept="image/*" id="file" style="display:none">
        <div id="dropInner">点击选择图片<br><span class="muted">支持相册与拍照，会自动压缩后再上传</span></div>
      </div>
      <button class="btn primary block" id="doUpload" style="margin-top:12px" disabled>开始识别</button>
    </div>
    <div id="result"></div>`;

  view().querySelectorAll('[data-t]').forEach((b) => {
    b.onclick = () => { state.upTarget = b.dataset.t; renderUpload(); };
  });
  const drop = $('#drop'), file = $('#file');
  drop.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const s = await shrinkImage(f);
      state.upFile = f; state.upBlob = s.blob; state.upThumb = s.thumbDataUrl;
      drop.classList.add('has-image');
      $('#dropInner').innerHTML = `<img src="${s.thumbDataUrl}" alt="预览">`;
      $('#doUpload').disabled = false;
    } catch (e) { toast(e.message, true); }
  };
  $('#doUpload').onclick = doUpload;
  const sel = $('#upVeh');
  if (sel) sel.onchange = () => { state.currentVehicleId = sel.value; };
}

async function doUpload() {
  if (!state.upBlob) return;
  const btn = $('#doUpload');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 识别中，大约 5-20 秒…';
  $('#result').innerHTML = '';
  try {
    const fd = new FormData();
    fd.append('image', state.upBlob, 'shot.jpg');
    fd.append('target', state.upTarget || 'record');
    if (state.currentVehicleId) fd.append('vehicle_id', state.currentVehicleId);
    if (state.upThumb) fd.append('thumb', state.upThumb);
    const r = await api('/api/uploads', { method: 'POST', body: fd });
    state.pending = r;
    if (r.error) {
      $('#result').innerHTML = `<div class="card"><div class="error-box">识别失败：${esc(r.error)}</div>
        <div class="hint">可以在【设置 → 识别通道】里切换到外部多模态 API，识别中文长截图更准。</div>
        <button class="btn block" onclick="document.getElementById('doUpload').click()">重试</button></div>`;
    } else {
      renderConfirm(r);
    }
  } catch (e) {
    $('#result').innerHTML = '<div class="card"><div class="error-box">' + esc(e.message) + '</div></div>';
  }
  btn.disabled = false;
  btn.textContent = '重新识别';
}

function renderConfirm(r) {
  const p = r.parsed || {};
  const isVeh = (p.target || state.upTarget) === 'vehicle';
  const box = $('#result');
  if (isVeh) {
    const rows = [
      ['nickname', '昵称', p.nickname, ''], ['brand', '品牌', p.brand, ''], ['series', '车系/车型', p.series, ''],
      ['model_year', '年款', p.model_year, ''], ['plate', '车牌号', formatPlate(p.plate || ''), 'maxlength="9" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="粤B·8T9X2"'], ['vin', '车架号 VIN', p.vin, ''],
      ['purchase_date', '购车日期', p.purchase_date, ''], ['current_km', '当前里程(km)', p.current_km, ''],
    ];
    box.innerHTML = `<div class="card">
      <h2>3. 核对识别结果</h2>
      <div class="hint" style="margin-bottom:10px">通道：${esc(r.channel)} · 模型：${esc(r.model || '—')}。请核对后再保存。</div>
      ${rows.map(([k, label, val, extra]) => `<label class="field"><span>${label}</span><input type="text" data-f="${k}" value="${esc(val === null || val === undefined ? '' : val)}" ${extra || ''}></label>`).join('')}
      <label class="field"><span>保存为</span>
        <select id="vehTarget">
          <option value="">新建一辆车</option>
          ${state.vehicles.map((v) => `<option value="${v.id}">更新：${esc(vehicleLabel(v))}</option>`).join('')}
        </select>
      </label>
      <div class="row"><button class="btn primary grow" id="confirmBtn">确认保存</button>
      <button class="btn" id="discardBtn">丢弃</button></div>
    </div>`;
  } else {
    const items = Array.isArray(p.items) ? p.items : [];
    box.innerHTML = `<div class="card">
      <h2>3. 核对识别结果</h2>
      <div class="hint" style="margin-bottom:10px">通道：${esc(r.channel)} · 模型：${esc(r.model || '—')}。改完再保存，识别错了不影响已有记录。</div>
      <label class="field"><span>门店 / 平台</span><input type="text" data-f="shop" value="${esc(p.shop || '')}"></label>
      <label class="field"><span>施工 / 下单时间</span><input type="text" data-f="order_time" placeholder="YYYY-MM-DDTHH:mm:ss" value="${esc(p.order_time || '')}"></label>
      <div class="row">
        <label class="field grow"><span>实付金额</span><input type="text" data-f="total_amount" value="${esc(p.total_amount === null || p.total_amount === undefined ? '' : p.total_amount)}"></label>
        <label class="field grow"><span>里程(km)</span><input type="text" data-f="mileage_km" value="${esc(p.mileage_km === null || p.mileage_km === undefined ? '' : p.mileage_km)}"></label>
      </div>
      <h3>项目明细（${items.length}）</h3>
      <div id="items"></div>
      <button class="btn sm" id="addItem">＋ 添加一行</button>
      <div class="row" style="margin-top:12px"><button class="btn primary grow" id="confirmBtn">确认保存并生成计划</button>
      <button class="btn" id="discardBtn">丢弃</button></div>
    </div>`;
    $('#items').innerHTML = items.map(itemRow).join('');
    $('#addItem').onclick = () => {
      const d = document.createElement('div');
      d.innerHTML = itemRow({ name: '', spec: '', qty: '', unit_price: '', amount: '', warranty_until: '' });
      $('#items').appendChild(d.firstElementChild);
    };
    box.querySelectorAll('[data-delitem]').forEach((b) => {
      b.onclick = () => b.closest('.item-edit').remove();
    });
  }

  $('#confirmBtn').onclick = confirmPending;
  $('#discardBtn').onclick = async () => {
    try { if (state.pending && state.pending.upload_id) await api('/api/uploads/' + state.pending.upload_id, { method: 'DELETE' }); } catch (e) { /* 忽略 */ }
    state.pending = null;
    $('#result').innerHTML = '';
    toast('已丢弃');
  };
}

function itemRow(it) {
  const v = it || {};
  const val = (x) => esc(x === null || x === undefined ? '' : x);
  return `<div class="item-edit">
    <label class="field"><span>项目名称</span><input type="text" data-i="name" value="${val(v.name)}"></label>
    <label class="field"><span>规格</span><input type="text" data-i="spec" value="${val(v.spec)}"></label>
    <div class="row">
      <label class="field grow"><span>数量</span><input type="text" data-i="qty" value="${val(v.qty)}"></label>
      <label class="field grow"><span>单价</span><input type="text" data-i="unit_price" value="${val(v.unit_price)}"></label>
      <label class="field grow"><span>小计</span><input type="text" data-i="amount" value="${val(v.amount)}"></label>
    </div>
    <label class="field"><span>质保截止日期（有就填，会优先按它提醒）</span><input type="text" data-i="warranty_until" placeholder="YYYY-MM-DD" value="${val(v.warranty_until)}"></label>
    <button class="btn sm danger" data-delitem="1">删除这一行</button>
  </div>`;
}

async function confirmPending() {
  const r = state.pending;
  if (!r) return;
  const btn = $('#confirmBtn');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const parsed = {};
    view().querySelectorAll('[data-f]').forEach((i) => { parsed[i.dataset.f] = i.value.trim(); });
    if ((parsed.target === 'vehicle') || state.upTarget === 'vehicle') {
      const body = { target: 'vehicle', parsed, vehicle_id: ($('#vehTarget') || {}).value || null };
      const res = await api('/api/uploads/' + r.upload_id + '/confirm', { method: 'POST', body });
      state.currentVehicleId = res.vehicle_id;
      toast('车辆已保存');
    } else {
      parsed.items = Array.from(view().querySelectorAll('.item-edit')).map((row) => {
        const o = {};
        row.querySelectorAll('[data-i]').forEach((i) => { o[i.dataset.i] = i.value.trim(); });
        return o;
      }).filter((o) => o.name);
      if (!parsed.items.length) throw new Error('至少保留一个项目');
      const body = { target: 'record', parsed, vehicle_id: state.currentVehicleId };
      const res = await api('/api/uploads/' + r.upload_id + '/confirm', { method: 'POST', body });
      toast('已入库，生成 ' + (res.plans || []).length + ' 条保养计划');
    }
    state.pending = null; state.upBlob = null; state.upThumb = null;
    setTab('board');
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false; btn.textContent = '确认保存';
  }
}

// ---------------- 记录 ----------------
function localToday() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** '2026-09' 前后挪 n 个月，仍是 'YYYY-MM'（跨年由 Date 自己进位） */
function monthShift(ym, delta) {
  const [y, m] = String(ym).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + (d.getMonth() + 1 < 10 ? '0' + (d.getMonth() + 1) : String(d.getMonth() + 1));
}

/** '2026-09' → '2026年9月' */
function monthLabel(ym) {
  const [, m] = String(ym).split('-').map(Number);
  return String(ym).slice(0, 4) + '年' + m + '月';
}

// 记录页类型筛选条（FEAT-005）。杂项 = 后端的 beauty，和「记一笔杂项」同一套叫法。
const REC_TYPES = [
  { key: 'all', label: '全部' },
  { key: 'fuel', label: '加油' },
  { key: 'maintenance', label: '保养' },
  { key: 'beauty', label: '杂项' },
];
const REC_PAGE_SIZE = 5; // 每页最多 5 条

/**
 * 换月筛选。ym 传 '' / null = 「全部月份」（默认态）。
 * 换筛选一律回到第 1 页 —— 否则会停在「第 3 页却没有 3 页」的空页上。
 */
function gotoMonth(ym) {
  state.recordsMonth = ym || '';
  state.recordsYear = String(ym || ((state.recordsMonths || [])[0] && (state.recordsMonths || [])[0].m) || localToday()).slice(0, 4);
  state.recPage = 1;
  renderRecords();
}

/** 换类型筛选 */
function gotoRecType(t) {
  state.recType = t || 'all';
  state.recPage = 1;
  renderRecords();
}

/** 翻页 */
function gotoRecPage(n) {
  state.recPage = Math.max(Number(n) || 1, 1);
  renderRecords();
}

/**
 * 刚记完一笔之后：回到第 1 页；如果当前的类型 / 月份筛选会把刚记的这笔挡在外面，
 * 就先放开筛选 —— 否则「记完了却看不到」会被当成没保存成功。
 */
function afterAddRecord(kind, orderTime) {
  if (state.recType !== 'all' && state.recType !== kind) state.recType = 'all';
  const ym = String(orderTime || '').slice(0, 7);
  if (state.recordsMonth && ym && state.recordsMonth !== ym) state.recordsMonth = '';
  state.recPage = 1;
  renderRecords();
}

/** 12 格年历：有数据的亮着并带笔数，没数据的置灰但仍可点 */
function monthGridHtml(viewYear) {
  const byMonth = new Map((state.recordsMonths || []).map((x) => [x.m, x]));
  const cells = [];
  for (let i = 1; i <= 12; i++) {
    const mm = viewYear + '-' + (i < 10 ? '0' + i : String(i));
    const info = byMonth.get(mm);
    const on = mm === state.recordsMonth;
    cells.push(`<button class="mon-cell${on ? ' on' : (info ? '' : ' dim')}" data-mon="${mm}"${on ? ' aria-current="true"' : ''}>
      <span>${i}月</span>${info ? `<small>${info.n} 笔</small>` : ''}
    </button>`);
  }
  return `<div class="mon-grid">${cells.join('')}</div>`;
}

/** 底部浮层选月器：点记录页的月份筛选弹起，点遮罩 / Esc / 选完都收起 */
function openMonthSheet() {
  // 「全部月份」态下 recordsMonth 是空串，这里要回落到当前年份，
  // 否则年历会去算 '-01'、'-02' 这种空月份，一格都不亮。
  const curYear = () => String(state.recordsYear || String(state.recordsMonth || localToday()).slice(0, 4));
  const wrap = buildModal(
    '<div class="sheet-head"><b>选择月份</b>' +
    '<span style="display:flex;gap:6px;align-items:center">' +
    `<button class="btn sm ${state.recordsMonth ? 'ghost' : 'primary'}" data-act="all">全部月份</button>` +
    '<button class="btn sm ghost" data-act="today">回到本月</button></span></div>' +
    '<div id="sheetBody"></div>');

  const finish = () => { document.removeEventListener('keydown', onKey); closeModal(wrap); };
  const onKey = (e) => { if (e.key === 'Escape') finish(); };
  const pick = (ym) => { finish(); gotoMonth(ym); };

  const paint = () => {
    const y = curYear();
    const ms = (state.recordsMonths || []).filter((x) => String(x.m).slice(0, 4) === y);
    const n = ms.reduce((s, x) => s + (Number(x.n) || 0), 0);
    const amt = ms.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const body = $('#sheetBody', wrap);
    body.innerHTML =
      `<div class="mon-year">
         <button class="btn sm mon-nav" data-act="yprev" title="上一年">‹</button>
         <div class="mon-year-mid"><b>${esc(y)}年</b>
           <span class="muted">${n ? n + ' 笔 · ' + esc(money(amt)) : '该年暂无记录'}</span></div>
         <button class="btn sm mon-nav" data-act="ynext" title="下一年">›</button>
       </div>` + monthGridHtml(y);
    body.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => { state.recordsYear = String(Number(curYear()) + (b.dataset.act === 'yprev' ? -1 : 1)); paint(); };
    });
    body.querySelectorAll('[data-mon]').forEach((b) => { b.onclick = () => pick(b.dataset.mon); });
  };

  paint();
  const scrim = $('.modal-scrim', wrap); if (scrim) scrim.onclick = finish;
  const tb = $('[data-act="today"]', wrap); if (tb) tb.onclick = () => pick(localToday().slice(0, 7));
  const ab = $('[data-act="all"]', wrap); if (ab) ab.onclick = () => pick('');
  document.addEventListener('keydown', onKey);
}

async function renderRecords() {
  const seq = renderBegin();
  // 默认「全部月份」：state.recordsMonth 是空串时就显示全部历史记录（FEAT-005 要求 1 / 4）
  if (!state.recType) state.recType = 'all';
  if (!state.recPage) state.recPage = 1;
  const month = state.recordsMonth || '';
  const buildQs = () => {
    const qs = [];
    if (state.currentVehicleId) qs.push('vehicle_id=' + state.currentVehicleId);
    if (month) qs.push('month=' + encodeURIComponent(month));        // 月份改成可选筛选
    if (state.recType !== 'all') qs.push('type=' + state.recType);   // 类型筛选
    qs.push('page=' + state.recPage, 'page_size=' + REC_PAGE_SIZE);  // 服务端分页
    return qs.join('&');
  };
  // BUG-019：翻页 / 换月 / 换筛选的结果缓存起来，来回切不再重复请求。
  // 缓存键必须把 type 与 page 也带上，否则换了筛选会命中上一份结果。
  state.recordsCache = state.recordsCache || {};
  const ck = [state.currentVehicleId || '-', month || 'all', state.recType, state.recPage].join('|');
  let r = state.recordsCache[ck];
  if (!r) {
    view().innerHTML = skeletonList(REC_PAGE_SIZE);
    try { r = await api('/api/records?' + buildQs()); }
    catch (e) { if (!renderStale(seq)) view().innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; return; }
    state.recordsCache[ck] = r;
  }
  // BUG-025：记录页的数据只写进 state.viewRecords。state.records 是看板用的全量数据，
  // 两边共用同一个数组会让看板统计随导航顺序变化。
  state.viewRecords = r.records || [];
  state.recordsMonths = r.months || [];
  const total = Number(r.total || 0);
  const pages = Math.max(Number(r.pages || 1), 1);
  // 服务端会把页码夹在 [1, pages] 内（删掉最后一条 / 筛选变窄时用得上），本地跟着同步
  const page = Math.min(Math.max(Number(r.page || 1), 1), pages);
  if (page !== state.recPage) state.recPage = page;
  // 旧逻辑「本月没记录就自动跳到最近有记录的月」已删除：默认态是「全部月份」，
  // 本来就不会因为当月为空而看到空列表。

  const hasVeh = state.vehicles.length > 0;
  const thisMonth = localToday().slice(0, 7);
  const totalAmount = Number(r.total_amount || 0);
  const scopeTxt = total ? ('共 ' + total + ' 条 · ' + money(totalAmount)) : '没有记录';

  // 顶部筛选卡：类型 chips（全部 / 加油 / 保养 / 杂项）+ 月份筛选（可选，默认「全部月份」）
  let html = `<div class="card monpick">
    <div class="frow">
      <span class="flab">类型</span>
      <div class="fchips">${REC_TYPES.map((t) =>
        `<button class="fchip${state.recType === t.key ? ' on' : ''}" data-rectype="${t.key}">${t.label}</button>`).join('')}</div>
    </div>
    <div class="frow">
      <span class="flab">月份</span>
      <button class="mon-toggle" id="monToggle" aria-haspopup="dialog" title="点这里选择月份">
        <span class="fchip${month ? '' : ' on'}">${esc(month ? monthLabel(month) : '全部月份')}</span>
        <span class="mon-caret" aria-hidden="true">▾</span>
      </button>
      <span class="mon-navs">
        <button class="btn sm mon-nav" id="monPrev" title="上一个月"${month ? '' : ' disabled'}>‹</button>
        <button class="btn sm mon-nav" id="monNext" title="下一个月"${month ? '' : ' disabled'}>›</button>
      </span>
    </div>
    <div class="frow">
      <span class="flab"></span>
      <span class="muted fsum">${esc(scopeTxt)}</span>
      ${(month && month !== thisMonth) ? '<button class="btn sm ghost" id="monToday">回到本月</button>' : ''}
      ${month ? '<button class="btn sm ghost" id="monAll">全部月份</button>' : ''}
    </div>
  </div>
  <div class="card" style="padding:10px 12px">
    <div class="row">
      <button class="btn primary grow" id="addFuelBtn">记一笔加油</button>
      <button class="btn grow" id="addBeautyBtn">记一笔杂项</button>
      <button class="btn grow" id="addMaintBtn">记一笔保养</button>
    </div>
    ${hasVeh ? '' : '<div class="hint" style="margin-top:8px">还没有车辆档案：建议先建一辆车，记录才能挂到车上并推算里程。</div>'}
  </div>`;

  if (!state.viewRecords.length) {
    const filtered = state.recType !== 'all' || !!month;
    html += emptyBox({
      illu: 'book',
      title: filtered ? '这个筛选条件下没有记录' : '还没有任何记录',
      desc: filtered
        ? '把上面的类型切回「全部」、月份切回「全部月份」，就能看到全部历史记录。'
        : '上传保养订单截图会自动入库，加油 / 杂项 / 保养也可以直接在上面手动记一笔。',
      acts: filtered ? [] : [{ act: 'goto-upload', label: '去上传保养截图' }],
    });
  } else {
    html += state.viewRecords.map(recordCard).join('');
  }

  // 底部分页条（FEAT-005 要求 2）：每页最多 5 条，显示「共X条 · 第Y/Z页」
  if (total > 0) {
    html += `<div class="pager">
      <button class="btn sm" id="pgPrev"${page <= 1 ? ' disabled' : ''}>上一页</button>
      <span class="pager-info">共${total}条 · 第${page}/${pages}页</span>
      <button class="btn sm" id="pgNext"${page >= pages ? ' disabled' : ''}>下一页</button>
    </div>`;
  }
  if (renderStale(seq)) return; // 等请求的这段时间里 tab 已切走，别把别的页面覆盖掉
  view().innerHTML = html;

  // 类型筛选
  view().querySelectorAll('[data-rectype]').forEach((b) => { b.onclick = () => gotoRecType(b.dataset.rectype); });
  // 月份筛选：点开底部年历浮层；‹ › 直接翻月（「全部月份」态下禁用）
  const tg = $('#monToggle'); if (tg) tg.onclick = openMonthSheet;
  const pv = $('#monPrev'); if (pv) pv.onclick = () => gotoMonth(monthShift(month, -1));
  const nx = $('#monNext'); if (nx) nx.onclick = () => gotoMonth(monthShift(month, 1));
  const td = $('#monToday'); if (td) td.onclick = () => gotoMonth(thisMonth);
  const ma = $('#monAll'); if (ma) ma.onclick = () => gotoMonth('');
  // 分页
  const pp = $('#pgPrev'); if (pp) pp.onclick = () => gotoRecPage(state.recPage - 1);
  const pn = $('#pgNext'); if (pn) pn.onclick = () => gotoRecPage(state.recPage + 1);
  const fb = $('#addFuelBtn'); if (fb) fb.onclick = addFuelRecord;
  const bb = $('#addBeautyBtn'); if (bb) bb.onclick = addBeautyRecord;
  const mb = $('#addMaintBtn'); if (mb) mb.onclick = addMaintRecord;
  view().querySelectorAll('[data-delrec]').forEach((b) => {
    b.onclick = async () => {
      const rec = state.viewRecords.find((x) => x.id === b.dataset.delrec) || {};
      const yes = await askConfirm({
        title: '删除这条记录',
        body: rec.kind === 'maintenance' ? '会同时删除由这条记录生成的保养计划。' : '',
        okText: '删除', danger: true,
      });
      if (!yes) return;
      // 删完重拉：服务端会把页码夹回有效范围（删掉某页唯一一条时不会停在空页）
      try { await api('/api/records/' + b.dataset.delrec, { method: 'DELETE' }); toast('已删除'); renderRecords(); }
      catch (e) { toast(e.message, true); }
    };
  });
}

function recordCard(rec) {
  const when = esc(String(rec.order_time || rec.created_at || '').replace('T', ' ').slice(0, 16));
  const amountHtml = (rec.total_amount !== null && rec.total_amount !== undefined) ? '¥' + esc(rec.total_amount) : '';
  const delBtn = `<button class="btn sm danger" data-delrec="${rec.id}" style="margin-top:6px">删除</button>`;

  if (rec.kind === 'fuel') {
    return `<div class="card">
      <div class="row between">
        <div class="grow"><b>加油</b>${rec.shop ? ' <span class="muted">' + esc(rec.shop) + '</span>' : ''}
          <div class="muted">${when}</div>
        </div>
        <div style="text-align:right"><div>${amountHtml}</div>${delBtn}</div>
      </div>
      <div class="row wrap" style="gap:6px;margin-top:8px">
        ${rec.liters ? '<span class="pill on">' + esc(String(rec.liters)) + ' 升</span>' : ''}
        ${rec.unit_price ? '<span class="pill">单价 ' + esc(String(rec.unit_price)) + ' 元/升</span>' : ''}
        ${rec.est_km ? '<span class="pill">按固定油耗约 ' + esc(String(rec.est_km)) + ' km</span>' : ''}
      </div>
    </div>`;
  }

  if (rec.kind === 'beauty') {
    const names = (rec.items || []).map((i) => i.item_name).join('、');
    return `<div class="card">
      <div class="row between">
        <div class="grow"><b>${esc(names || '杂项')}</b>${rec.shop ? ' <span class="muted">' + esc(rec.shop) + '</span>' : ''}
          <div class="muted">${when}</div>
        </div>
        <div style="text-align:right"><div>${amountHtml}</div>${delBtn}</div>
      </div>
    </div>`;
  }

  // 保养：原有样式
  return `<div class="card">
    <div class="row between">
      <div class="grow"><b>${esc(rec.shop || '未知门店')}</b>
        <div class="muted">${when}${rec.mileage_km ? ' · ' + esc(rec.mileage_km) + ' km' : ''}</div>
      </div>
      <div style="text-align:right"><div>${amountHtml}</div>${delBtn}</div>
    </div>
    <table style="margin-top:8px">
      <tr><th>项目</th><th>规格</th><th>数量</th><th>金额</th><th>质保至</th></tr>
      ${(rec.items || []).map((i) => `<tr>
        <td>${esc(i.item_name)}</td><td>${esc(i.spec || '—')}</td>
        <td>${esc(i.qty === null || i.qty === undefined ? '—' : i.qty)}</td>
        <td>${esc(i.amount === null || i.amount === undefined ? '—' : i.amount)}</td>
        <td>${esc(i.warranty_until || '—')}</td>
      </tr>`).join('')}
    </table>
  </div>`;
}

/** 加油：金额 + 油价 → 升数；按车辆里设的固定油耗预估公里数并累加到总里程（BUG-016） */
async function addFuelRecord() {
  const v = state.vehicles.find((x) => x.id === state.currentVehicleId) || state.vehicles[0];
  if (!v) { toast('先建一辆车，才能记加油（要按油耗预估公里数）', true); return; }
  const r = await askForm({
    title: '记一笔加油',
    body: vehicleTitle(v),
    fields: [
      { key: 'amount', label: '本次金额（元）', placeholder: '例如 200' },
      { key: 'unit_price', label: '油价（元/升）', placeholder: '例如 7.5' },
      { key: 'liters', label: '实际升数（可选，填了就不按油价算）', inputmode: 'decimal' },
      { key: 'order_time', label: '日期（默认今天）', value: localToday(), placeholder: 'YYYY-MM-DD' },
      { key: 'shop', label: '加油站（可选）', placeholder: '例如 中石化' },
    ],
    hint: v.fuel_consumption
      ? '这辆车油耗 ' + v.fuel_consumption + ' L/100km：按这个固定油耗估算本笔油能跑多少公里，直接累加到车辆总里程。'
      : '这辆车还没填油耗（编辑车辆里可以补），本次不会预估公里数。',
  });
  if (!r) return;
  if (!String(r.amount || '').trim()) return toast('请填写金额', true);
  try {
    const res = await api('/api/records', { method: 'POST', body: {
      kind: 'fuel', vehicle_id: v.id,
      amount: r.amount, unit_price: r.unit_price, liters: r.liters,
      order_time: String(r.order_time || '').trim(), shop: r.shop,
    } });
    let msg = '已记加油' + (res.liters ? ' ' + res.liters + ' 升' : '');
    if (res.est_km) msg += '，预计可跑 ' + res.est_km + ' km';
    if (res.km_added) {
      msg += '；车辆里程已 +' + res.km_added + ' km';
      // 服务端已把 current_km 累加，同步本地缓存，后续表单预填才不会是旧值
      if (v.current_km !== null && v.current_km !== undefined) v.current_km = Number(v.current_km) + res.km_added;
    }
    toast(msg);
    // 记完回到第 1 页；万一当前筛选会把刚记的这笔挡住，就先放开筛选（FEAT-005）
    afterAddRecord('fuel', String(r.order_time || '').trim());
  } catch (e) { toast(e.message, true); }
}

/** 手动补录保养：不靠截图，直接录「机油/空滤…」，会像截图一样生成或顺延保养计划 */
async function addMaintRecord() {
  const v = state.vehicles.find((x) => x.id === state.currentVehicleId) || state.vehicles[0];
  if (!v) { toast('先建一辆车，才能记保养', true); return; }
  if (!state.catalog.length) {
    try { state.catalog = (await api('/api/catalog')).catalog || []; } catch (e) { state.catalog = []; }
  }
  const opts = state.catalog.map((c) => ({ value: c.name, label: c.name }));
  if (!opts.length) opts.push({ value: '机油', label: '机油' });
  const r = await askForm({
    title: '记一笔保养',
    body: vehicleTitle(v),
    fields: [
      { key: 'item_name', label: '保养项目', type: 'select', options: opts, value: '机油' },
      { key: 'amount', label: '金额（元）', placeholder: '例如 380' },
      { key: 'mileage_km', label: '当时里程（可选，填了才能按公里提醒）', inputmode: 'numeric', value: v.current_km || '' },
      { key: 'warranty_until', label: '质保至（可选，填了优先按它提醒）', placeholder: 'YYYY-MM-DD' },
      { key: 'order_time', label: '日期（默认今天）', value: localToday(), placeholder: 'YYYY-MM-DD' },
      { key: 'shop', label: '门店（可选）' },
    ],
    hint: '保存后会按内置周期表（或你的自定义周期）算出下次到期时间，和上传截图的效果一样。',
  });
  if (!r) return;
  if (!String(r.amount || '').trim()) return toast('请填写金额', true);
  try {
    const res = await api('/api/records', { method: 'POST', body: {
      kind: 'maintenance', vehicle_id: v.id,
      item_name: r.item_name, amount: r.amount, mileage_km: r.mileage_km,
      warranty_until: String(r.warranty_until || '').trim(),
      order_time: String(r.order_time || '').trim(), shop: r.shop,
    } });
    toast('已记录' + (res.plans ? '，并已更新保养计划' : ''));
    afterAddRecord('maintenance', String(r.order_time || '').trim());
  } catch (e) { toast(e.message, true); }
}

/** 日常杂项：洗车、打蜡、保险、年检等，只记账，不生成保养计划（BUG-020 由「汽车美容」改名） */
const MISC_ITEMS = ['洗车', '打蜡', '抛光', '车衣', '保险', '年检', '停车费', '过路费', '违章罚款'];

async function addBeautyRecord() {
  const r = await askForm({
    // BUG-020：「记一笔美容」改名「记一笔杂项」，项目改成日常用车分类下拉
    title: '记一笔杂项',
    fields: [
      { key: 'item_name', label: '项目', type: 'select', value: '洗车', options: MISC_ITEMS.map((x) => ({ value: x, label: x })) },
      { key: 'amount', label: '金额（元）', placeholder: '例如 30' },
      { key: 'order_time', label: '日期（默认今天）', value: localToday(), placeholder: 'YYYY-MM-DD' },
      { key: 'shop', label: '门店（可选）' },
    ],
  });
  if (!r) return;
  if (!String(r.amount || '').trim()) return toast('请填写金额', true);
  try {
    await api('/api/records', { method: 'POST', body: {
      kind: 'beauty',
      vehicle_id: state.currentVehicleId || undefined,
      item_name: r.item_name, amount: r.amount,
      order_time: String(r.order_time || '').trim(), shop: r.shop,
    } });
    toast('已记一笔 ' + (r.item_name || '杂项'));
    afterAddRecord('beauty', String(r.order_time || '').trim());
  } catch (e) { toast(e.message, true); }
}

// ---------------- 设置 ----------------
async function renderSettings() {
  const seq = renderBegin();
  // BUG-019：bootstrap 已把设置和周期表带回来，直接用，不再发两次请求
  if (!state.settings || !state.catalog.length) {
    view().innerHTML = skeletonForm();
    try {
      if (!state.settings) state.settings = (await api('/api/settings')).settings;
      if (!state.catalog.length) state.catalog = (await api('/api/catalog')).catalog || [];
    } catch (e) { if (!renderStale(seq)) view().innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; return; }
    if (renderStale(seq)) return; // 请求回来时 tab 已切走，别覆盖别的页面
  }
  const s = state.settings || {};

  const keys = s.bark_keys || [];
  const themePref = getThemePref();
  // 「关于」卡片的外链来自全站配置，bootstrap 已带回来（FEAT-001/002）
  const about = state.about || {};
  const unreadN = (state.announcements || []).length;
  view().innerHTML = `
    <div class="card form2">
      <h2>外观</h2>
      <div class="seg" id="themeSeg">
        ${[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, t]) => `<button data-th="${v}" class="${themePref === v ? 'on' : ''}">${t}</button>`).join('')}
      </div>
      <div class="hint">「跟随系统」会随手机的深浅色模式自动切换。这个偏好只保存在当前设备上，不影响其他手机。</div>
    </div>

    <div class="card form2">
      <h2>Bark 推送</h2>
      <div class="hint" style="margin-bottom:10px">在手机上装 Bark App，首页能看到一串 Key（形如 <code>abcdEFG123</code>），粘到下面即可。可以为每台手机填一个。</div>
      <div id="barkKeys">${keys.map(keyRow).join('')}</div>
      <button class="btn sm" id="addKey">＋ 添加 Key</button>
      <label class="field"><span>Bark 服务器（自建才需要改）</span><input type="text" id="barkServer" value="${esc(s.bark_server || 'https://api.day.app')}"></label>
      <label class="field"><span>提示音（可留空）</span><input type="text" id="barkSound" value="${esc(s.bark_sound || '')}" placeholder="例如 alarm / birdsong"></label>
      <div class="row">
        <label class="field grow"><span>通知分组</span><input type="text" id="barkGroup" value="${esc(s.bark_group || '车辆保养')}"></label>
        <label class="field grow"><span>通知级别</span>
          <select id="barkLevel">
            ${[['active', '默认'], ['timeSensitive', '时效性通知'], ['passive', '静默通知'], ['critical', '重要警告']].map(([v, t]) => `<option value="${v}" ${s.bark_level === v ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="hint">重要警告：会响铃并忽略静音与专注模式，需在 Bark App 里先授权。时效性通知：可突破专注模式。默认：正常响铃并亮屏。静默通知：只进通知中心，不亮屏、不出声。</div>
      <label class="row" style="gap:8px;align-items:center"><input type="checkbox" id="notifyEnabled" ${s.notify_enabled ? 'checked' : ''} style="width:auto"> <span>开启到期提醒（每天定时扫描一次）</span></label>
      <div class="row" style="margin-top:10px">
        <button class="btn grow" id="testPush">发送测试推送</button>
        <button class="btn" id="manualScan">立即扫描</button>
      </div>
    </div>

    <div class="card form2">
      <h2>提醒时机</h2>
      <div class="row">
        <label class="field grow"><span>到期前多少天提醒</span><input type="number" id="advanceDays" value="${esc(s.advance_days)}"></label>
        <label class="field grow"><span>到期前多少公里提醒</span><input type="number" id="advanceKm" value="${esc(s.advance_km)}"></label>
      </div>
      <div class="hint">同一个到期日只会提醒一次（临期一次、过期一次），不会天天轰炸。</div>
    </div>

    <div class="card form2">
      <h2>识别通道</h2>
      <div class="seg">
        <button data-ch="workers-ai" class="${s.ai_channel === 'workers-ai' ? 'on' : ''}">Workers AI（免费）</button>
        <button data-ch="external" class="${s.ai_channel === 'external' ? 'on' : ''}">外部 API</button>
      </div>
      <div class="hint" style="margin:10px 0">默认走 Cloudflare 内置视觉模型，不需要任何 Key、不额外花钱。如果识别中文长截图不够准，切到外部多模态 API（通义千问 qwen-vl-max、豆包、Kimi、GLM-4V 等都支持 OpenAI 兼容格式）。</div>
      <div id="extBox" style="${s.ai_channel === 'external' ? '' : 'display:none'}">
        <label class="field"><span>接口地址（到 /v1 为止）</span><input type="text" id="aiBase" value="${esc(s.ai_base_url || '')}" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"></label>
        <label class="field"><span>模型名</span><input type="text" id="aiModel" value="${esc(s.ai_model || '')}" placeholder="qwen-vl-max"></label>
        <label class="field"><span>API Key ${s.has_ai_key ? '（已保存，留空则不修改）' : ''}</span><input type="password" id="aiKey" placeholder="${s.has_ai_key ? '••••••••' : 'sk-...'}"></label>
      </div>
      <label class="row" style="gap:8px;align-items:center"><input type="checkbox" id="keepImg" ${s.keep_raw_image ? 'checked' : ''} style="width:auto"> <span>保存截图缩略图（默认关闭，更省空间也更保护隐私）</span></label>
    </div>

    <div class="card form2">
      <h2>自定义周期（覆盖通用表）</h2>
      <div class="hint" style="margin-bottom:10px">留空表示用内置通用周期。填了就按你填的算。</div>
      <div id="overrides"></div>
      <div class="row" style="margin-top:8px">
        <select id="ovItem" style="flex:2">${state.catalog.map((c) => `<option value="${c.code}">${esc(c.name)}</option>`).join('')}</select>
        <input type="number" id="ovMonths" placeholder="月" style="flex:1">
        <input type="number" id="ovKm" placeholder="km" style="flex:1">
        <button class="btn sm" id="addOv">加</button>
      </div>
    </div>

    <div class="card form2">
      <h2>数据备份与迁移</h2>
      <div class="hint" style="margin-bottom:10px">换手机、换账号或重装前先导出一份备份；以后拿这个文件就能完整恢复。账单也可以单独导成表格，用 Excel 直接打开。</div>
      <div class="row">
        <button class="btn grow" id="btnExport">导出全部数据</button>
        <button class="btn" id="btnExportCsv">导出账单表格</button>
      </div>
      <label class="field" style="margin-top:12px"><span>从备份文件恢复</span>
        <input type="file" id="importFile" accept="application/json,.json">
      </label>
      <div class="hint">导入是<b>完整恢复</b>：会用备份里的内容替换当前账号的车辆、账单与保养计划，不可撤销。AI 识别原文与推送历史不在备份范围内。</div>
    </div>

    <div class="card form2">
      <button class="btn primary block" id="saveSettings">保存全部设置</button>
      <div class="hint">登录账号：${esc(state.user.email)}</div>
    </div>

    <div class="card form2">
      <h2>关于</h2>
      <div class="row wrap" style="gap:8px">
        <button class="btn grow" id="btnGroup">${esc(about.group_title || '交流群')}</button>
        <button class="btn grow" id="btnFeedback">问题反馈</button>
        <button class="btn grow" id="btnAnnounce">产品公告${unreadN ? ' · ' + unreadN + ' 条新' : ''}</button>
      </div>
      <div class="hint">遇到问题、或者有想要的功能，点「问题反馈」告诉我们；版本更新与维护通知都放在「产品公告」里。用了一段时间的话，也欢迎到群里聊聊。</div>
    </div>

    <div class="card form2">
      <h2>个人账号管理</h2>
      <div class="hint" style="margin-bottom:10px">当前登录：${esc(state.user.email)}</div>
      <label class="field"><span>当前密码</span><input type="password" id="pwOld" autocomplete="current-password" placeholder="填写现在的密码"></label>
      <div class="row">
        <label class="field grow"><span>新密码（至少 6 位）</span><input type="password" id="pwNew" autocomplete="new-password"></label>
        <label class="field grow"><span>确认新密码</span><input type="password" id="pwNew2" autocomplete="new-password"></label>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn grow" id="btnChangePw">修改密码</button>
        <button class="btn danger grow" id="btnLogoutAcct">退出登录</button>
      </div>
      <div class="hint">改完密码后，其他设备上已登录的会话会立即失效，需要用新密码重新登录；当前这台设备不受影响。</div>
    </div>`;

  view().querySelectorAll('[data-th]').forEach((b) => {
    b.onclick = () => {
      setThemePref(b.dataset.th);
      view().querySelectorAll('[data-th]').forEach((x) => x.classList.toggle('on', x.dataset.th === b.dataset.th));
    };
  });
  view().querySelectorAll('[data-ch]').forEach((b) => {
    b.onclick = () => {
      view().querySelectorAll('[data-ch]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      $('#extBox').style.display = b.dataset.ch === 'external' ? '' : 'none';
      state._channel = b.dataset.ch;
    };
  });
  $('#addKey').onclick = () => {
    const d = document.createElement('div');
    d.innerHTML = keyRow('');
    $('#barkKeys').appendChild(d.firstElementChild);
    bindKeyRows();
  };
  bindKeyRows();
  $('#testPush').onclick = async () => {
    $('#testPush').disabled = true;
    try {
      await saveSettingsFields();
      const r = await api('/api/push/test', { method: 'POST' });
      toast(r.sent ? '已发送，看手机' : ('推送失败：' + (r.detail || '未知原因')), !r.sent);
    } catch (e) { toast(e.message, true); }
    $('#testPush').disabled = false;
  };
  $('#manualScan').onclick = async () => {
    $('#manualScan').disabled = true;
    try { const r = await api('/api/push/scan', { method: 'POST' }); const n = (r.pushed || []).length; toast(n ? '已推送 ' + n + ' 条' : '没有到期项目'); }
    catch (e) { toast(e.message, true); }
    $('#manualScan').disabled = false;
  };
  // 数据备份与迁移（BUG-024）
  $('#btnExport').onclick = async () => {
    $('#btnExport').disabled = true;
    try { await downloadFile('/api/export', '车辆保养助手-备份.json'); toast('备份已开始下载'); }
    catch (e) { toast(e.message, true); }
    $('#btnExport').disabled = false;
  };
  $('#btnExportCsv').onclick = async () => {
    $('#btnExportCsv').disabled = true;
    try { await downloadFile('/api/export/records.csv', '养车账单.csv'); toast('账单表格已开始下载'); }
    catch (e) { toast(e.message, true); }
    $('#btnExportCsv').disabled = false;
  };
  $('#importFile').onchange = async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const nv = (data.vehicles || []).length;
      const nr = (data.records || []).length;
      if (!Array.isArray(data.vehicles) || !Array.isArray(data.records)) throw new Error('这不是本应用的备份文件');
      const yes = await askConfirm({
        title: '确认导入备份',
        body: '将用备份文件完整替换当前账号的数据：' + nv + ' 辆车、' + nr + ' 笔记录、'
          + (data.plans || []).length + ' 条保养计划。此操作不可撤销。',
        okText: '导入并替换', danger: true,
      });
      if (!yes) return;
      const r = await api('/api/import', { method: 'POST', body: data });
      toast('已恢复 ' + r.imported.vehicles + ' 辆车、' + r.imported.records + ' 笔记录');
      // 数据全换了：缓存与设置都要重新取
      state.bootFresh = false; state.recordsCache = {}; state.settings = null;
      setTab('board');
    } catch (e) { toast(e.message || '导入失败', true); }
  };
  renderOverrides(s.item_overrides || {});
  $('#addOv').onclick = () => {
    const code = $('#ovItem').value;
    const m = $('#ovMonths').value.trim();
    const k = $('#ovKm').value.trim();
    if (!m && !k) return toast('月或公里至少填一个', true);
    const ov = state.settings.item_overrides || {};
    ov[code] = {};
    if (m) ov[code].months = parseInt(m, 10);
    if (k) ov[code].km = parseInt(k, 10);
    state.settings.item_overrides = ov;
    $('#ovMonths').value = ''; $('#ovKm').value = '';
    renderOverrides(ov);
  };
  $('#saveSettings').onclick = async () => {
    try { await saveSettingsFields(); await renderSettings(); toast('设置已保存'); }
    catch (e) { toast(e.message, true); }
  };
  // 关于卡片三入口（FEAT-001/002/003）
  $('#btnGroup').onclick = () => showGroupCard();
  $('#btnFeedback').onclick = () => openFeedback();
  $('#btnAnnounce').onclick = () => showAnnouncementHistory();
  // 个人账号管理：改密 + 退出（顶栏整个去掉后，这里是唯一的退出入口）
  const bpw = $('#btnChangePw');
  if (bpw) bpw.onclick = changeOwnPassword;
  const blo = $('#btnLogoutAcct');
  if (blo) blo.onclick = doLogout;
}

/** 退出登录：清服务端会话 + 本地状态，回到落地页。顶栏的退出按钮和设置页共用这一个。 */
async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* 忽略 */ }
  state.user = null; state.vehicles = []; state.plans = []; state.records = []; state.viewRecords = [];
  state.recordsMonth = ''; state.recType = 'all'; state.recPage = 1;
  state.boardMonths = []; state.recordsMonths = []; state.totals = null;
  $('#tabbar').style.display = 'none';
  $('#logoutBtn').style.display = 'none';
  const at = $('#adminTabBtn');
  if (at) at.style.display = 'none';
  const as = $('#adminSideBtn');
  if (as) as.style.display = 'none';
  renderLanding();
}

/**
 * 自己改自己的密码：新旧密码都在本机用同一把盐派生 verifier 再上传，
 * 服务端只做 seal 比对 / 入库，永远接触不到明文。
 */
async function changeOwnPassword() {
  const oldPw = ($('#pwOld') || {}).value || '';
  const p1 = ($('#pwNew') || {}).value || '';
  const p2 = ($('#pwNew2') || {}).value || '';
  if (!oldPw || !p1) return toast('请填写当前密码和新密码', true);
  if (p1.length < 6) return toast('新密码至少 6 位', true);
  if (p1 !== p2) return toast('两次输入的新密码不一致', true);
  const btn = $('#btnChangePw');
  btn.disabled = true;
  try {
    const s = await api('/api/auth/salt', { method: 'POST', body: { email: state.user.email } });
    const oldV = await deriveVerifier(oldPw, s.salt, s.iterations);
    const newV = await deriveVerifier(p1, s.salt, s.iterations);
    await api('/api/account/password', { method: 'POST', body: { old_verifier: oldV, new_verifier: newV } });
    if ($('#pwOld')) $('#pwOld').value = '';
    if ($('#pwNew')) $('#pwNew').value = '';
    if ($('#pwNew2')) $('#pwNew2').value = '';
    toast('密码已修改，其他设备需要重新登录');
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
}

/** 交流群：配了二维码就显示图，配了链接就能跳；两样都没配就直说。 */
function showGroupCard() {
  const about = state.about || {};
  const title = about.group_title || '交流群';
  const qr = about.group_qr || '';
  const url = about.group_url || '';
  if (!qr && !url) {
    toast('管理员还没配置交流群入口', true);
    return;
  }
  return new Promise((resolve) => {
    const wrap = buildModal(
      '<h3 class="modal-title">' + esc(title) + '</h3>' +
      (qr ? '<div style="text-align:center;margin:6px 0 10px">' +
        '<img src="' + esc(qr) + '" alt="' + esc(title) + '二维码" ' +
        'style="width:220px;max-width:80%;border-radius:12px;border:1px solid var(--line)"></div>' : '') +
      (qr ? '<div class="hint" style="text-align:center;margin-bottom:12px">用微信/QQ 扫一扫加入</div>' : '') +
      '<div class="modal-acts">' +
      '<button class="btn" data-act="cancel">关闭</button>' +
      (url ? '<button class="btn primary" data-act="open">打开群链接</button>' : '') +
      '</div>');
    const finish = () => { document.removeEventListener('keydown', onKey); closeModal(wrap); resolve(true); };
    const onKey = (e) => { if (e.key === 'Escape') finish(); };
    wrap.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.act === 'open') { window.open(url, '_blank', 'noopener'); return; }
        finish();
      };
    });
    document.addEventListener('keydown', onKey);
  });
}

/** 问题反馈：外链由管理员在管理台配置，不写死在代码里（FEAT-002）。 */
function openFeedback() {
  const url = (state.about || {}).feedback_url || '';
  if (!url) { toast('管理员还没配置反馈入口', true); return; }
  window.open(url, '_blank', 'noopener');
}

/** 公告弹层：一条一条弹，看完点「我知道了」就记已读，下次登录不再弹（FEAT-003）。 */
function askAnnouncement(a) {
  return new Promise((resolve) => {
    const lvTag = a.level === 'important' ? '重要' : (a.level === 'warn' ? '提醒' : '');
    const wrap = buildModal(
      '<h3 class="modal-title">' + esc(a.title) + '</h3>' +
      '<div class="ann-meta">' + esc(String(a.created_at || '').slice(0, 10)) +
      (lvTag ? ' · ' + lvTag : '') + ' · 产品公告</div>' +
      '<div class="ann-body" style="margin:6px 0 14px">' + esc(a.body) + '</div>' +
      '<div class="modal-acts"><button class="btn primary block" data-act="ok">我知道了</button></div>');
    const finish = () => { document.removeEventListener('keydown', onKey); closeModal(wrap); resolve(true); };
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') finish(); };
    wrap.querySelectorAll('[data-act]').forEach((b) => { b.onclick = finish; });
    document.addEventListener('keydown', onKey);
    const ok = wrap.querySelector('[data-act="ok"]');
    if (ok) ok.focus();
  });
}

/** 登录后弹未读公告。关闭（含 Esc / 点遮罩）就算看过，逐条记已读。 */
async function showPendingAnnouncements() {
  const list = (state.announcements || []).slice();
  if (!list.length) return;
  state.announcements = [];
  for (let i = 0; i < list.length; i++) {
    try { await askAnnouncement(list[i]); } catch (e) { /* 弹层出错不该挡住登录 */ }
    try {
      await api('/api/announcements/read', { method: 'POST', body: { ids: [list[i].id] } });
    } catch (e) { /* 记不上就下次再弹，别报错打扰用户 */ }
  }
  // 设置页的「N 条新」可能正开着，顺手刷一下
  if (state.tab === 'settings' && state.user) renderSettings();
}

/** 历史公告：全部已发布公告，未读带「新」。打开即视为看过，统一记已读。 */
async function showAnnouncementHistory() {
  let list = [];
  try {
    list = (await api('/api/announcements')).announcements || [];
  } catch (e) { toast(e.message, true); return; }
  const unread = list.filter((a) => !a.read);
  const body = list.length
    ? '<div class="ann-list">' + list.map((a) => {
      const lvTag = a.level === 'important' ? ' · 重要' : (a.level === 'warn' ? ' · 提醒' : '');
      return '<div class="ann-item">' +
        '<div class="row between" style="align-items:center;gap:8px">' +
        '<span class="ann-title">' + esc(a.title) + '</span>' +
        (a.read ? '' : '<span class="pill on">新</span>') + '</div>' +
        '<div class="ann-meta">' + esc(String(a.created_at || '').slice(0, 10)) + lvTag + '</div>' +
        '<div class="ann-body">' + esc(a.body) + '</div></div>';
    }).join('') + '</div>'
    : '<div class="empty" style="margin:10px 0 14px">还没有公告</div>';
  const wrap = buildModal(
    '<h3 class="modal-title">产品公告</h3>' + body +
    '<div class="modal-acts"><button class="btn primary block" data-act="ok">关闭</button></div>');
  const finish = () => { document.removeEventListener('keydown', onKey); closeModal(wrap); done(); };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') finish(); };
  const done = async () => {
    if (!unread.length) return;
    try {
      await api('/api/announcements/read', { method: 'POST', body: { ids: unread.map((a) => a.id) } });
      state.announcements = [];
      if (state.tab === 'settings') renderSettings();
    } catch (e) { /* 忽略 */ }
  };
  wrap.querySelectorAll('[data-act]').forEach((b) => { b.onclick = finish; });
  document.addEventListener('keydown', onKey);
  const ok = wrap.querySelector('[data-act="ok"]');
  if (ok) ok.focus();
}

function keyRow(k) {
  return `<div class="row" style="margin-bottom:8px"><input type="text" data-bark value="${esc(k || '')}" placeholder="Bark Key"><button class="btn sm danger" data-delkey="1">删</button></div>`;
}
function bindKeyRows() {
  view().querySelectorAll('[data-delkey]').forEach((b) => {
    b.onclick = () => b.closest('.row').remove();
  });
}

function renderOverrides(ov) {
  const box = $('#overrides');
  const entries = Object.keys(ov || {});
  if (!entries.length) { box.innerHTML = '<div class="muted">还没有自定义项</div>'; return; }
  box.innerHTML = entries.map((code) => {
    const c = state.catalog.find((x) => x.code === code);
    const name = c ? c.name : code;
    return `<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line)">
      <span>${esc(name)}：${ov[code].months ? ov[code].months + ' 个月' : ''}${ov[code].months && ov[code].km ? ' / ' : ''}${ov[code].km ? ov[code].km + ' km' : ''}</span>
      <button class="btn sm danger" data-delov="${esc(code)}">删</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-delov]').forEach((b) => {
    b.onclick = () => {
      const ov2 = state.settings.item_overrides || {};
      delete ov2[b.dataset.delov];
      state.settings.item_overrides = ov2;
      renderOverrides(ov2);
    };
  });
}

async function saveSettingsFields() {
  const keys = Array.from(view().querySelectorAll('[data-bark]')).map((i) => i.value.trim()).filter(Boolean);
  const body = {
    bark_keys: keys,
    bark_server: $('#barkServer').value.trim(),
    bark_group: $('#barkGroup').value.trim(),
    bark_sound: $('#barkSound').value.trim(),
    bark_level: $('#barkLevel').value,
    notify_enabled: $('#notifyEnabled').checked,
    advance_days: parseInt($('#advanceDays').value, 10) || 7,
    advance_km: parseInt($('#advanceKm').value, 10) || 500,
    item_overrides: state.settings.item_overrides || {},
    keep_raw_image: $('#keepImg').checked,
    ai_channel: state._channel || state.settings.ai_channel,
    ai_base_url: $('#aiBase').value.trim(),
    ai_model: $('#aiModel').value.trim(),
  };
  const k = $('#aiKey').value.trim();
  if (k) body.ai_api_key = k;
  await api('/api/settings', { method: 'PUT', body });
}

// ---------------- 管理控制台（只读） ----------------
const BARK_LEVEL_TEXT = { active: '默认', timeSensitive: '时效性通知', passive: '静默通知', critical: '重要警告' };

function barkLevelText(v) { return BARK_LEVEL_TEXT[v] || esc(String(v === null || v === undefined ? '—' : v)); }

/** 开 / 关注册（管理员）。这是影响全站的开关，所以点一下先确认，别手滑关掉。 */
async function adminToggleRegistration(currentlyOpen) {
  const yes = await askConfirm({
    title: currentlyOpen ? '关闭注册' : '开放注册',
    body: currentlyOpen
      ? '关闭后新用户将无法自行注册（已有账号的登录与数据都不受影响）。随时可以再打开。'
      : '开放后，任何知道网址的人都能自行注册账号。',
    okText: currentlyOpen ? '关闭注册' : '开放注册',
    danger: currentlyOpen,
  });
  if (!yes) return;
  try {
    const r = await api('/api/admin/registration', { method: 'POST', body: { open: !currentlyOpen } });
    // 本地也记一下：退出登录后登录页/注册页要用它决定显示注册入口还是「已关闭」
    state.meta = Object.assign({}, state.meta || {}, { registration_open: r.registration_open });
    toast(r.registration_open ? '已开放注册' : '已关闭注册');
    renderAdmin();
  } catch (e) { toast(e.message, true); }
}

// 关于配置 / 公告列表的管理台缓存：只有「关于与公告」这张卡用，改动后置 null 重拉
let admAboutCache = null;
let admAnnCache = null;

/** 保存「关于」卡片的外链。保存后本页立即生效，不用重新登录。 */
async function admAboutSave() {
  const btn = $('#saveAbout');
  const body = {
    feedback_url: $('#cfgFeedback').value.trim(),
    group_title: $('#cfgGroupTitle').value.trim(),
    group_url: $('#cfgGroupUrl').value.trim(),
    group_qr: $('#cfgGroupQr').value.trim(),
  };
  btn.disabled = true;
  try {
    const r = await api('/api/admin/about', { method: 'POST', body });
    state.about = {
      feedback_url: r.feedback_url, group_url: r.group_url,
      group_qr: r.group_qr, group_title: r.group_title,
    };
    admAboutCache = r;
    toast('关于配置已保存');
    await renderAdmin();
  } catch (e) { toast(e.message, true); btn.disabled = false; }
}

/** 新建 / 编辑公告。编辑时可勾「重新通知所有人」清空已读记录。 */
async function admAnnEdit(a, totalUsers) {
  const isNew = !a;
  const fields = [
    { key: 'title', label: '标题', value: a ? a.title : '', placeholder: '例如：数据备份功能已上线' },
    { key: 'body', label: '内容', type: 'textarea', rows: 6, value: a ? a.body : '', placeholder: '写清楚改了什么、用户要注意什么' },
    {
      key: 'level', label: '级别', type: 'select', value: a ? a.level : 'info',
      options: [{ value: 'info', label: '普通' }, { value: 'warn', label: '提醒' }, { value: 'important', label: '重要' }],
    },
  ];
  if (!isNew) fields.push({ key: 'renotify', label: '重新通知所有人（清空已读记录，让每个人下次登录再弹一次）', type: 'checkbox', value: false });
  const f = await askForm({
    title: isNew ? '发布公告' : '编辑公告',
    fields,
    okText: isNew ? '发布' : '保存',
    hint: isNew ? '发布后所有用户下次登录会看到弹窗，每条公告每人只弹一次。' : ('当前已读 ' + (a.read_count || 0) + '/' + totalUsers + ' 人。'),
  });
  if (!f) return;
  try {
    if (isNew) await api('/api/admin/announcements', { method: 'POST', body: { title: f.title, body: f.body, level: f.level, published: true } });
    else await api('/api/admin/announcements/' + a.id, { method: 'PATCH', body: { title: f.title, body: f.body, level: f.level, renotify: !!f.renotify } });
    toast(isNew ? '公告已发布' : '公告已保存');
    admAnnCache = null;
    await renderAdmin();
  } catch (e) { toast(e.message, true); }
}

async function admAnnToggle(id, publish) {
  try {
    await api('/api/admin/announcements/' + id, { method: 'PATCH', body: { published: publish } });
    toast(publish ? '已重新发布' : '已撤回');
    admAnnCache = null;
    await renderAdmin();
  } catch (e) { toast(e.message, true); }
}

async function admAnnDelete(id) {
  const yes = await askConfirm({
    title: '删除公告',
    body: '删除后这条公告以及所有人的已读记录都会消失，不可恢复。只想让用户看不到的话，用「撤回」更稳妥。',
    okText: '删除', danger: true,
  });
  if (!yes) return;
  try {
    await api('/api/admin/announcements/' + id, { method: 'DELETE' });
    toast('已删除');
    admAnnCache = null;
    await renderAdmin();
  } catch (e) { toast(e.message, true); }
}

/** 管理台里的单条公告（含编辑/撤回/删除）。 */
function adminAnnRow(a, totalUsers) {
  const lv = a.level === 'important' ? '重要' : (a.level === 'warn' ? '提醒' : '普通');
  return `<div class="ann-item">
    <div class="row between" style="align-items:center;gap:8px">
      <span class="ann-title">${esc(a.title)}</span>
      <span class="pill ${a.published ? 'on' : ''}">${a.published ? '发布中' : '已撤回'}</span>
    </div>
    <div class="ann-meta">${esc(String(a.created_at || '').slice(0, 10))} · ${lv} · 已读 ${a.read_count || 0}/${totalUsers}</div>
    <div class="ann-body">${esc(a.body)}</div>
    <div class="row wrap" style="gap:8px;margin-top:8px">
      <button class="btn sm" data-annedit="${esc(a.id)}">编辑</button>
      <button class="btn sm" data-anntoggle="${esc(a.id)}" data-on="${a.published ? '1' : '0'}">${a.published ? '撤回' : '重新发布'}</button>
      <button class="btn sm danger" data-anndel="${esc(a.id)}">删除</button>
    </div>
  </div>`;
}

async function renderAdmin() {
  if (!state.user || !state.user.is_admin) {
    view().innerHTML = '<div class="card"><div class="error-box">当前账号不是管理员</div></div>';
    return;
  }
  const seq = renderBegin();
  view().innerHTML = skeletonList(3);
  let data, aboutRes, annRes;
  try {
    data = await api('/api/admin/overview');
    // 关于外链 + 公告列表。缓存住，避免每次刷用户详情都重拉；改动后显式清缓存。
    [aboutRes, annRes] = await Promise.all([
      admAboutCache ? Promise.resolve(admAboutCache) : api('/api/admin/about').catch(() => null),
      admAnnCache ? Promise.resolve(admAnnCache) : api('/api/admin/announcements').catch(() => null),
    ]);
    if (aboutRes) admAboutCache = aboutRes;
    if (annRes) admAnnCache = annRes;
  } catch (e) { if (!renderStale(seq)) view().innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; return; }
  if (renderStale(seq)) return; // 请求回来时 tab 已切走，别覆盖别的页面

  const s = data.summary || {};
  const users = data.users || [];

  let html = `<div class="stats">
    <div class="stat"><span>注册用户</span><b>${s.users || 0}<span class="unit">人</span></b></div>
    <div class="stat"><span>车辆</span><b>${s.vehicles || 0}<span class="unit">辆</span></b></div>
    <div class="stat"><span>保养记录</span><b>${s.records || 0}<span class="unit">笔</span></b></div>
    <div class="stat"><span>累计花费</span><b>${esc(money(s.spend || 0))}</b></div>
  </div>`;

  // 全站开关：注册
  const regOn = data.registration_open !== false;
  html += `<div class="card">
    <div class="row between">
      <span class="muted">注册开关</span>
      <span class="pill ${regOn ? 'on' : ''}">${regOn ? '当前：开放注册' : '当前：已关闭'}</span>
    </div>
    <div class="hint" style="margin-top:8px">关闭后：登录页不再出现注册入口，注册接口也会直接拒绝新账号；已有账号登录、数据都不受影响。库里一个用户都没有时始终允许注册，避免把自己锁在门外。</div>
    <button class="btn ${regOn ? 'danger' : 'primary'} block" id="regToggle" style="margin-top:10px">${regOn ? '关闭注册' : '开放注册'}</button>
  </div>`;

  // 关于卡片的外链配置 + 产品公告（FEAT-001 / FEAT-002 / FEAT-003）
  const about = aboutRes || {};
  const anns = (annRes && annRes.announcements) || [];
  const annUsers = (annRes && annRes.users) || 0;
  const liveAnns = anns.filter((a) => a.published).length;
  html += `<div class="card">
    <div class="row between">
      <span class="muted">关于与公告</span>
      <span class="muted">公告 ${liveAnns}/${anns.length} 条在发</span>
    </div>
    <div class="hint" style="margin:8px 0 10px">用户设置页「关于」卡片里的三个入口都在这儿配。留空 = 用户点的时候会看到「还没配置」。</div>
    <label class="field"><span>问题反馈链接</span><input type="text" id="cfgFeedback" value="${esc(about.feedback_url || '')}" placeholder="https://wj.qq.com/... 用什么表单都行"></label>
    <label class="field"><span>交流群名称</span><input type="text" id="cfgGroupTitle" value="${esc(about.group_title || '交流群')}" placeholder="交流群"></label>
    <label class="field"><span>交流群链接（微信群 / QQ 群邀请链接，可留空）</span><input type="text" id="cfgGroupUrl" value="${esc(about.group_url || '')}" placeholder="https://..."></label>
    <label class="field"><span>交流群二维码图片地址（可留空）</span><input type="text" id="cfgGroupQr" value="${esc(about.group_qr || '')}" placeholder="https://.../qr.png"></label>
    <button class="btn primary block" id="saveAbout">保存关于配置</button>
    <div class="row between" style="margin-top:18px">
      <span class="muted">产品公告 · ${anns.length} 条</span>
      <button class="btn sm primary" id="newAnnounce">＋ 发布公告</button>
    </div>
    <div id="admAnnList" style="margin-top:6px">${anns.length ? anns.map((a) => adminAnnRow(a, annUsers)).join('') : '<div class="muted">还没发过公告</div>'}</div>
    <div class="hint">发新公告后，所有用户下次登录会看到弹窗，每条公告每人只弹一次。撤回的公告用户看不到（已读记录保留）；编辑时勾「重新通知所有人」可以清掉已读记录、让大家都再看一次。</div>
  </div>`;

  html += `<div class="card">
    <div class="row between">
      <span class="muted">全站到期情况</span>
      <span class="muted">已配 Bark ${s.bark_configured || 0}/${s.users || 0}</span>
    </div>
    <div class="row wrap" style="gap:6px;margin-top:10px">
      <span class="pill ${s.overdue ? 'on' : ''}">已到期 ${s.overdue || 0}</span>
      <span class="pill">临期 ${s.soon || 0}</span>
      <span class="pill">计划总数 ${s.plans || 0}</span>
      <span class="pill">管理员 ${s.admins || 0}</span>
      <span class="pill">今天 ${esc(data.today || '')}</span>
    </div>
  </div>`;

  html += `<div class="sec-label">用户 · ${users.length}</div>`;

  if (!users.length) {
    html += '<div class="card"><div class="empty">还没有用户</div></div>';
  } else {
    html += users.map(adminUserCard).join('');
  }

  html += `<div class="sec-label">项目周期表 · 全局</div>`;
  html += `<div class="card">
    <div class="row between">
      <span class="muted">识别归类和计划推算的依据，对所有用户生效</span>
      <button class="btn sm" id="admCatBtn">管理周期表</button>
    </div>
    <div id="admCatalog" style="margin-top:10px"></div>
  </div>`;

  html += `<div class="card"><div class="hint">
    Bark Key 一律打码——拿到原文就等于能往对方手机推任意通知。<br>
    封禁会立刻踢下线并阻止登录；删除用户会连带删掉 TA 的车辆、记录和计划，不可恢复。
  </div></div>`;

  view().innerHTML = html;
  view().querySelectorAll('[data-adm]').forEach((b) => { b.onclick = () => toggleAdminDetail(b.dataset.adm, b); });
  view().querySelectorAll('[data-uact]').forEach((b) => { b.onclick = () => adminUserAction(b.dataset.uact, b.dataset.uid, b.dataset.email); });
  const regBtn = $('#regToggle');
  if (regBtn) regBtn.onclick = () => adminToggleRegistration(data.registration_open !== false);
  // 关于配置 + 公告（FEAT-001~003）
  const saveAboutBtn = $('#saveAbout');
  if (saveAboutBtn) saveAboutBtn.onclick = () => admAboutSave();
  const newAnnBtn = $('#newAnnounce');
  if (newAnnBtn) newAnnBtn.onclick = () => admAnnEdit(null, annUsers);
  view().querySelectorAll('[data-annedit]').forEach((b) => {
    b.onclick = () => admAnnEdit(anns.find((x) => x.id === b.dataset.annedit) || null, annUsers);
  });
  view().querySelectorAll('[data-anntoggle]').forEach((b) => {
    b.onclick = () => admAnnToggle(b.dataset.anntoggle, b.dataset.on !== '1');
  });
  view().querySelectorAll('[data-anndel]').forEach((b) => {
    b.onclick = () => admAnnDelete(b.dataset.anndel);
  });
  const catBtn = $('#admCatBtn');
  if (catBtn) catBtn.onclick = toggleAdminCatalog;
  // 重渲染后周期表区块会被重建；之前是展开状态就恢复内容
  if (admCatOpen) renderAdminCatalog();
}

function adminUserCard(u) {
  const c = u.counts || {};
  const flagged = (c.overdue || 0) + (c.soon || 0) > 0;
  const bark = u.bark || {};
  const ai = u.ai || {};
  const self = state.user && u.id === state.user.id;
  const acts = [];
  if (self) {
    acts.push('<span class="muted" style="font-size:12px;align-self:center">当前登录账号</span>');
  } else {
    acts.push(u.is_admin
      ? `<button class="btn sm" data-uact="demote" data-uid="${u.id}">取消管理员</button>`
      : `<button class="btn sm" data-uact="promote" data-uid="${u.id}">设为管理员</button>`);
    acts.push(u.banned
      ? `<button class="btn sm" data-uact="unban" data-uid="${u.id}">解封</button>`
      : `<button class="btn sm" data-uact="ban" data-uid="${u.id}">封禁</button>`);
    acts.push(`<button class="btn sm" data-uact="reset" data-uid="${u.id}" data-email="${esc(u.email)}">重置密码</button>`);
    acts.push(`<button class="btn sm danger" data-uact="del" data-uid="${u.id}">删除用户</button>`);
  }
  return `<div class="card">
    <div class="row between">
      <div class="grow">
        <div style="font-weight:600;font-size:14px;word-break:break-all">${esc(u.email)}</div>
        <div class="muted" style="font-size:12.5px;margin-top:4px">
          注册 ${ymd(u.created_at)}${u.display_name ? ' · ' + esc(u.display_name) : ''}
          <br>车辆 ${c.vehicles || 0} · 记录 ${c.records || 0} · 计划 ${c.plans || 0}
          ${u.last_record_at ? '<br>最近记录 ' + ymd(u.last_record_at) : ''}
          <br>Bark：${bark.configured ? '已配置 ' + bark.count + ' 个设备（' + esc((bark.masked || []).join('、')) + '）' : '未配置'}
          <br>识别：${esc(ai.channel || '—')}${ai.has_key ? ' · 已存 Key' : ''}
          <br>提前提醒 ${u.advance ? u.advance.days : '—'} 天 / ${u.advance ? u.advance.km : '—'} km
        </div>
      </div>
      <div style="text-align:right;white-space:nowrap">
        <span class="pill ${u.is_admin ? 'on' : ''}">${u.is_admin ? '管理员' : '普通用户'}</span>
        ${u.banned ? '<span class="pill" style="color:var(--danger);border-color:var(--danger)">已封禁</span>' : ''}
        ${flagged ? `<div class="muted" style="font-size:12px;margin-top:6px;color:var(--danger)">到期 ${c.overdue || 0} · 临期 ${c.soon || 0}</div>` : '<div class="muted" style="font-size:12px;margin-top:6px">无到期项</div>'}
        <div class="muted" style="font-size:12px;margin-top:2px">${esc(money(u.spend || 0))}</div>
      </div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn sm" data-adm="${u.id}">查看详情</button>
      ${acts.join('')}
    </div>
    <div id="adm-${u.id}"></div>
  </div>`;
}

// ---------------- 管理台操作（B/C/D） ----------------

function genTempPassword() {
  const cs = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const arr = new Uint8Array(10);
  crypto.getRandomValues(arr);
  return Array.from(arr, (x) => cs[x % cs.length]).join('');
}

async function adminUserAction(act, id, email) {
  if (act === 'reset') return adminResetPassword(id, email);
  if (act === 'ban') {
    if (!await askConfirm({ title: '封禁该用户？', body: '封禁后对方会立刻退出登录，且无法再登录，直到解封。', okText: '封禁' })) return;
  }
  if (act === 'del') {
    if (!await askConfirm({
      title: '删除该用户？',
      body: '将连带删除 TA 的车辆、保养记录、计划、推送配置等全部数据，操作不可恢复。',
      danger: true, okText: '永久删除',
    })) return;
  }
  try {
    const body = (act === 'promote' || act === 'demote' || act === 'ban' || act === 'unban') ? { action: act } : null;
    await api('/api/admin/users/' + id, body ? { method: 'PATCH', body } : { method: 'DELETE' });
    toast(act === 'del' ? '用户已删除' : '操作成功');
    renderAdmin();
  } catch (e) { toast(e.message, true); }
}

/** 重置密码：新密码在管理员浏览器里派生 verifier，服务端只存密封值 */
async function adminResetPassword(id, email) {
  const r = await askForm({
    title: '重置密码',
    body: email,
    fields: [{ key: 'pw', label: '新密码（至少 8 位）', value: genTempPassword() }],
    hint: '已预填一个随机密码，可直接用或改成你好记的。确定后对方的所有登录会立即失效。',
  });
  if (!r) return;
  const pw = String(r.pw || '');
  if (pw.length < 8) { toast('密码至少 8 位', true); return; }
  try {
    // 盐由目标邮箱确定性派生，和对方自己登录时用的是同一份
    const s = await api('/api/auth/salt', { method: 'POST', body: { email } });
    const verifier = await deriveVerifier(pw, s.salt, s.iterations);
    await api('/api/admin/users/' + id, { method: 'PATCH', body: { action: 'reset_password', verifier } });
    toast('密码已重置：' + pw);
  } catch (e) { toast(e.message, true); }
}

/** C：删除用户名下的单条车辆/记录/计划 */
async function adminDeleteDataConfirm(id, kind, xid, label) {
  if (!await askConfirm({ title: '删除这条数据？', body: label, danger: true, okText: '删除' })) return;
  try {
    await api(`/api/admin/users/${id}/${kind}/${xid}`, { method: 'DELETE' });
    toast('已删除');
    // 概览计数和详情一起刷新，并保持该用户详情展开
    await renderAdminKeepDetail(id);
  } catch (e) { toast(e.message, true); }
}

/** 刷新概览但保留指定用户详情展开 */
async function renderAdminKeepDetail(openId) {
  const box = document.getElementById('adm-' + openId);
  const wasOpen = box && box.dataset.loaded === '1';
  await renderAdmin();
  if (wasOpen) {
    const btn = view().querySelector(`[data-adm="${openId}"]`);
    if (btn) toggleAdminDetail(openId, btn);
  }
}

// ---------------- 周期表管理（D） ----------------

let admCatOpen = false;

async function toggleAdminCatalog() {
  admCatOpen = !admCatOpen;
  const box = $('#admCatalog');
  if (!box) return;
  if (!admCatOpen) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="empty">加载中…</div>';
  await renderAdminCatalog();
}

async function renderAdminCatalog() {
  const box = $('#admCatalog');
  if (!box) return;
  let data;
  try { data = await api('/api/admin/catalog'); }
  catch (e) { box.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; return; }
  const list = data.catalog || [];
  let h = '<div class="row between" style="margin-bottom:8px"><span class="muted" style="font-size:12.5px">共 ' + list.length + ' 项（含停用）</span><button class="btn sm" data-cat="new">新增项目</button></div>';
  h += list.map((x) => `<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line)">
    <span style="font-size:12.5px;min-width:0">
      ${x.enabled ? '' : '<span class="muted">[停用] </span>'}<b>${esc(x.name)}</b> <span class="muted">${esc(x.code)}</span>
      <br><span class="muted" style="font-size:12px">${x.interval_months ? x.interval_months + ' 个月' : '—'} / ${x.interval_km ? kmText(x.interval_km) : '—'} · ${esc(x.category || '其他')}</span>
    </span>
    <span class="row" style="gap:6px;white-space:nowrap">
      <button class="btn sm" data-cat="edit" data-code="${esc(x.code)}">编辑</button>
      <button class="btn sm" data-cat="toggle" data-code="${esc(x.code)}" data-en="${x.enabled ? 0 : 1}">${x.enabled ? '停用' : '启用'}</button>
    </span>
  </div>`).join('');
  box.innerHTML = h;
  box.querySelectorAll('[data-cat]').forEach((b) => {
    b.onclick = () => {
      const code = b.dataset.code;
      if (b.dataset.cat === 'new') return adminCatalogEdit(null);
      if (b.dataset.cat === 'edit') {
        const item = list.find((x) => x.code === code);
        return adminCatalogEdit(item);
      }
      adminCatalogToggle(code, b.dataset.en === '1');
    };
  });
}

async function adminCatalogEdit(item) {
  const isNew = !item;
  const r = await askForm({
    title: isNew ? '新增周期表项目' : '编辑：' + (item.name || item.code),
    fields: [
      { key: 'code',     label: '编号（小写字母/数字/下划线）', value: isNew ? '' : item.code, placeholder: '如 brake_clean' },
      { key: 'name',     label: '名称', value: isNew ? '' : item.name },
      { key: 'category', label: '类别', value: isNew ? '' : (item.category || '') },
      { key: 'months',   label: '周期（月，留空不限）', value: item ? (item.interval_months || '') : '', inputmode: 'numeric' },
      { key: 'km',       label: '周期（km，留空不限）', value: item ? (item.interval_km || '') : '', inputmode: 'numeric' },
      { key: 'aliases',  label: '别名（逗号分隔，用于识别归类）', value: isNew ? '' : (item.aliases || '') },
      { key: 'note',     label: '备注', value: isNew ? '' : (item.note || '') },
    ],
    hint: isNew ? '编号确定后不可改。' : '编号不可改，其余都可调整。',
  });
  if (!r) return;
  try {
    const body = {
      name: r.name, category: r.category, aliases: r.aliases, note: r.note,
      interval_months: r.months, interval_km: r.km, enabled: 1,
    };
    if (isNew) body.code = r.code;
    await api('/api/admin/catalog' + (isNew ? '' : '/' + encodeURIComponent(item.code)), { method: isNew ? 'POST' : 'PATCH', body });
    toast('已保存');
    await renderAdminCatalog();
  } catch (e) { toast(e.message, true); }
}

async function adminCatalogToggle(code, enable) {
  try {
    await api('/api/admin/catalog/' + encodeURIComponent(code), { method: enable ? 'POST' : 'DELETE' });
    toast(enable ? '已启用' : '已停用');
    await renderAdminCatalog();
  } catch (e) { toast(e.message, true); }
}


async function toggleAdminDetail(id, btn) {
  const box = document.getElementById('adm-' + id);
  if (!box) return;
  if (box.dataset.loaded === '1') {
    box.innerHTML = '';
    box.dataset.loaded = '';
    btn.textContent = '查看详情';
    return;
  }
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '加载中…';
  try {
    const d = await api('/api/admin/users/' + id);
    box.innerHTML = adminDetailHtml(d);
    box.dataset.loaded = '1';
    btn.textContent = '收起';
    box.querySelectorAll('[data-dact]').forEach((b) => {
      b.onclick = () => adminDeleteDataConfirm(id, b.dataset.dact, b.dataset.xid, b.dataset.label || '');
    });
  } catch (e) {
    toast(e.message, true);
    btn.textContent = old;
  }
  btn.disabled = false;
}

function adminDetailHtml(d) {
  const st = d.settings || {};
  const bark = st.bark || {};
  const ai = st.ai || {};
  let h = '<div style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">';

  h += `<div class="sec-label" style="margin-top:0">设置</div>
    <table>
      <tr><td>Bark 服务器</td><td>${esc(bark.server || '—')}</td></tr>
      <tr><td>Bark Key</td><td>${bark.configured ? esc((bark.masked || []).join('、')) : '未配置'}</td></tr>
      <tr><td>通知分组 / 级别</td><td>${esc(bark.group || '默认')} / ${barkLevelText(bark.level)}</td></tr>
      <tr><td>提示音</td><td>${esc(bark.sound || '默认')}</td></tr>
      <tr><td>到期提醒开关</td><td>${bark.notify_enabled ? '已开启' : '已关闭'}</td></tr>
      <tr><td>提前提醒</td><td>${esc(String(st.advance ? st.advance.days : '—'))} 天 / ${esc(String(st.advance ? st.advance.km : '—'))} km</td></tr>
      <tr><td>识别通道</td><td>${esc(ai.channel || '—')}${ai.model ? ' · ' + esc(ai.model) : ''}</td></tr>
      <tr><td>外部 API Key</td><td>${ai.has_key ? '已配置（不显示原文）' : '未配置'}</td></tr>
      <tr><td>保存截图缩略图</td><td>${st.keep_raw_image ? '开' : '关'}</td></tr>
      <tr><td>自定义周期</td><td>${Object.keys(st.overrides || {}).length ? esc(Object.keys(st.overrides).join('、')) : '无'}</td></tr>
    </table>`;

  if ((d.vehicles || []).length) {
    h += `<div class="sec-label">车辆 · ${d.vehicles.length}</div>`;
    h += d.vehicles.map((v) => {
      const label = [v.nickname, v.brand, v.series, v.plate].filter(Boolean).join(' ') || '未命名';
      return `<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line)">
      <span style="font-size:12.5px;min-width:0">${esc(label)}</span>
      <span class="row" style="gap:8px;white-space:nowrap"><span class="muted" style="font-size:12px;align-self:center">${v.current_km ? kmText(v.current_km) : '里程未填'}</span>
        <button class="btn sm danger" data-dact="vehicles" data-xid="${v.id}" data-label="车辆：${esc(label)}（连带其记录与计划）">删</button></span>
    </div>`;
    }).join('');
  }

  if ((d.plans || []).length) {
    h += `<div class="sec-label">保养计划 · ${d.plans.length}</div>`;
    h += d.plans.map((p) => `<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line)">
      <span style="font-size:12.5px;min-width:0">${esc(p.item_name)}</span>
      <span class="row" style="gap:8px;white-space:nowrap"><span class="muted" style="font-size:12px;align-self:center">${esc(LEVEL_TEXT[p.level] || p.level)} · ${ymd(p.next_due_at) || '—'}</span>
        <button class="btn sm danger" data-dact="plans" data-xid="${p.id}" data-label="计划：${esc(p.item_name)}">删</button></span>
    </div>`).join('');
  }

  if ((d.records || []).length) {
    h += `<div class="sec-label">保养记录 · ${d.records.length}</div>`;
    h += d.records.map((r) => {
      const label = (r.shop || '未知门店') + ' · ' + ymd(r.order_time || r.created_at);
      return `<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line)">
      <span style="font-size:12.5px;min-width:0">${esc(r.shop || '未知门店')} · ${(r.items || []).length} 项</span>
      <span class="row" style="gap:8px;white-space:nowrap"><span class="muted" style="font-size:12px;align-self:center">${ymd(r.order_time || r.created_at)} · ${esc(money(r.total_amount))}</span>
        <button class="btn sm danger" data-dact="records" data-xid="${r.id}" data-label="记录：${esc(label)}（连带其明细与计划）">删</button></span>
    </div>`;
    }).join('');
  }

  h += '</div>';
  return h;
}

// ---------------- 启动 ----------------
async function bootAfterLogin() {
  document.body.classList.remove('is-auth');
  document.body.classList.remove('is-landing');
  $('#tabbar').style.display = '';
  $('#logoutBtn').style.display = '';
  // 管理员入口只对管理员出现；接口层也各自校验，不只靠这里藏。
  // 底部 Tab 与侧边栏两套都要同步。
  const at = $('#adminTabBtn');
  if (at) at.style.display = (state.user && state.user.is_admin) ? '' : 'none';
  const as = $('#adminSideBtn');
  if (as) as.style.display = (state.user && state.user.is_admin) ? '' : 'none';
  state.tab = 'board';
  state.bootFresh = false;
  // meta 只给设置页展示 AI 通道，不阻塞首屏（BUG-019）
  api('/api/meta').then((m) => { state.meta = m; }).catch(() => {});
  // 首屏一次拿齐：车辆 + 计划 + 记录 + 设置 + 周期表（原来是 4 次串行往返）
  view().innerHTML = skeletonBoard();
  try {
    const b = await api('/api/bootstrap');
    state.vehicles = b.vehicles || [];
    state.currentVehicleId = b.current_vehicle_id || (state.vehicles[0] && state.vehicles[0].id) || null;
    state.plans = b.plans || [];
    state.today = b.today;
    state.records = b.records || [];
    state.viewRecords = []; // 记录页的列表，进记录页时自己拉
    // 记录页筛选态回到默认：全部类型 + 全部月份 + 第 1 页（FEAT-005）
    state.recordsMonth = ''; state.recType = 'all'; state.recPage = 1;
    state.totals = b.totals || null;
    state.boardMonths = b.months || []; // 看板专用，不被记录页覆写（BUG-025）
    state.recordsMonths = b.months || [];
    state.settings = b.settings || null;
    state.catalog = b.catalog || [];
    state.about = b.about || {};
    state.announcements = b.announcements || []; // 未读公告：登录后弹一次（FEAT-003）
    state.bootFresh = true;
  } catch (e) {
    // 拿不到就退回老办法：各页面进入时自己加载
  }
  setTab('board');
  // 登录后弹未读公告。不等它，别让弹窗挡住首屏渲染。
  if ((state.announcements || []).length) showPendingAnnouncements();
}

async function boot() {
  state.upTarget = 'record';
  state.authPage = 'login';
  bindChrome();
  try {
    const me = await api('/api/me');
    state.user = me.user;
    await bootAfterLogin();
  } catch (e) {
    state.user = null;
    // 未登录也要知道注册开没开：登录页/注册页靠它决定显示「注册账号」还是「已关闭注册」。
    // 这一步放在 /api/me 失败之后，已登录用户不会多花这次请求。
    try { state.meta = await api('/api/meta'); } catch (x) { /* 取不到就按默认（开放）走 */ }
    // 没登录先看落地页，点登录才进登录页
    renderLanding();
  }
}

/** 注册是否开放。meta 还没拿到时默认按开放处理，避免把正常用户挡在门外。 */
function regOpen() {
  return !state.meta || state.meta.registration_open !== false;
}

function bindChrome() {
  // #view 是常驻容器，这里挂一次就够，之后所有重新渲染出的车牌框都会生效
  bindPlateInput(view());
  $('#tabbar').querySelectorAll('button').forEach((b) => {
    b.onclick = () => setTab(b.dataset.tab);
  });
  $('#sidebar').querySelectorAll('button').forEach((b) => {
    b.onclick = () => setTab(b.dataset.tab);
  });
  $('#logoutBtn').onclick = doLogout;
}

boot();
