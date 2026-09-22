// API 路由
import {
  json, fail, getSalt, register, login, logout, getSettings, clearCookie,
} from './auth.js';
import { uuid, encryptText, decryptText, sealVerifier, decoySalt, timingSafeEqual } from './crypto.js';
import { recognize, DEFAULT_WORKERS_AI_MODEL } from './ai.js';
import { buildPlansFromRecord, evaluatePlan, scanUser, sendBark, parseBarkKeys, addMonths, todayStr } from './plans.js';
import { getCatalog, clearCatalogCache } from './catalog.js';

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_THUMB_CHARS = 60000;

function str(v, max = 200) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n : null;
}

function numOrNull(v) { return num(v); }

function intOrNull(v) {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

function nowIso() { return new Date().toISOString(); }

async function readJson(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

async function loadSettingsWithKey(env, userId) {
  const s = await getSettings(env, userId);
  const key = await decryptText(env.APP_SECRET, s.ai_api_key_enc);
  return { ...s, _aiApiKey: key || null };
}

function publicSettings(s) {
  return {
    bark_keys: parseBarkKeys(s),
    bark_server: s.bark_server,
    bark_group: s.bark_group,
    bark_sound: s.bark_sound,
    bark_level: s.bark_level,
    advance_days: s.advance_days,
    advance_km: s.advance_km,
    item_overrides: safeParse(s.item_overrides, {}),
    notify_enabled: !!s.notify_enabled,
    timezone_offset: s.timezone_offset,
    ai_channel: s.ai_channel,
    ai_model: s.ai_model,
    ai_base_url: s.ai_base_url,
    has_ai_key: !!s.ai_api_key_enc,
    keep_raw_image: !!s.keep_raw_image,
    default_workers_ai_model: DEFAULT_WORKERS_AI_MODEL,
  };
}

function safeParse(s, dflt) {
  try { return JSON.parse(s); } catch (e) { return dflt; }
}

// ---------------- 全站开关（管理员控制） ----------------
// 用 app_config 这张 key/value 表，以后再加开关不必改表结构。
const CONF_REG_OPEN = 'registration_open';

async function getAppConfig(env, key, dflt) {
  // 读不到（表还没建、语句出错）也不能让整站崩，一律回退默认值
  try {
    const r = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?1').bind(key).first();
    return r ? String(r.value) : dflt;
  } catch (e) { return dflt; }
}

async function setAppConfig(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, String(value), nowIso()).run();
}

async function registrationOpen(env) {
  return (await getAppConfig(env, CONF_REG_OPEN, '1')) !== '0';
}

/** 库里一个用户都没有 = 全新部署。这时必须放行注册，
 *  否则管理员一旦关掉注册又把账号删光，谁都进不来了。 */
async function userCountIsZero(env) {
  try {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    return !Number((r && r.n) || 0);
  } catch (e) { return false; }
}

// ---------------- 认证 ----------------

async function handleSalt(env, request) {
  const b = await readJson(request);
  const email = str(b.email, 120);
  if (!email) return fail('请填写邮箱');
  const r = await getSalt(env, email);
  return json({ ok: true, ...r });
}

async function handleRegister(env, request) {
  const b = await readJson(request);
  // 管理员关掉注册后，前端藏掉入口只是"顺手"，真正拦住的是这里
  if (!(await registrationOpen(env)) && !(await userCountIsZero(env))) {
    return fail('本站已关闭注册，如需账号请联系管理员', 403);
  }
  const r = await register(env, {
    email: b.email, display_name: b.display_name, verifier: str(b.verifier, 200),
  });
  if (r.error) return fail(r.error);
  const l = await login(env, { email: b.email, verifier: b.verifier, userAgent: request.headers.get('user-agent') });
  if (l.error) return fail(l.error);
  return json({ ok: true, user: l.user }, 200, { 'set-cookie': l.cookie });
}

async function handleLogin(env, request) {
  const b = await readJson(request);
  const l = await login(env, {
    email: b.email, verifier: str(b.verifier, 200), userAgent: request.headers.get('user-agent'),
  });
  if (l.error) return fail(l.error, 401);
  return json({ ok: true, user: l.user }, 200, { 'set-cookie': l.cookie });
}

async function handleLogout(env, request, user) {
  await logout(env, user.token);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}

/**
 * 自己改自己的密码（设置页「个人账号管理」）。
 * 与登录/管理员重置同一套约定：verifier 由浏览器用本邮箱的盐跑 PBKDF2 派生，
 * 服务端只做一次 SHA-256（seal）——旧密码校验也是 seal 后比对，不跑 PBKDF2（10ms CPU 上限）。
 * 改成功后其他设备的会话全部作废，当前会话保留（不然改完自己就被踢出去了）。
 */
async function changePassword(env, user, body) {
  const oldV = String(body.old_verifier || '');
  const newV = String(body.new_verifier || '');
  if (!/^[0-9a-f]{64}$/.test(oldV) || !/^[0-9a-f]{64}$/.test(newV)) return fail('密码校验值不合法');
  if (oldV === newV) return fail('新密码不能和当前密码一样');
  const cur = await env.DB.prepare('SELECT email, pass_hash FROM users WHERE id = ?1').bind(user.id).first();
  if (!cur) return fail('账号不存在', 404);
  const sealedOld = await sealVerifier(oldV, env.APP_SECRET);
  if (!timingSafeEqual(sealedOld, cur.pass_hash)) return fail('当前密码不正确');
  const salt = await decoySalt(cur.email, env.APP_SECRET);
  const sealedNew = await sealVerifier(newV, env.APP_SECRET);
  await env.DB.prepare(
    'UPDATE users SET pass_hash = ?1, pass_salt = ?2, iterations = 210000 WHERE id = ?3'
  ).bind(sealedNew, salt, user.id).run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1 AND token != ?2').bind(user.id, user.token).run();
  return json({ ok: true });
}

// ---------------- 车辆 ----------------

async function listVehicles(env, user) {
  const r = await env.DB.prepare(
    `SELECT v.*, (SELECT COUNT(*) FROM plans p WHERE p.vehicle_id = v.id AND p.status='active') AS plan_count
       FROM vehicles v WHERE v.user_id = ?1 ORDER BY v.created_at DESC`
  ).bind(user.id).all();
  return json({ ok: true, vehicles: r.results || [] });
}

async function saveVehicle(env, user, body, id) {
  const now = nowIso();
  const fc = numOrNull(body.fuel_consumption);
  if (fc !== null && (fc < 1 || fc > 30)) return fail('油耗请填 1-30 之间的数值（L/100km）');
  if (id) {
    // 部分更新：只覆盖请求里明确带的字段，没带的保留原值。
    // 否则「只更新里程/油耗」这类 PATCH 会把品牌、车牌等全洗成空。
    const cur = await env.DB.prepare('SELECT * FROM vehicles WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
    if (!cur) return fail('车辆不存在', 404);
    const pick = (key, cast) => (body[key] === undefined ? cur[key] : cast(body[key]));
    const f = {
      nickname: pick('nickname', (x) => str(x, 40)),
      brand: pick('brand', (x) => str(x, 40)),
      series: pick('series', (x) => str(x, 60)),
      model_year: pick('model_year', (x) => str(x, 20)),
      plate: pick('plate', (x) => str(x, 16)),
      vin: pick('vin', (x) => str(x, 20)),
      purchase_date: pick('purchase_date', (x) => str(x, 10)),
      current_km: pick('current_km', intOrNull),
      fuel_consumption: pick('fuel_consumption', numOrNull),
    };
    if (f.fuel_consumption !== null && (f.fuel_consumption < 1 || f.fuel_consumption > 30)) {
      return fail('油耗请填 1-30 之间的数值（L/100km）');
    }
    const kmAt = (body.current_km === undefined) ? cur.km_updated_at : (f.current_km ? now : null);
    await env.DB.prepare(
      `UPDATE vehicles SET nickname=?1, brand=?2, series=?3, model_year=?4, plate=?5, vin=?6,
              purchase_date=?7, current_km=?8, fuel_consumption=?9, km_updated_at=?10, updated_at=?11
        WHERE id=?12 AND user_id=?13`
    ).bind(f.nickname, f.brand, f.series, f.model_year, f.plate, f.vin, f.purchase_date,
      f.current_km, f.fuel_consumption, kmAt, now, id, user.id).run();
    return json({ ok: true, id });
  }
  const f = {
    nickname: str(body.nickname, 40), brand: str(body.brand, 40), series: str(body.series, 60),
    model_year: str(body.model_year, 20), plate: str(body.plate, 16), vin: str(body.vin, 20),
    purchase_date: str(body.purchase_date, 10), current_km: intOrNull(body.current_km),
    fuel_consumption: fc,
  };
  const vid = uuid();
  await env.DB.prepare(
    `INSERT INTO vehicles (id, user_id, nickname, brand, series, model_year, plate, vin, purchase_date,
                           current_km, fuel_consumption, km_updated_at, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)`
  ).bind(vid, user.id, f.nickname, f.brand, f.series, f.model_year, f.plate, f.vin,
    f.purchase_date, f.current_km, f.fuel_consumption, f.current_km ? now : null, now).run();
  return json({ ok: true, id: vid });
}

async function deleteVehicle(env, user, id) {
  await env.DB.prepare('DELETE FROM record_items WHERE user_id = ?1 AND record_id IN (SELECT id FROM records WHERE vehicle_id = ?2)').bind(user.id, id).run();
  await env.DB.prepare('DELETE FROM records WHERE user_id = ?1 AND vehicle_id = ?2').bind(user.id, id).run();
  await env.DB.prepare('DELETE FROM plans WHERE user_id = ?1 AND vehicle_id = ?2').bind(user.id, id).run();
  await env.DB.prepare('DELETE FROM vehicles WHERE user_id = ?1 AND id = ?2').bind(user.id, id).run();
  return json({ ok: true });
}

// ---------------- 保养记录 / 明细 ----------------

// 可选筛选 / 分页参数（FEAT-005）：
//   vehicle_id  按车辆
//   month=YYYY-MM  月份筛选，不传 = 全部月份（记录页默认）
//   type=fuel|beauty|maintenance  类型筛选，不传 = 全部（记录页顶部筛选条）
//   page / page_size  分页。**只有显式带 page 才分页**：看板调 /api/records 不带 page，
//   仍旧一次拿最多 200 条（行为完全不变），记录页则带 page 走服务端分页。
async function listRecords(env, user, url) {
  const vid = url.searchParams.get('vehicle_id');
  const month = url.searchParams.get('month');
  const hasMonth = /^\d{4}-\d{2}$/.test(String(month || ''));
  const type = String(url.searchParams.get('type') || '');
  const hasType = ['fuel', 'beauty', 'maintenance'].indexOf(type) >= 0;
  const pageRaw = url.searchParams.get('page');
  const paged = pageRaw !== null && pageRaw !== '';
  const pageSize = Math.min(Math.max(parseInt(url.searchParams.get('page_size') || '5', 10) || 5, 1), 50);

  // 条件与绑定值一起按顺序编号（push 里用 args.length 生成占位符），
  // 从根上避免「SQL 写了 ?3 却只 bind 两个值」这类错位（tools/check-sql-bindings.py 可静态体检）。
  const args = [user.id];
  const conds = [];
  const push = (frag, val) => { args.push(val); conds.push(frag.replace('?', '?' + args.length)); };
  if (vid) push('r.vehicle_id = ?', vid);
  if (hasMonth) push('substr(COALESCE(r.order_time, r.created_at), 1, 7) = ?', month);
  if (hasType) push('r.kind = ?', type);
  const whereSql = conds.length ? ' AND ' + conds.join(' AND ') : '';

  // 先算总量：分页页码要靠它夹紧——否则删掉最后一页唯一一条后，会停在一个空页上。
  const cntRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(r.total_amount), 0) AS amt FROM records r WHERE r.user_id = ?1${whereSql}`
  ).bind(...args).first();
  const total = Number((cntRow && cntRow.n) || 0);
  const filteredAmount = Number((cntRow && cntRow.amt) || 0);
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(Math.max(parseInt(pageRaw || '1', 10) || 1, 1), pages);

  // BUG-023：账本按「添加日期」倒序，最新记的一笔在最前面。
  // 注意 order_time 是单据日期（补录的旧单据可能是几个月前），拿它排序会让人找不到刚记的那笔。
  // 类型优先排序只在「看板那次不带 month / 不带 page 的旧调用」里保留。
  const orderSql = (hasMonth || paged)
    ? 'ORDER BY r.created_at DESC, COALESCE(r.order_time, r.created_at) DESC'
    : `ORDER BY CASE r.kind WHEN 'fuel' THEN 0 WHEN 'beauty' THEN 1 ELSE 2 END,
       COALESCE(r.order_time, r.created_at) DESC`;
  const limitSql = paged ? `LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}` : 'LIMIT 200';
  const rows = (await env.DB.prepare(
    `SELECT * FROM records r WHERE r.user_id = ?1${whereSql} ${orderSql} ${limitSql}`
  ).bind(...args).all()).results || [];
  const ids = rows.map((r) => r.id);
  let items = [];
  if (ids.length) {
    const ph = ids.map((_, i) => `?${i + 2}`).join(',');
    items = (await env.DB.prepare(
      `SELECT * FROM record_items WHERE user_id = ?1 AND record_id IN (${ph})`
    ).bind(user.id, ...ids).all()).results || [];
  }
  const byRecord = {};
  for (const it of items) (byRecord[it.record_id] = byRecord[it.record_id] || []).push(it);

  // 累计口径与列表同范围（当前车辆或全部车辆），全时段，用于看板分项统计
  const sumSql = `
    SELECT
      COALESCE(SUM(CASE WHEN kind = 'fuel'   THEN total_amount END), 0) AS fuel_amount,
      COALESCE(SUM(CASE WHEN kind = 'fuel'   THEN liters END), 0)       AS fuel_liters,
      COALESCE(SUM(CASE WHEN kind = 'beauty' THEN total_amount END), 0) AS beauty_amount,
      COALESCE(SUM(CASE WHEN kind = 'maintenance' THEN total_amount END), 0) AS maint_amount,
      COUNT(*) AS n
    FROM records WHERE user_id = ?1 ${vid ? 'AND vehicle_id = ?2' : ''}`;
  const sumRow = vid
    ? await env.DB.prepare(sumSql).bind(user.id, vid).first()
    : await env.DB.prepare(sumSql).bind(user.id).first();

  // 有记录的月份（含笔数与金额小计），记录页选月浮层用。
  // 跟着类型筛选走、但不加月份条件（它本身就是月份导航）：
  // 「9月 3笔」点进去必须真的是 3 条，不能筛了保养之后还显示加油的笔数。
  const monArgs = [user.id];
  const monConds = [];
  if (vid) { monArgs.push(vid); monConds.push('vehicle_id = ?' + monArgs.length); }
  if (hasType) { monArgs.push(type); monConds.push('kind = ?' + monArgs.length); }
  const monSql = `
    SELECT substr(COALESCE(order_time, created_at), 1, 7) AS m,
           COUNT(*) AS n,
           COALESCE(SUM(total_amount), 0) AS amt
      FROM records WHERE user_id = ?1${monConds.length ? ' AND ' + monConds.join(' AND ') : ''}
     GROUP BY m ORDER BY m DESC`;
  const monRows = (await env.DB.prepare(monSql).bind(...monArgs).all()).results || [];

  return json({
    ok: true,
    records: rows.map((r) => ({ ...r, raw_json: undefined, items: byRecord[r.id] || [] })),
    months: monRows.map((m) => ({ m: m.m, n: Number(m.n), amount: Number(m.amt) })),
    // 分页信息：total 是「当前筛选范围内」的总条数，不是全库条数
    page,
    page_size: pageSize,
    pages,
    total,
    total_amount: filteredAmount,
    totals: {
      fuel_amount: Number((sumRow && sumRow.fuel_amount) || 0),
      fuel_liters: Math.round(Number((sumRow && sumRow.fuel_liters) || 0) * 100) / 100,
      beauty_amount: Number((sumRow && sumRow.beauty_amount) || 0),
      maintenance_amount: Number((sumRow && sumRow.maint_amount) || 0),
      count: Number((sumRow && sumRow.n) || 0),
    },
  });
}

async function deleteRecord(env, user, id) {
  await env.DB.prepare('DELETE FROM record_items WHERE record_id = ?1 AND user_id = ?2').bind(id, user.id).run();
  await env.DB.prepare("DELETE FROM plans WHERE source_record_id = ?1 AND user_id = ?2").bind(id, user.id).run();
  await env.DB.prepare('DELETE FROM records WHERE id = ?1 AND user_id = ?2').bind(id, user.id).run();
  return json({ ok: true });
}

// ---------------- 手动记一笔（加油 / 汽车美容 / 保养） ----------------

/**
 * 加油：金额 + 油价(或直接给升数) → 升数；按车辆油耗预估这箱油能跑的公里数。
 *
 * 里程联动用「加满才结算」模型（full-to-full）：
 *  - 第一条加油（或上一条是加满但没填油耗）→ 只作基准，不结算，不动里程；
 *  - 本次勾了「没加满」→ 不结算，这次的升数累积到下次加满时一起算；
 *  - 本次是加满 → 自上次加满以来（含本次）的升数之和，就是这段时间烧掉的油，
 *    据此预估总共跑了多少公里，累加进车辆 current_km。
 * 这样半箱油就加的情况不会把里程估高。
 *
 * 美容：洗车/打蜡等，只记账与计入年消费，不生成保养计划。
 * 保养：手动补录项目（机油、空滤…），会像截图识别一样生成/顺延保养计划。
 */
async function createManualRecord(env, user, body) {
  const kind = str(body.kind, 20);
  const amount = numOrNull(body.amount);
  if (amount === null || amount <= 0) return fail('请填写金额');
  const shop = str(body.shop, 60);
  const orderTime = /^\d{4}-\d{2}-\d{2}$/.test(String(body.order_time || '')) ? body.order_time : nowIso();
  const rid = uuid();
  const now = nowIso();

  if (kind === 'fuel') {
    const vid = str(body.vehicle_id, 60);
    const veh = vid ? await env.DB.prepare(
      'SELECT id, current_km, fuel_consumption FROM vehicles WHERE id = ?1 AND user_id = ?2'
    ).bind(vid, user.id).first() : null;
    if (!veh) return fail('请先选择车辆');

    const unitPrice = numOrNull(body.unit_price);
    let liters = numOrNull(body.liters);
    if (liters === null && unitPrice !== null && unitPrice > 0) liters = Math.round((amount / unitPrice) * 100) / 100;
    if (liters === null || liters <= 0) return fail('请填写油价（或直接填升数）');
    if (unitPrice !== null && (unitPrice <= 0 || unitPrice > 50)) return fail('油价看起来不对，请检查');

    // BUG-016：不再用「满-满」反推油耗，也不再问「这次没加满」——
    // 直接用车辆里设置的固定油耗估算本笔油能跑多少公里，并累加进车辆总里程。
    const fc = veh.fuel_consumption;
    let estKm = null;
    let kmAdded = 0;
    if (fc && fc > 0) {
      estKm = Math.round((liters / fc) * 100);
      const base = Number(veh.current_km) || 0;
      await env.DB.prepare(
        'UPDATE vehicles SET current_km = ?1, km_updated_at = ?2, updated_at = ?2 WHERE id = ?3 AND user_id = ?4'
      ).bind(base + estKm, now, vid, user.id).run();
      kmAdded = estKm;
    }

    await env.DB.prepare(
      `INSERT INTO records (id, user_id, vehicle_id, kind, shop, order_time, total_amount,
                            unit_price, liters, est_km, partial, created_at)
       VALUES (?1,?2,?3,'fuel',?4,?5,?6,?7,?8,?9,0,?10)`
    ).bind(rid, user.id, vid, shop, orderTime, amount, unitPrice, liters, estKm, now).run();

    return json({ ok: true, id: rid, liters, est_km: estKm, km_added: kmAdded });
  }

  if (kind === 'beauty') {
    const vid = str(body.vehicle_id, 60);
    if (vid) {
      const own = await env.DB.prepare('SELECT id FROM vehicles WHERE id = ?1 AND user_id = ?2').bind(vid, user.id).first();
      if (!own) return fail('车辆不存在', 404);
    }
    const itemName = str(body.item_name, 40) || '洗车';
    await env.DB.prepare(
      `INSERT INTO records (id, user_id, vehicle_id, kind, shop, order_time, total_amount, created_at)
       VALUES (?1,?2,?3,'beauty',?4,?5,?6,?7)`
    ).bind(rid, user.id, vid, shop, orderTime, amount, now).run();
    await env.DB.prepare(
      `INSERT INTO record_items (id, record_id, user_id, item_name, amount)
       VALUES (?1,?2,?3,?4,?5)`
    ).bind(uuid(), rid, user.id, itemName, amount).run();
    return json({ ok: true, id: rid });
  }

  // 手动补录保养：和截图识别走同一套「记录 → 生成/顺延计划」逻辑
  if (kind === 'maintenance') {
    const vid = str(body.vehicle_id, 60);
    if (vid) {
      const own = await env.DB.prepare('SELECT id FROM vehicles WHERE id = ?1 AND user_id = ?2').bind(vid, user.id).first();
      if (!own) return fail('车辆不存在', 404);
    }
    const itemName = str(body.item_name, 40);
    if (!itemName) return fail('请填写保养项目');
    const mileageKm = intOrNull(body.mileage_km);
    const warrantyUntil = /^\d{4}-\d{2}-\d{2}$/.test(String(body.warranty_until || '')) ? body.warranty_until : null;
    const spec = str(body.spec, 60);

    await env.DB.prepare(
      `INSERT INTO records (id, user_id, vehicle_id, kind, shop, order_time, total_amount, mileage_km, created_at)
       VALUES (?1,?2,?3,'maintenance',?4,?5,?6,?7,?8)`
    ).bind(rid, user.id, vid, shop, orderTime, amount, mileageKm, now).run();
    const items = [{ item_name: itemName, spec, qty: 1, amount, warranty_until: warrantyUntil }];
    await env.DB.prepare(
      `INSERT INTO record_items (id, record_id, user_id, item_name, spec, qty, amount, warranty_until)
       VALUES (?1,?2,?3,?4,?5,1,?6,?7)`
    ).bind(uuid(), rid, user.id, itemName, spec, amount, warrantyUntil).run();

    let plans = [];
    try {
      plans = await buildPlansFromRecord(env, user.id, {
        id: rid, vehicle_id: vid, order_time: orderTime, mileage_km: mileageKm,
      }, items);
    } catch (e) { plans = []; }
    return json({ ok: true, id: rid, plans: plans.length });
  }

  return fail('不支持的手动记录类型：' + kind);
}

// ---------------- 保养计划 ----------------

async function listPlans(env, user, url) {
  const vid = url.searchParams.get('vehicle_id');
  const settings = await getSettings(env, user.id);
  const tz = settings.timezone_offset || 8;
  const today = todayStr(tz);
  const sql = vid
    ? `SELECT p.*, v.current_km, v.nickname, v.plate, v.brand, v.series FROM plans p
         LEFT JOIN vehicles v ON v.id = p.vehicle_id
        WHERE p.user_id = ?1 AND p.vehicle_id = ?2 ORDER BY p.next_due_at IS NULL, p.next_due_at ASC`
    : `SELECT p.*, v.current_km, v.nickname, v.plate, v.brand, v.series FROM plans p
         LEFT JOIN vehicles v ON v.id = p.vehicle_id
        WHERE p.user_id = ?1 ORDER BY p.next_due_at IS NULL, p.next_due_at ASC`;
  const stmt = vid ? env.DB.prepare(sql).bind(user.id, vid) : env.DB.prepare(sql).bind(user.id);
  const rows = (await stmt.all()).results || [];
  const plans = rows.map((p) => ({
    ...p,
    ...evaluatePlan(p, { today, advanceDays: settings.advance_days || 7, currentKm: p.current_km, advanceKm: settings.advance_km || 500 }),
  }));
  const rank = { overdue: 0, soon: 1, ok: 2, unknown: 3 };
  plans.sort((a, b) => (rank[a.level] - rank[b.level]) || String(a.next_due_at || '9999').localeCompare(String(b.next_due_at || '9999')));
  return json({ ok: true, today, plans });
}

async function updatePlan(env, user, id, body) {
  const p = await env.DB.prepare('SELECT * FROM plans WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!p) return fail('计划不存在', 404);

  if (body.action === 'done') {
    const today = todayStr(8);
    const km = intOrNull(body.current_km);
    if (km !== null && p.vehicle_id) {
      await env.DB.prepare('UPDATE vehicles SET current_km = ?1, km_updated_at = ?2, updated_at = ?2 WHERE id = ?3 AND user_id = ?4')
        .bind(km, nowIso(), p.vehicle_id, user.id).run();
    }
    const months = intOrNull(body.interval_months) || p.interval_months;
    const kms = intOrNull(body.interval_km) || p.interval_km;
    const nextAt = months ? addMonths(today, months) : null;
    const baseKm = km !== null ? km : (p.last_km || null);
    const nextKm = (kms && baseKm) ? baseKm + Number(kms) : null;
    await env.DB.prepare(
      `UPDATE plans SET last_done_at=?1, last_km=?2, interval_months=?3, interval_km=?4,
              next_due_at=?5, next_due_km=?6, basis='manual', updated_at=?7 WHERE id=?8`
    ).bind(today, baseKm, months || null, kms || null, nextAt, nextKm, nowIso(), id).run();
    return json({ ok: true, next_due_at: nextAt, next_due_km: nextKm });
  }

  const fields = [];
  const vals = [];
  const setIf = (col, val) => { if (val !== undefined) { fields.push(`${col}=?${fields.length + 1}`); vals.push(val); } };
  setIf('next_due_at', body.next_due_at === undefined ? undefined : str(body.next_due_at, 10));
  setIf('next_due_km', body.next_due_km === undefined ? undefined : intOrNull(body.next_due_km));
  setIf('interval_months', body.interval_months === undefined ? undefined : intOrNull(body.interval_months));
  setIf('interval_km', body.interval_km === undefined ? undefined : intOrNull(body.interval_km));
  setIf('status', body.status === undefined ? undefined : str(body.status, 12));
  setIf('note', body.note === undefined ? undefined : str(body.note, 200));
  setIf('item_name', body.item_name === undefined ? undefined : str(body.item_name, 80));
  if (!fields.length) return json({ ok: true });
  fields.push(`updated_at=?${fields.length + 1}`);
  vals.push(nowIso());
  vals.push(id); vals.push(user.id);
  await env.DB.prepare(
    `UPDATE plans SET ${fields.join(',')} WHERE id=?${vals.length - 1} AND user_id=?${vals.length}`
  ).bind(...vals).run();
  return json({ ok: true });
}

// ---------------- 上传与识别 ----------------

async function handleUpload(env, ctx, user, request) {
  const form = await request.formData();
  const file = form.get('image');
  const target = str(form.get('target'), 20) || 'record';
  const vehicleId = str(form.get('vehicle_id'), 60);
  if (!file || typeof file === 'string') return fail('没有收到图片');
  const mime = file.type || 'image/jpeg';
  if (!/^image\//.test(mime)) return fail('只支持图片文件');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) return fail('图片太大，请压缩后再试（建议小于 5MB）');
  if (bytes.byteLength < 200) return fail('图片内容为空');

  const settings = await loadSettingsWithKey(env, user.id);
  const result = await recognize(env, settings, { bytes, mime, target });

  const thumb = str(form.get('thumb'), MAX_THUMB_CHARS);
  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO pending_uploads (id, user_id, vehicle_id, target, ai_channel, ai_model, image_mime,
                                  image_thumb, ai_raw, parsed_json, error, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
  ).bind(
    id, user.id, vehicleId || null, target, result.channel, result.model, mime,
    settings.keep_raw_image ? thumb : null,
    String(result.text || '').slice(0, 4000),
    JSON.stringify(result.parsed || {}),
    result.error, nowIso()
  ).run();

  return json({
    ok: !result.error,
    upload_id: id,
    channel: result.channel,
    model: result.model,
    fell_back: result.fellBack,
    error: result.error,
    parsed: result.parsed,
    needs_review: true,
  });
}

async function confirmUpload(env, user, id, body) {
  const pu = await env.DB.prepare('SELECT * FROM pending_uploads WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!pu) return fail('识别结果不存在或已过期', 404);
  const parsed = safeParse(pu.parsed_json, {});
  const edited = body && body.parsed ? body.parsed : parsed;
  const target = str(body && body.target, 20) || pu.target;
  const now = nowIso();

  if (target === 'vehicle') {
    let vid = str(body && body.vehicle_id, 60) || pu.vehicle_id;
    const f = {
      nickname: str(edited.nickname, 40), brand: str(edited.brand, 40), series: str(edited.series, 60),
      model_year: str(edited.model_year, 20), plate: str(edited.plate, 16), vin: str(edited.vin, 20),
      purchase_date: str(edited.purchase_date, 10), current_km: intOrNull(edited.current_km),
    };
    if (!f.nickname) f.nickname = [f.brand, f.series].filter(Boolean).join(' ') || '我的车';
    if (vid) {
      const own = await env.DB.prepare('SELECT id FROM vehicles WHERE id = ?1 AND user_id = ?2').bind(vid, user.id).first();
      if (!own) vid = null;
    }
    if (vid) {
      await env.DB.prepare(
        `UPDATE vehicles SET nickname=?1, brand=COALESCE(?2,brand), series=COALESCE(?3,series),
                model_year=COALESCE(?4,model_year), plate=COALESCE(?5,plate), vin=COALESCE(?6,vin),
                purchase_date=COALESCE(?7,purchase_date),
                current_km=COALESCE(?8,current_km),
                km_updated_at=CASE WHEN ?8 IS NULL THEN km_updated_at ELSE ?9 END,
                raw_json=?10, updated_at=?9 WHERE id=?11 AND user_id=?12`
      ).bind(f.nickname, f.brand, f.series, f.model_year, f.plate, f.vin, f.purchase_date,
        f.current_km, now, JSON.stringify(edited).slice(0, 2000), vid, user.id).run();
    } else {
      vid = uuid();
      await env.DB.prepare(
        `INSERT INTO vehicles (id, user_id, nickname, brand, series, model_year, plate, vin, purchase_date,
                               current_km, km_updated_at, raw_json, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)`
      ).bind(vid, user.id, f.nickname, f.brand, f.series, f.model_year, f.plate, f.vin, f.purchase_date,
        f.current_km, f.current_km ? now : null, JSON.stringify(edited).slice(0, 2000), now).run();
    }
    await env.DB.prepare('DELETE FROM pending_uploads WHERE id = ?1 AND user_id = ?2').bind(id, user.id).run();
    return json({ ok: true, vehicle_id: vid, target: 'vehicle' });
  }

  // 保养记录
  let vid = str(body && body.vehicle_id, 60) || pu.vehicle_id || null;
  if (vid) {
    const own = await env.DB.prepare('SELECT id FROM vehicles WHERE id = ?1 AND user_id = ?2').bind(vid, user.id).first();
    if (!own) vid = null;
  }
  if (!vid) {
    const first = await env.DB.prepare('SELECT id FROM vehicles WHERE user_id = ?1 ORDER BY created_at ASC LIMIT 1').bind(user.id).first();
    vid = first ? first.id : null;
  }
  if (!vid) return fail('请先建立车辆档案，再把保养记录挂到车上');

  const rid = uuid();
  const items = Array.isArray(edited.items) ? edited.items : [];
  if (!items.length) return fail('这条记录没有识别到任何项目，请补充后再试');
  const orderTime = str(edited.order_time, 19);
  await env.DB.prepare(
    `INSERT INTO records (id, user_id, vehicle_id, kind, shop, order_no, order_time, total_amount,
                          mileage_km, raw_json, created_at)
     VALUES (?1,?2,?3,'maintenance',?4,?5,?6,?7,?8,?9,?10)`
  ).bind(rid, user.id, vid, str(edited.shop, 80), str(edited.order_no, 40), orderTime,
    num(edited.total_amount), intOrNull(edited.mileage_km), JSON.stringify(edited).slice(0, 4000), now).run();

  const inserted = [];
  for (const it of items.slice(0, 40)) {
    const iid = uuid();
    const row = {
      id: iid, record_id: rid, user_id: user.id,
      item_code: null,
      item_name: str(it.name, 120) || '未命名项目',
      spec: str(it.spec, 80),
      qty: num(it.qty),
      unit_price: num(it.unit_price),
      amount: num(it.amount),
      warranty_until: str(it.warranty_until, 10),
      note: str(it.note, 80),
    };
    await env.DB.prepare(
      `INSERT INTO record_items (id, record_id, user_id, item_code, item_name, spec, qty, unit_price, amount, warranty_until, note)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
    ).bind(row.id, row.record_id, row.user_id, row.item_code, row.item_name, row.spec,
      row.qty, row.unit_price, row.amount, row.warranty_until, row.note).run();
    inserted.push(row);
  }

  // 有里程就顺手更新车辆里程
  const mk = intOrNull(edited.mileage_km);
  if (mk) {
    await env.DB.prepare('UPDATE vehicles SET current_km = ?1, km_updated_at = ?2, updated_at = ?2 WHERE id = ?3 AND user_id = ?4')
      .bind(mk, now, vid, user.id).run();
  }

  const built = await buildPlansFromRecord(env, user.id, {
    id: rid, user_id: user.id, vehicle_id: vid, order_time: orderTime, mileage_km: mk,
  }, inserted);

  // 回填 item_code
  for (let i = 0; i < inserted.length; i++) {
    if (built[i] && built[i].item_code && built[i].item_code !== inserted[i].item_code) {
      await env.DB.prepare('UPDATE record_items SET item_code = ?1 WHERE id = ?2')
        .bind(built[i].item_code, inserted[i].id).run();
    }
  }

  await env.DB.prepare('DELETE FROM pending_uploads WHERE id = ?1 AND user_id = ?2').bind(id, user.id).run();
  return json({ ok: true, record_id: rid, vehicle_id: vid, plans: built });
}

// ---------------- 设置与推送 ----------------

async function saveSettings(env, user, body) {
  const cur = await getSettings(env, user.id);
  const now = nowIso();
  const patch = {};
  if (body.bark_keys !== undefined) {
    const arr = Array.isArray(body.bark_keys) ? body.bark_keys : [];
    patch.bark_keys = JSON.stringify(arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 10));
  }
  if (body.bark_server !== undefined) patch.bark_server = str(body.bark_server, 200) || 'https://api.day.app';
  if (body.bark_group !== undefined) patch.bark_group = str(body.bark_group, 40);
  if (body.bark_sound !== undefined) patch.bark_sound = str(body.bark_sound, 40);
  if (body.bark_level !== undefined) patch.bark_level = str(body.bark_level, 20) || 'active';
  if (body.advance_days !== undefined) patch.advance_days = Math.max(0, Math.min(180, intOrNull(body.advance_days) || 7));
  if (body.advance_km !== undefined) patch.advance_km = Math.max(0, Math.min(10000, intOrNull(body.advance_km) || 500));
  if (body.item_overrides !== undefined) patch.item_overrides = JSON.stringify(body.item_overrides || {});
  if (body.notify_enabled !== undefined) patch.notify_enabled = body.notify_enabled ? 1 : 0;
  if (body.timezone_offset !== undefined) patch.timezone_offset = Math.max(-12, Math.min(14, intOrNull(body.timezone_offset) || 8));
  if (body.ai_channel !== undefined) patch.ai_channel = body.ai_channel === 'external' ? 'external' : 'workers-ai';
  if (body.ai_model !== undefined) patch.ai_model = str(body.ai_model, 120);
  if (body.ai_base_url !== undefined) patch.ai_base_url = str(body.ai_base_url, 300);
  if (body.keep_raw_image !== undefined) patch.keep_raw_image = body.keep_raw_image ? 1 : 0;
  if (body.ai_api_key !== undefined) {
    const k = str(body.ai_api_key, 400);
    if (k === '') patch.ai_api_key_enc = null;
    else if (k) patch.ai_api_key_enc = await encryptText(env.APP_SECRET, k);
  }

  const keys = Object.keys(patch);
  if (keys.length) {
    const sets = keys.map((k, i) => `${k}=?${i + 1}`).join(',');
    await env.DB.prepare(`UPDATE settings SET ${sets}, updated_at=?${keys.length + 1} WHERE user_id=?${keys.length + 2}`)
      .bind(...keys.map((k) => patch[k]), now, user.id).run();
  }
  const fresh = await getSettings(env, user.id);
  return json({ ok: true, settings: publicSettings(fresh) });
}

async function pushTest(env, user) {
  const s = await loadSettingsWithKey(env, user.id);
  if (!parseBarkKeys(s).length) return fail('请先填写 Bark Key');
  const r = await sendBark(s, {
    title: '车辆保养助手 测试推送',
    body: `如果你收到这条消息，说明 Bark 配置成功。\n用户：${user.email}\n时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
  });
  // 注意：信封的 ok 只表示"接口调用成功"，推送成败放在 sent 里，
  // 否则前端 api() 会把 ok:false 当请求失败抛出，Bark 的报错就到不了用户眼前。
  const bad = (r.results || []).find((x) => !x.ok);
  const detail = r.ok
    ? '已推送到 ' + (r.results || []).filter((x) => x.ok).length + ' 个设备'
    : ((bad && (bad.detail || ('HTTP ' + bad.status))) || r.detail || '未知原因');
  return json({ ok: true, sent: r.ok, detail, results: r.results });
}

async function pushScan(env, user, url) {
  const dryRun = url.searchParams.get('dry') === '1';
  const r = await scanUser(env, user, { dryRun });
  return json({ ok: true, ...r });
}

// ---------------- 管理员 ----------------
// 权限唯一来源是 users.is_admin（DB）。
// 首个注册用户由 register() 自动提权；之后的管理员增减都在管理台完成。
// 封禁（banned=1）后：登录被拒、现有会话立即失效。

function isAdmin(user) { return !!user && Number(user.is_admin) === 1; }

// Bark Key 等于"能往这台手机推任意通知"的凭据，管理员也只看到打了码的形态。
function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 4) return '••••';
  return s.slice(0, 4) + '••••' + s.slice(-2);
}

async function adminOverview(env, user) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);

  const rows = (await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.is_admin, u.banned, u.created_at,
            (SELECT COUNT(*) FROM vehicles v WHERE v.user_id = u.id) AS vehicles,
            (SELECT COUNT(*) FROM records r WHERE r.user_id = u.id) AS records,
            (SELECT COUNT(*) FROM plans p WHERE p.user_id = u.id) AS plans,
            (SELECT COALESCE(SUM(r.total_amount), 0) FROM records r WHERE r.user_id = u.id) AS spend,
            (SELECT MAX(COALESCE(r.order_time, r.created_at)) FROM records r WHERE r.user_id = u.id) AS last_record_at,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?1) AS active_sessions,
            s.bark_keys AS bark_keys, s.bark_server AS bark_server, s.bark_group AS bark_group,
            s.bark_level AS bark_level, s.bark_sound AS bark_sound, s.notify_enabled AS notify_enabled,
            s.ai_channel AS ai_channel, s.ai_api_key_enc AS ai_api_key_enc, s.ai_model AS ai_model,
            s.advance_days AS advance_days, s.advance_km AS advance_km,
            s.timezone_offset AS timezone_offset, s.item_overrides AS item_overrides
       FROM users u LEFT JOIN settings s ON s.user_id = u.id
      ORDER BY u.created_at`
  ).bind(nowIso()).all()).results || [];

  const planRows = (await env.DB.prepare(
    'SELECT p.user_id, p.*, v.current_km FROM plans p LEFT JOIN vehicles v ON v.id = p.vehicle_id'
  ).all()).results || [];

  // 用与看板完全相同的 evaluatePlan，避免"看板显示正常、管理台显示逾期"这种漂移
  const byId = {};
  rows.forEach((u) => { byId[u.id] = u; });
  const todayCache = {};
  const levels = {};
  let totalOverdue = 0, totalSoon = 0;

  for (const p of planRows) {
    const u = byId[p.user_id];
    if (!u) continue;
    const tz = u.timezone_offset === null || u.timezone_offset === undefined ? 8 : Number(u.timezone_offset);
    const cached = todayCache[String(tz)] || (todayCache[String(tz)] = todayStr(tz));
    const lv = evaluatePlan(p, {
      today: cached,
      advanceDays: u.advance_days || 7,
      currentKm: p.current_km,
      advanceKm: u.advance_km || 500,
    }).level;
    const b = levels[p.user_id] || (levels[p.user_id] = { overdue: 0, soon: 0, ok: 0, unknown: 0 });
    b[lv] = (b[lv] || 0) + 1;
    if (lv === 'overdue') totalOverdue++;
    if (lv === 'soon') totalSoon++;
  }

  const list = rows.map((u) => {
    const keys = parseBarkKeys({ bark_keys: u.bark_keys });
    const lv = levels[u.id] || { overdue: 0, soon: 0, ok: 0, unknown: 0 };
    return {
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      is_admin: Number(u.is_admin) === 1,
      banned: Number(u.banned) === 1,
      created_at: u.created_at,
      counts: {
        vehicles: u.vehicles || 0,
        records: u.records || 0,
        plans: u.plans || 0,
        overdue: lv.overdue || 0,
        soon: lv.soon || 0,
        ok: lv.ok || 0,
        unknown: lv.unknown || 0,
      },
      spend: Number(u.spend || 0),
      last_record_at: u.last_record_at || null,
      active_sessions: u.active_sessions || 0,
      bark: {
        configured: keys.length > 0,
        count: keys.length,
        masked: keys.map(maskKey),
        server: u.bark_server || 'https://api.day.app',
        group: u.bark_group || null,
        level: u.bark_level || 'active',
        sound: u.bark_sound || null,
        notify_enabled: !!u.notify_enabled,
      },
      ai: {
        channel: u.ai_channel || 'workers-ai',
        model: u.ai_model || null,
        has_key: !!u.ai_api_key_enc,
      },
      advance: { days: u.advance_days || 7, km: u.advance_km || 500 },
      overrides: safeParse(u.item_overrides, {}),
    };
  });

  return json({
    ok: true,
    today: todayCache['8'] || todayStr(8),
    registration_open: await registrationOpen(env),
    summary: {
      users: list.length,
      admins: list.filter((x) => x.is_admin).length,
      vehicles: list.reduce((s, x) => s + x.counts.vehicles, 0),
      records: list.reduce((s, x) => s + x.counts.records, 0),
      plans: list.reduce((s, x) => s + x.counts.plans, 0),
      overdue: totalOverdue,
      soon: totalSoon,
      spend: list.reduce((s, x) => s + x.spend, 0),
      bark_configured: list.filter((x) => x.bark.configured).length,
    },
    users: list,
  });
}

/** 管理员开关注册：open=true 开放 / false 关闭 */
async function adminSetRegistration(env, user, body) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);
  const open = !!(body && (body.open === true || body.open === 'true' || body.open === 1 || body.open === '1'));
  await setAppConfig(env, CONF_REG_OPEN, open ? '1' : '0');
  return json({ ok: true, registration_open: open });
}

// ---------------- 关于：交流群 / 问题反馈（FEAT-001 / FEAT-002） ----------------
// 外链不做死在代码里，全走 app_config，管理员在管理台随时改，改完不用发版。
const CONF_FEEDBACK_URL = 'feedback_url';
const CONF_GROUP_URL = 'group_url';
const CONF_GROUP_QR = 'group_qr';
const CONF_GROUP_TITLE = 'group_title';

async function aboutConfig(env) {
  const [feedbackUrl, groupUrl, groupQr, groupTitle] = await Promise.all([
    getAppConfig(env, CONF_FEEDBACK_URL, ''),
    getAppConfig(env, CONF_GROUP_URL, ''),
    getAppConfig(env, CONF_GROUP_QR, ''),
    getAppConfig(env, CONF_GROUP_TITLE, ''),
  ]);
  return {
    feedback_url: feedbackUrl || '',
    group_url: groupUrl || '',
    group_qr: groupQr || '',
    group_title: groupTitle || '交流群',
  };
}

// ---------------- 产品公告（FEAT-003） ----------------
const ANNOUNCE_LEVELS = ['info', 'warn', 'important'];

function normalizeAnnouncement(row, readSet) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    level: ANNOUNCE_LEVELS.indexOf(row.level) >= 0 ? row.level : 'info',
    published: Number(row.published) === 1,
    created_at: row.created_at,
    read_count: row.read_count === undefined ? undefined : Number(row.read_count || 0),
    read: readSet ? readSet.has(row.id) : false,
  };
}

async function readIdSet(env, userId) {
  const rows = (await env.DB.prepare(
    'SELECT announcement_id FROM announcement_reads WHERE user_id = ?1'
  ).bind(userId).all()).results || [];
  return new Set(rows.map((r) => String(r.announcement_id)));
}

/** 公告表还没建/语句出错时返回空数组——首屏不能被它拖垮。 */
async function listAnnouncements(env, user, onlyUnread) {
  try {
    const rows = (await env.DB.prepare(
      `SELECT id, title, body, level, published, created_at FROM announcements
        WHERE published = 1
        ORDER BY created_at ASC`
    ).all()).results || [];
    const readSet = await readIdSet(env, user.id);
    const list = rows.map((r) => normalizeAnnouncement(r, readSet));
    return onlyUnread ? list.filter((a) => !a.read) : list.reverse();
  } catch (e) {
    return [];
  }
}

async function getUnreadAnnouncements(env, user) {
  return listAnnouncements(env, user, true);
}

async function markAnnouncementsRead(env, user, body) {
  const raw = (body && Array.isArray(body.ids)) ? body.ids : [];
  const ids = raw.map((x) => str(x, 60)).filter(Boolean).slice(0, 100);
  if (!ids.length) return fail('缺少要标记的公告');
  const at = nowIso();
  const stmt = env.DB.prepare(
    'INSERT OR IGNORE INTO announcement_reads (user_id, announcement_id, read_at) VALUES (?1, ?2, ?3)'
  );
  for (const id of ids) await stmt.bind(user.id, id, at).run();
  return json({ ok: true, marked: ids.length });
}

async function adminListAnnouncements(env, user) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);
  let rows = [];
  try {
    rows = (await env.DB.prepare(
      `SELECT a.id, a.title, a.body, a.level, a.published, a.created_at,
              (SELECT COUNT(*) FROM announcement_reads r WHERE r.announcement_id = a.id) AS read_count
         FROM announcements a ORDER BY a.created_at DESC`
    ).all()).results || [];
  } catch (e) { rows = []; }
  const totalUsers = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return json({
    ok: true,
    announcements: rows.map((r) => normalizeAnnouncement(r, null)),
    users: Number((totalUsers && totalUsers.n) || 0),
  });
}

async function adminSaveAnnouncement(env, user, body, id) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);
  const level = ANNOUNCE_LEVELS.indexOf(str(body.level, 20)) >= 0 ? str(body.level, 20) : 'info';
  // published 只认显式传值：编辑时不传就保持原状（撤回/重发可以只传这一个字段）
  const publishGiven = body.published !== undefined && body.published !== null;
  const published = publishGiven
    ? ((body.published === true || body.published === 'true' || body.published === 1 || body.published === '1') ? 1 : 0)
    : null;
  const hasContent = body.title !== undefined || body.body !== undefined;

  if (id) {
    const cur = await env.DB.prepare('SELECT id FROM announcements WHERE id = ?1').bind(id).first();
    if (!cur) return fail('公告不存在', 404);
    if (hasContent) {
      const title = str(body.title, 120);
      const text = str(body.body, 4000);
      if (!title) return fail('请填写公告标题');
      if (!text) return fail('请填写公告内容');
      await env.DB.prepare(
        'UPDATE announcements SET title = ?1, body = ?2, level = ?3 WHERE id = ?4'
      ).bind(title, text, level, id).run();
    }
    if (published !== null) {
      await env.DB.prepare('UPDATE announcements SET published = ?1 WHERE id = ?2').bind(published, id).run();
    }
    // 「重新通知所有人」= 清掉已读记录，让每个人都有机会再看到一次弹窗
    if (body.renotify === true || body.renotify === 'true' || body.renotify === 1 || body.renotify === '1') {
      await env.DB.prepare('DELETE FROM announcement_reads WHERE announcement_id = ?1').bind(id).run();
    }
    return json({ ok: true, id });
  }

  const title = str(body.title, 120);
  const text = str(body.body, 4000);
  if (!title) return fail('请填写公告标题');
  if (!text) return fail('请填写公告内容');
  const nid = uuid();
  await env.DB.prepare(
    `INSERT INTO announcements (id, title, body, level, published, created_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(nid, title, text, level, published === null ? 1 : published, nowIso(), user.id).run();
  return json({ ok: true, id: nid });
}

async function adminDeleteAnnouncement(env, user, id) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);
  await env.DB.prepare('DELETE FROM announcement_reads WHERE announcement_id = ?1').bind(id).run();
  await env.DB.prepare('DELETE FROM announcements WHERE id = ?1').bind(id).run();
  return json({ ok: true });
}

async function adminSaveAbout(env, user, body) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);
  // 白名单：只允许改「关于」卡片这几个外链，避免变成任意配置写入口
  const fields = [
    [CONF_FEEDBACK_URL, str(body.feedback_url, 500) || ''],
    [CONF_GROUP_URL, str(body.group_url, 500) || ''],
    [CONF_GROUP_QR, str(body.group_qr, 500) || ''],
    [CONF_GROUP_TITLE, str(body.group_title, 60) || '交流群'],
  ];
  for (const [k, v] of fields) await setAppConfig(env, k, v);
  return json({ ok: true, ...(await aboutConfig(env)) });
}

async function adminUserDetail(env, user, id) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);

  const target = await env.DB.prepare(
    'SELECT id, email, display_name, is_admin, banned, created_at FROM users WHERE id = ?1'
  ).bind(id).first();
  if (!target) return fail('用户不存在', 404);

  const settings = await getSettings(env, target.id);
  const vehicles = (await env.DB.prepare(
    'SELECT id, nickname, brand, series, model_year, plate, vin, current_km, km_updated_at, created_at FROM vehicles WHERE user_id = ?1 ORDER BY created_at'
  ).bind(target.id).all()).results || [];

  const records = (await env.DB.prepare(
    'SELECT * FROM records WHERE user_id = ?1 ORDER BY COALESCE(order_time, created_at) DESC LIMIT 100'
  ).bind(target.id).all()).results || [];
  const ids = records.map((r) => r.id);
  let items = [];
  if (ids.length) {
    const ph = ids.map((_, i) => `?${i + 2}`).join(',');
    items = (await env.DB.prepare(
      `SELECT * FROM record_items WHERE user_id = ?1 AND record_id IN (${ph})`
    ).bind(target.id, ...ids).all()).results || [];
  }
  const byRec = {};
  for (const it of items) (byRec[it.record_id] = byRec[it.record_id] || []).push(it);

  const tz = settings.timezone_offset === null || settings.timezone_offset === undefined ? 8 : Number(settings.timezone_offset);
  const today = todayStr(tz);
  const planRows = (await env.DB.prepare(
    'SELECT p.*, v.current_km FROM plans p LEFT JOIN vehicles v ON v.id = p.vehicle_id WHERE p.user_id = ?1'
  ).bind(target.id).all()).results || [];
  const rank = { overdue: 0, soon: 1, ok: 2, unknown: 3 };
  const plans = planRows.map((p) => ({
    ...p,
    ...evaluatePlan(p, {
      today,
      advanceDays: settings.advance_days || 7,
      currentKm: p.current_km,
      advanceKm: settings.advance_km || 500,
    }),
  }));
  plans.sort((a, b) => (rank[a.level] - rank[b.level]) || String(a.next_due_at || '9999').localeCompare(String(b.next_due_at || '9999')));

  const keys = parseBarkKeys(settings);
  return json({
    ok: true,
    today,
    user: {
      id: target.id,
      email: target.email,
      display_name: target.display_name,
      is_admin: Number(target.is_admin) === 1,
      banned: Number(target.banned) === 1,
      created_at: target.created_at,
    },
    settings: {
      bark: {
        configured: keys.length > 0,
        count: keys.length,
        masked: keys.map(maskKey),
        server: settings.bark_server || 'https://api.day.app',
        group: settings.bark_group || null,
        level: settings.bark_level || 'active',
        sound: settings.bark_sound || null,
        notify_enabled: !!settings.notify_enabled,
      },
      ai: {
        channel: settings.ai_channel || 'workers-ai',
        model: settings.ai_model || null,
        base_url: settings.ai_base_url || null,
        has_key: !!settings.ai_api_key_enc,
      },
      advance: { days: settings.advance_days, km: settings.advance_km },
      overrides: safeParse(settings.item_overrides, {}),
      keep_raw_image: !!settings.keep_raw_image,
      timezone_offset: settings.timezone_offset,
    },
    vehicles,
    records: records.map((r) => ({ ...r, raw_json: undefined, items: byRec[r.id] || [] })),
    plans,
  });
}

// ---------------- 管理员：用户与数据管理（B / C） ----------------

async function countAdmins(env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').first();
  return (r && r.n) || 0;
}

/** B：单个用户的权限/封禁/重置密码 */
async function adminUpdateUser(env, user, id, body) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);
  const target = await env.DB.prepare('SELECT id, email, is_admin, banned FROM users WHERE id = ?1').bind(id).first();
  if (!target) return fail('用户不存在', 404);
  const action = String(body.action || '');
  const now = nowIso();

  if (action === 'promote') {
    if (Number(target.is_admin) === 1) return fail('对方已经是管理员');
    await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?1').bind(id).run();
    return json({ ok: true });
  }
  if (action === 'demote') {
    if (Number(target.is_admin) !== 1) return fail('对方不是管理员');
    if (target.id === user.id) return fail('不能取消自己的管理员权限');
    if ((await countAdmins(env)) <= 1) return fail('至少要保留一位管理员');
    await env.DB.prepare('UPDATE users SET is_admin = 0 WHERE id = ?1').bind(id).run();
    return json({ ok: true });
  }
  if (action === 'ban') {
    if (target.id === user.id) return fail('不能封禁自己');
    if (Number(target.is_admin) === 1) return fail('请先取消对方的管理员权限，再封禁');
    if (Number(target.banned) === 1) return fail('对方已被封禁');
    await env.DB.prepare('UPDATE users SET banned = 1, banned_at = ?1 WHERE id = ?2').bind(now, id).run();
    // 封禁即刻生效：清掉对方全部会话
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id).run();
    return json({ ok: true });
  }
  if (action === 'unban') {
    if (Number(target.banned) !== 1) return fail('对方没有被封禁');
    await env.DB.prepare('UPDATE users SET banned = 0, banned_at = NULL WHERE id = ?1').bind(id).run();
    return json({ ok: true });
  }
  if (action === 'reset_password') {
    // verifier 由管理员的浏览器用目标邮箱的盐派生后传上来，
    // 服务端（10ms CPU 上限）依旧不做 PBKDF2，只做 seal。
    const verifier = String(body.verifier || '');
    if (!/^[0-9a-f]{64}$/.test(verifier)) return fail('密码校验值不合法');
    const salt = await decoySalt(target.email, env.APP_SECRET);
    const sealed = await sealVerifier(verifier, env.APP_SECRET);
    await env.DB.prepare(
      'UPDATE users SET pass_hash = ?1, pass_salt = ?2, iterations = 210000 WHERE id = ?3'
    ).bind(sealed, salt, id).run();
    // 改密后旧会话全部作废
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id).run();
    return json({ ok: true });
  }
  return fail('未知操作：' + action);
}

/** B：删除用户（级联清掉 TA 的所有数据） */
async function adminDeleteUser(env, user, id) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);
  const target = await env.DB.prepare('SELECT id, is_admin FROM users WHERE id = ?1').bind(id).first();
  if (!target) return fail('用户不存在', 404);
  if (target.id === user.id) return fail('不能删除自己');
  if (Number(target.is_admin) === 1 && (await countAdmins(env)) <= 1) return fail('至少要保留一位管理员');

  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id).run();
  await env.DB.prepare('DELETE FROM push_log WHERE user_id = ?1').bind(id).run();
  await env.DB.prepare('DELETE FROM pending_uploads WHERE user_id = ?1').bind(id).run();
  await env.DB.prepare('DELETE FROM record_items WHERE user_id = ?1').bind(id).run();
  await env.DB.prepare('DELETE FROM records WHERE user_id = ?1').bind(id).run();
  await env.DB.prepare('DELETE FROM plans WHERE user_id = ?1').bind(id).run();
  await env.DB.prepare('DELETE FROM vehicles WHERE user_id = ?1').bind(id).run();
  await env.DB.prepare('DELETE FROM settings WHERE user_id = ?1').bind(id).run();
  const r = await env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id).run();
  if (!r.meta || !r.meta.changes) return fail('删除失败，请重试');
  return json({ ok: true });
}

/** C：删除某个用户名下的一条车辆/记录/计划 */
async function adminDeleteData(env, user, id, kind, xid) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);
  if (kind === 'vehicles') {
    await env.DB.prepare('DELETE FROM record_items WHERE user_id = ?1 AND record_id IN (SELECT id FROM records WHERE user_id = ?1 AND vehicle_id = ?2)').bind(id, xid).run();
    await env.DB.prepare('DELETE FROM records WHERE user_id = ?1 AND vehicle_id = ?2').bind(id, xid).run();
    await env.DB.prepare('DELETE FROM plans WHERE user_id = ?1 AND vehicle_id = ?2').bind(id, xid).run();
    const r = await env.DB.prepare('DELETE FROM vehicles WHERE user_id = ?1 AND id = ?2').bind(id, xid).run();
    if (!r.meta || !r.meta.changes) return fail('车辆不存在', 404);
    return json({ ok: true });
  }
  if (kind === 'records') {
    await env.DB.prepare('DELETE FROM record_items WHERE user_id = ?1 AND record_id = ?2').bind(id, xid).run();
    await env.DB.prepare('DELETE FROM plans WHERE user_id = ?1 AND source_record_id = ?2').bind(id, xid).run();
    const r = await env.DB.prepare('DELETE FROM records WHERE user_id = ?1 AND id = ?2').bind(id, xid).run();
    if (!r.meta || !r.meta.changes) return fail('记录不存在', 404);
    return json({ ok: true });
  }
  if (kind === 'plans') {
    await env.DB.prepare('DELETE FROM push_log WHERE user_id = ?1 AND plan_id = ?2').bind(id, xid).run();
    const r = await env.DB.prepare('DELETE FROM plans WHERE user_id = ?1 AND id = ?2').bind(id, xid).run();
    if (!r.meta || !r.meta.changes) return fail('计划不存在', 404);
    return json({ ok: true });
  }
  return fail('未知数据类型', 400);
}

// ---------------- 管理员：项目周期表管理（D） ----------------

function catalogInt(v, min, max) {
  const n = intOrNull(v);
  if (n === null) return null;
  if (n < min || n > max) return undefined; // 越界 → 拒绝
  return n;
}

async function adminListCatalog(env, user) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);
  const rows = (await env.DB.prepare(
    'SELECT * FROM item_catalog ORDER BY enabled DESC, sort_order, code'
  ).all()).results || [];
  return json({ ok: true, catalog: rows });
}

/** D：新增或修改一条周期表项目。code 匹配 [a-z0-9_]，body 不传 code 时为修改 */
async function adminSaveCatalog(env, user, body, code) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);
  const finalCode = String(code || body.code || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,40}$/.test(finalCode)) return fail('编号只能用小写字母、数字、下划线（2-40 位）');
  const name = str(body.name, 40);
  if (!name) return fail('请填写项目名称');
  const months = catalogInt(body.interval_months, 1, 240);
  const kms = catalogInt(body.interval_km, 100, 500000);
  if (months === undefined || kms === undefined) return fail('周期数值超出合理范围');
  const aliases = str(body.aliases, 300) || ''; // 列是 NOT NULL，空值必须落成空串而不是 NULL
  const category = str(body.category, 20) || '其他';
  const note = str(body.note, 100);
  const enabled = body.enabled === undefined ? 1 : (body.enabled ? 1 : 0);

  try {
    await env.DB.prepare(
      `INSERT INTO item_catalog (code, name, aliases, interval_months, interval_km, category, source, enabled, sort_order, note)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
       ON CONFLICT(code) DO UPDATE SET
         name=?2, aliases=?3, interval_months=?4, interval_km=?5, category=?6, enabled=?8, note=?10`
    ).bind(finalCode, name, aliases, months, kms, category, 'admin', enabled, 500, note).run();
  } catch (e) {
    return fail('保存失败：' + String((e && e.message) || e).slice(0, 160), 500);
  }
  clearCatalogCache();
  return json({ ok: true, code: finalCode });
}

/** D：停用（软删除，可再启用） */
async function adminToggleCatalog(env, user, code, enabled) {
  if (!isAdmin(user)) return fail('需要管理员权限', 403);
  const r = await env.DB.prepare('UPDATE item_catalog SET enabled = ?1 WHERE code = ?2').bind(enabled ? 1 : 0, code).run();
  if (!r.meta || !r.meta.changes) return fail('项目不存在', 404);
  clearCatalogCache();
  return json({ ok: true });
}

// ---------------- 数据备份与迁移（报告 BUG-024） ----------------
// 备份里不带 raw_json（识别原文/缩略图）——它体积大且随时能重新识别，
// 带上会让备份文件膨胀到几 MB，迁移时反而拖慢。

const BACKUP_VERSION = 1;

function fileResp(body, type, filename) {
  // RFC 5987：中文文件名要用 filename* 才不会被浏览器拆成乱码
  const cd = "attachment; filename*=UTF-8''" + encodeURIComponent(filename);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': type,
      'content-disposition': cd,
      'cache-control': 'no-store',
    },
  });
}

function stripRaw(row) {
  if (!row) return row;
  const c = { ...row };
  delete c.raw_json;
  return c;
}

async function exportAll(env, user) {
  const [v, r, it, p] = await Promise.all([
    env.DB.prepare('SELECT * FROM vehicles WHERE user_id = ?1 ORDER BY created_at').bind(user.id).all(),
    env.DB.prepare('SELECT * FROM records WHERE user_id = ?1 ORDER BY created_at').bind(user.id).all(),
    env.DB.prepare('SELECT * FROM record_items WHERE user_id = ?1').bind(user.id).all(),
    env.DB.prepare('SELECT * FROM plans WHERE user_id = ?1 ORDER BY created_at').bind(user.id).all(),
  ]);
  const settings = await getSettings(env, user.id);
  const payload = {
    app: 'vehicle-care',
    backup_version: BACKUP_VERSION,
    exported_at: nowIso(),
    account: user.email,
    _note: '不含 AI 识别原文(raw_json)；导入时按「完整恢复」处理，会替换当前账号的同类数据。',
    vehicles: (v.results || []).map(stripRaw),
    records: (r.results || []).map(stripRaw),
    record_items: it.results || [],
    plans: p.results || [],
    settings: publicSettings(settings),
  };
  const name = '车辆保养助手-备份-' + nowIso().slice(0, 10) + '.json';
  return fileResp(JSON.stringify(payload, null, 2), 'application/json; charset=utf-8', name);
}

function csvCell(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportRecordsCsv(env, user) {
  const r = await env.DB.prepare(
    `SELECT r.*, v.plate, v.nickname, v.brand, v.series
       FROM records r LEFT JOIN vehicles v ON v.id = r.vehicle_id
      WHERE r.user_id = ?1 ORDER BY r.created_at DESC`
  ).bind(user.id).all();
  const rows = r.results || [];
  const ids = rows.map((x) => x.id);
  let items = [];
  if (ids.length) {
    const ph = ids.map((_, i) => `?${i + 2}`).join(',');
    items = (await env.DB.prepare(
      `SELECT record_id, item_name, spec, qty, amount FROM record_items
        WHERE user_id = ?1 AND record_id IN (${ph})`
    ).bind(user.id, ...ids).all()).results || [];
  }
  const byRec = {};
  for (const it of items) {
    byRec[it.record_id] = byRec[it.record_id] || [];
    byRec[it.record_id].push(String(it.item_name || '') + (it.spec ? ' ' + it.spec : ''));
  }
  const KIND = { maintenance: '保养', fuel: '加油', beauty: '杂项' };
  const head = ['记录日期', '添加时间', '类型', '项目', '商家', '金额(元)', '升数(L)', '油价(元/L)', '预估里程(km)', '车辆', '备注'];
  const lines = [head.join(',')];
  rows.forEach((x) => {
    lines.push([
      x.order_time ? String(x.order_time).slice(0, 10) : '',
      String(x.created_at || '').slice(0, 10),
      KIND[x.kind] || x.kind || '',
      (byRec[x.id] || []).join(' / '),
      x.shop || '',
      x.total_amount === null || x.total_amount === undefined ? '' : x.total_amount,
      x.liters || '',
      x.unit_price || '',
      x.est_km || '',
      x.plate || [x.brand, x.series, x.nickname].filter(Boolean).join(' ') || '',
      x.order_no || '',
    ].map(csvCell).join(','));
  });
  // BOM：不加的话 Excel 打开中文会乱码
  const body = '﻿' + lines.join('\r\n') + '\r\n';
  return fileResp(body, 'text/csv; charset=utf-8', '养车账单-' + nowIso().slice(0, 10) + '.csv');
}

async function runBatches(env, stmts) {
  // D1 一次 batch 语句太多会顶到请求上限，切成小批顺序执行
  const N = 40;
  for (let i = 0; i < stmts.length; i += N) {
    await env.DB.batch(stmts.slice(i, i + N));
  }
}

async function importAll(env, user, body) {
  const b = body || {};
  if (!Array.isArray(b.vehicles) || !Array.isArray(b.records)) {
    return fail('这不是本应用的备份文件（缺少 vehicles / records）');
  }
  const vehicles = b.vehicles;
  const records = b.records;
  const items = Array.isArray(b.record_items) ? b.record_items : [];
  const plans = Array.isArray(b.plans) ? b.plans : [];
  const now = nowIso();
  const st = [];
  // 完整恢复：先清干净当前账号的同类数据，再整批写回（push_log 里已是历史，一并清掉）
  ['push_log', 'plans', 'record_items', 'records', 'vehicles', 'pending_uploads', 'settings'].forEach((t) => {
    st.push(env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?1`).bind(user.id));
  });

  for (const v of vehicles) {
    st.push(env.DB.prepare(
      `INSERT INTO vehicles (id,user_id,nickname,brand,series,model_year,plate,vin,purchase_date,
        current_km,fuel_consumption,km_updated_at,raw_json,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`).bind(
      v.id || uuid(), user.id, str(v.nickname, 80), str(v.brand, 60), str(v.series, 60), str(v.model_year, 20),
      str(v.plate, 20), str(v.vin, 40), str(v.purchase_date, 20), intOrNull(v.current_km), num(v.fuel_consumption),
      str(v.km_updated_at, 40), null, str(v.created_at, 40) || now, str(v.updated_at, 40) || now));
  }
  for (const r of records) {
    st.push(env.DB.prepare(
      `INSERT INTO records (id,user_id,vehicle_id,kind,shop,order_no,order_time,total_amount,
        mileage_km,unit_price,liters,est_km,partial,raw_json,confirm_token,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`).bind(
      r.id || uuid(), user.id, str(r.vehicle_id, 60), str(r.kind, 20) || 'maintenance', str(r.shop, 80),
      str(r.order_no, 60), str(r.order_time, 40), num(r.total_amount), intOrNull(r.mileage_km),
      num(r.unit_price), num(r.liters), intOrNull(r.est_km), Number(r.partial) ? 1 : 0, null,
      str(r.confirm_token, 80), str(r.created_at, 40) || now));
  }
  for (const it of items) {
    st.push(env.DB.prepare(
      `INSERT INTO record_items (id,record_id,user_id,item_code,item_name,spec,qty,unit_price,amount,warranty_until,note)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`).bind(
      it.id || uuid(), str(it.record_id, 60) || '', user.id, str(it.item_code, 40),
      str(it.item_name, 80) || '未命名项目', str(it.spec, 120), num(it.qty), num(it.unit_price),
      num(it.amount), str(it.warranty_until, 20), str(it.note, 200)));
  }
  for (const p of plans) {
    st.push(env.DB.prepare(
      `INSERT INTO plans (id,user_id,vehicle_id,item_code,item_name,spec,basis,last_done_at,last_km,
        interval_months,interval_km,next_due_at,next_due_km,source_record_id,status,note,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`).bind(
      p.id || uuid(), user.id, str(p.vehicle_id, 60), str(p.item_code, 40) || 'custom',
      str(p.item_name, 80) || '未命名项目', str(p.spec, 120), str(p.basis, 20) || 'catalog',
      str(p.last_done_at, 40), intOrNull(p.last_km), intOrNull(p.interval_months), intOrNull(p.interval_km),
      str(p.next_due_at, 40), intOrNull(p.next_due_km), str(p.source_record_id, 60),
      str(p.status, 20) || 'active', str(p.note, 200), str(p.created_at, 40) || now, str(p.updated_at, 40) || now));
  }
  // 设置：备份里有就照抄，缺的用默认值补齐（列都是 NOT NULL）
  const s = b.settings || {};
  st.push(env.DB.prepare(
    `INSERT INTO settings (user_id,bark_keys,bark_server,bark_group,bark_sound,bark_level,advance_days,
      advance_km,item_overrides,notify_enabled,timezone_offset,ai_channel,ai_model,ai_base_url,ai_api_key_enc,
      keep_raw_image,updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`).bind(
    user.id,
    JSON.stringify(Array.isArray(s.bark_keys) ? s.bark_keys : []),
    str(s.bark_server, 200) || 'https://api.day.app',
    str(s.bark_group, 60), str(s.bark_sound, 60), str(s.bark_level, 20) || 'active',
    intOrNull(s.advance_days) === null ? 7 : intOrNull(s.advance_days),
    intOrNull(s.advance_km) === null ? 500 : intOrNull(s.advance_km),
    JSON.stringify(s.item_overrides || {}),
    s.notify_enabled === false ? 0 : 1,
    intOrNull(s.timezone_offset) === null ? 8 : intOrNull(s.timezone_offset),
    str(s.ai_channel, 20) || 'workers-ai', str(s.ai_model, 80), str(s.ai_base_url, 200),
    null, // ai_api_key_enc 是密文，换环境解不开，不迁移
    s.keep_raw_image ? 1 : 0, now));

  await runBatches(env, st);
  return json({
    ok: true,
    imported: {
      vehicles: vehicles.length, records: records.length,
      record_items: items.length, plans: plans.length,
    },
  });
}



// BUG-019：首屏聚合接口。登录后原本要串行跑 me → meta → vehicles → plans+records 四次往返，
// 这里压成一次：车辆 + 计划 + 记录（含 totals/months）+ 设置 + 周期表。
async function bootstrap(env, user) {
  const settings = await getSettings(env, user.id);
  const vb = await (await listVehicles(env, user)).json();
  const vehicles = vb.vehicles || [];
  const vid = vehicles.length ? vehicles[0].id : null;
  const q = vid ? ('?vehicle_id=' + vid) : '';
  const base = 'http://bootstrap.invalid';
  const [planRes, recRes, catalog] = await Promise.all([
    listPlans(env, user, new URL(base + '/api/plans' + q)),
    listRecords(env, user, new URL(base + '/api/records' + q)).catch(() => null),
    getCatalog(env).catch(() => []),
  ]);
  const pb = await planRes.json();
  const rb = recRes ? await recRes.json() : {};
  // 「关于」外链 + 未读公告都塞进首屏这一趟，登录后弹窗零额外请求（FEAT-001~003）
  const [about, unread] = await Promise.all([
    aboutConfig(env).catch(() => ({ feedback_url: '', group_url: '', group_qr: '', group_title: '交流群' })),
    getUnreadAnnouncements(env, user).catch(() => []),
  ]);
  return json({
    ok: true,
    today: pb.today,
    current_vehicle_id: vid,
    vehicles,
    plans: pb.plans || [],
    records: rb.records || [],
    totals: rb.totals || null,
    months: rb.months || [],
    settings: publicSettings(settings),
    catalog: catalog || [],
    about,
    announcements: unread,
  });
}

export async function handleApi(request, env, ctx, user, pathname, url) {
  const m = request.method.toUpperCase();
  const lower = pathname.toLowerCase();

  // 公开接口
  if (lower === '/api/auth/salt' && m === 'POST') return handleSalt(env, request);
  if (lower === '/api/auth/register' && m === 'POST') return handleRegister(env, request);
  if (lower === '/api/auth/login' && m === 'POST') return handleLogin(env, request);
  if (lower === '/api/meta' && m === 'GET') {
    // registration_open 是公开信息：注册页要靠它决定显示注册表单还是「已关闭」提示
    return json({
      ok: true,
      name: '车辆保养助手',
      default_workers_ai_model: DEFAULT_WORKERS_AI_MODEL,
      registration_open: await registrationOpen(env),
    });
  }

  if (!user) return fail('请先登录', 401);

  if (lower === '/api/auth/logout' && m === 'POST') return handleLogout(env, request, user);
  if (lower === '/api/account/password' && m === 'POST') return changePassword(env, user, await readJson(request));
  if (lower === '/api/me' && m === 'GET') {
    return json({ ok: true, user: { id: user.id, email: user.email, display_name: user.display_name, is_admin: Number(user.is_admin) === 1 } });
  }
  if (lower === '/api/catalog' && m === 'GET') {
    clearCatalogCache();
    const c = await getCatalog(env);
    return json({ ok: true, catalog: c });
  }

  if (lower === '/api/bootstrap' && m === 'GET') return bootstrap(env, user);

  if (lower === '/api/vehicles' && m === 'GET') return listVehicles(env, user);
  if (lower === '/api/vehicles' && m === 'POST') return saveVehicle(env, user, await readJson(request), null);
  let mm = lower.match(/^\/api\/vehicles\/([0-9a-f\-]{8,})$/);
  if (mm && (m === 'PATCH' || m === 'PUT')) return saveVehicle(env, user, await readJson(request), mm[1]);
  if (mm && m === 'DELETE') return deleteVehicle(env, user, mm[1]);

  if (lower === '/api/records' && m === 'GET') return listRecords(env, user, url);
  if (lower === '/api/records' && m === 'POST') return createManualRecord(env, user, await readJson(request));
  mm = lower.match(/^\/api\/records\/([0-9a-f\-]{8,})$/);
  if (mm && m === 'DELETE') return deleteRecord(env, user, mm[1]);

  if (lower === '/api/plans' && m === 'GET') return listPlans(env, user, url);
  mm = lower.match(/^\/api\/plans\/([0-9a-f\-]{8,})$/);
  if (mm && (m === 'PATCH' || m === 'PUT')) return updatePlan(env, user, mm[1], await readJson(request));

  if (lower === '/api/uploads' && m === 'POST') return handleUpload(env, ctx, user, request);
  mm = lower.match(/^\/api\/uploads\/([0-9a-f\-]{8,})\/confirm$/);
  if (mm && m === 'POST') return confirmUpload(env, user, mm[1], await readJson(request));
  mm = lower.match(/^\/api\/uploads\/([0-9a-f\-]{8,})$/);
  if (mm && m === 'DELETE') {
    await env.DB.prepare('DELETE FROM pending_uploads WHERE id = ?1 AND user_id = ?2').bind(mm[1], user.id).run();
    return json({ ok: true });
  }

  if (lower === '/api/settings' && m === 'GET') {
    const s = await getSettings(env, user.id);
    return json({ ok: true, settings: publicSettings(s) });
  }
  if (lower === '/api/settings' && (m === 'PUT' || m === 'POST')) return saveSettings(env, user, await readJson(request));

  // 数据备份与迁移（BUG-024）：导出全量 JSON / 导入恢复 / 账单表格
  if (lower === '/api/export' && m === 'GET') return exportAll(env, user);
  if (lower === '/api/export/records.csv' && m === 'GET') return exportRecordsCsv(env, user);
  if (lower === '/api/import' && m === 'POST') return importAll(env, user, await readJson(request));

  if (lower === '/api/push/test' && m === 'POST') return pushTest(env, user);
  if (lower === '/api/push/scan' && m === 'POST') return pushScan(env, user, url);

  // 关于卡片（交流群 / 问题反馈）+ 产品公告（FEAT-001~003）
  if (lower === '/api/about' && m === 'GET') return json({ ok: true, ...(await aboutConfig(env)) });
  if (lower === '/api/announcements' && m === 'GET') {
    return json({ ok: true, announcements: await listAnnouncements(env, user, false) });
  }
  if (lower === '/api/announcements/read' && m === 'POST') {
    return markAnnouncementsRead(env, user, await readJson(request));
  }

  // 管理员：总览与用户管理。非管理员一律 403，前端也不给入口。
  if (lower === '/api/admin/overview' && m === 'GET') return adminOverview(env, user);
  if (lower === '/api/admin/registration' && m === 'POST') {
    return adminSetRegistration(env, user, await readJson(request));
  }

  // 管理员：关于外链配置 + 产品公告增删改
  if (lower === '/api/admin/about' && m === 'GET') return json({ ok: true, ...(await aboutConfig(env)) });
  if (lower === '/api/admin/about' && m === 'POST') return adminSaveAbout(env, user, await readJson(request));
  if (lower === '/api/admin/announcements' && m === 'GET') return adminListAnnouncements(env, user);
  if (lower === '/api/admin/announcements' && m === 'POST') {
    return adminSaveAnnouncement(env, user, await readJson(request), null);
  }
  const anm = lower.match(/^\/api\/admin\/announcements\/([0-9a-f\-]{8,})$/);
  if (anm && (m === 'PATCH' || m === 'PUT')) {
    return adminSaveAnnouncement(env, user, await readJson(request), anm[1]);
  }
  if (anm && m === 'DELETE') return adminDeleteAnnouncement(env, user, anm[1]);
  const am = lower.match(/^\/api\/admin\/users\/([0-9a-f\-]{8,})$/);
  if (am && m === 'GET') return adminUserDetail(env, user, am[1]);
  if (am && (m === 'PATCH' || m === 'PUT')) return adminUpdateUser(env, user, am[1], await readJson(request));
  if (am && m === 'DELETE') return adminDeleteUser(env, user, am[1]);
  const ax = lower.match(/^\/api\/admin\/users\/([0-9a-f\-]{8,})\/(vehicles|records|plans)\/([0-9a-f\-]{8,})$/);
  if (ax && m === 'DELETE') return adminDeleteData(env, user, ax[1], ax[2], ax[3]);

  // 管理员：项目周期表（全局配置）
  if (lower === '/api/admin/catalog' && m === 'GET') return adminListCatalog(env, user);
  if (lower === '/api/admin/catalog' && m === 'POST') return adminSaveCatalog(env, user, await readJson(request), null);
  const ac = lower.match(/^\/api\/admin\/catalog\/([a-z0-9_]{2,40})$/);
  if (ac && (m === 'PATCH' || m === 'PUT')) return adminSaveCatalog(env, user, await readJson(request), ac[1]);
  if (ac && m === 'DELETE') return adminToggleCatalog(env, user, ac[1], false);
  if (ac && m === 'POST') return adminToggleCatalog(env, user, ac[1], true);

  return fail('接口不存在：' + pathname, 404);
}
