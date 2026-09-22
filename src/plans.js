// 保养计划推算 + 到期扫描 + Bark 推送
import { uuid } from './crypto.js';
import { getCatalog, classifyItem, isPlanCandidate } from './catalog.js';

export function addMonths(isoDate, months) {
  if (!isoDate || !months) return null;
  const d = new Date(String(isoDate).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(months));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

export function todayStr(offsetHours = 8) {
  const t = new Date(Date.now() + offsetHours * 3600000);
  return t.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  const a = Date.parse(String(fromIso).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(String(toIso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function parseOverrides(settings) {
  try {
    const o = JSON.parse(settings.item_overrides || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    return {};
  }
}

/** 从一条保养记录生成 / 更新保养计划 */
export async function buildPlansFromRecord(env, userId, record, items) {
  const catalog = await getCatalog(env);
  const byCode = new Map(catalog.map((c) => [c.code, c]));
  const settings = await env.DB.prepare('SELECT item_overrides FROM settings WHERE user_id = ?1').bind(userId).first();
  const overrides = parseOverrides(settings || {});
  const now = new Date().toISOString();
  const created = [];
  const seen = new Set();

  for (const it of items) {
    if (!isPlanCandidate(it.item_name)) continue;
    const cls = await classifyItem(env, it.item_name, it.spec);
    if (seen.has(cls.code)) continue;
    seen.add(cls.code);

    const cat = byCode.get(cls.code) || cls.catalog || null;
    const ov = overrides[cls.code] || {};
    const months = ov.months !== undefined ? ov.months : (cat ? cat.interval_months : null);
    const kms = ov.km !== undefined ? ov.km : (cat ? cat.interval_km : null);

    let basis = 'none';
    let nextDueAt = null;
    if (it.warranty_until) {
      nextDueAt = String(it.warranty_until).slice(0, 10);
      basis = 'warranty';
    } else if (months && record.order_time) {
      nextDueAt = addMonths(record.order_time, months);
      basis = ov.months !== undefined ? 'override' : 'catalog';
    } else if (months) {
      nextDueAt = addMonths(todayStr(), months);
      basis = 'from_today';
    }

    const lastKm = record.mileage_km || null;
    const nextDueKm = (kms && lastKm) ? lastKm + Number(kms) : null;

    const existing = await env.DB.prepare(
      `SELECT id, last_done_at, next_due_at FROM plans
        WHERE user_id = ?1 AND vehicle_id = ?2 AND item_code = ?3 AND status = 'active'`
    ).bind(userId, record.vehicle_id, cls.code).first();

    if (existing) {
      const newer = !existing.last_done_at || !record.order_time || record.order_time >= existing.last_done_at;
      await env.DB.prepare(
        `UPDATE plans SET item_name = ?1, spec = ?2, basis = ?3,
                last_done_at = CASE WHEN ?4 = 1 THEN ?5 ELSE last_done_at END,
                last_km = CASE WHEN ?4 = 1 THEN ?6 ELSE last_km END,
                interval_months = ?7, interval_km = ?8,
                next_due_at = ?9, next_due_km = ?10,
                source_record_id = CASE WHEN ?4 = 1 THEN ?11 ELSE source_record_id END,
                updated_at = ?12
          WHERE id = ?13`
      ).bind(
        it.item_name, it.spec || null, basis,
        newer ? 1 : 0, record.order_time || null, lastKm,
        months || null, kms || null,
        nextDueAt, nextDueKm, record.id, now, existing.id
      ).run();
      created.push({ id: existing.id, item_code: cls.code, item_name: it.item_name, updated: true, basis, next_due_at: nextDueAt, next_due_km: nextDueKm });
    } else {
      const id = uuid();
      await env.DB.prepare(
        `INSERT INTO plans (id, user_id, vehicle_id, item_code, item_name, spec, basis,
                            last_done_at, last_km, interval_months, interval_km,
                            next_due_at, next_due_km, source_record_id, status, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'active',?15,?15)`
      ).bind(
        id, userId, record.vehicle_id, cls.code, it.item_name, it.spec || null, basis,
        record.order_time || null, lastKm, months || null, kms || null,
        nextDueAt, nextDueKm, record.id, now
      ).run();
      created.push({ id, item_code: cls.code, item_name: it.item_name, updated: false, basis, next_due_at: nextDueAt, next_due_km: nextDueKm });
    }
  }
  return created;
}

/** 计算某个计划当下的到期状态 */
export function evaluatePlan(plan, opts) {
  const { today, advanceDays = 7, currentKm = null, advanceKm = 500 } = opts || {};
  const daysLeft = plan.next_due_at ? daysBetween(today, plan.next_due_at) : null;
  const kmLeft = (plan.next_due_km && currentKm) ? (plan.next_due_km - currentKm) : null;

  let level = 'ok';
  const reasons = [];
  if (daysLeft !== null) {
    if (daysLeft <= 0) { level = 'overdue'; reasons.push(`已过期 ${Math.abs(daysLeft)} 天`); }
    else if (daysLeft <= advanceDays) { level = 'soon'; reasons.push(`还剩 ${daysLeft} 天`); }
    else reasons.push(`还剩 ${daysLeft} 天`);
  }
  if (kmLeft !== null) {
    if (kmLeft <= 0) { level = 'overdue'; reasons.push(`已超出 ${Math.abs(kmLeft)} 公里`); }
    else if (kmLeft <= advanceKm) { if (level !== 'overdue') level = 'soon'; reasons.push(`还剩 ${kmLeft} 公里`); }
    else reasons.push(`还剩 ${kmLeft} 公里`);
  }
  if (daysLeft === null && kmLeft === null) { level = 'unknown'; reasons.push('缺少时间与里程依据'); }
  return { level, daysLeft, kmLeft, reason: reasons.join('，') || null };
}

/** Bark 推送 */
export async function sendBark(settings, { title, body, url }) {
  const keys = parseBarkKeys(settings);
  if (!keys.length) return { ok: false, detail: '未配置 Bark Key', results: [] };
  const server = String(settings.bark_server || 'https://api.day.app').replace(/\/+$/, '');
  const group = settings.bark_group || '车辆保养';
  const results = [];
  for (const key of keys) {
    const qs = new URLSearchParams();
    if (group) qs.set('group', group);
    if (settings.bark_sound) qs.set('sound', settings.bark_sound);
    if (settings.bark_level) qs.set('level', settings.bark_level);
    if (url) qs.set('url', url);
    const endpoint = `${server}/${encodeURIComponent(key)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${qs.toString()}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(endpoint, { method: 'GET', signal: ctrl.signal });
      clearTimeout(timer);
      const txt = await r.text();
      let ok = r.ok;
      try { const j = JSON.parse(txt); if (j && j.code !== undefined) ok = j.code === 200; } catch (e) { /* 非 JSON 就按 HTTP 状态 */ }
      results.push({ key: key.slice(0, 6) + '…', ok, status: r.status, detail: txt.slice(0, 200) });
    } catch (e) {
      results.push({ key: key.slice(0, 6) + '…', ok: false, status: 0, detail: String(e.message || e) });
    }
  }
  return { ok: results.some((r) => r.ok), detail: results.map((r) => `${r.key}:${r.ok ? 'OK' : 'FAIL'}`).join(' '), results };
}

export function parseBarkKeys(settings) {
  try {
    const arr = JSON.parse(settings.bark_keys || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 10);
  } catch (e) {
    return [];
  }
}

/** 扫描某个用户到期的计划并推送（带去重） */
export async function scanUser(env, user, { dryRun = false } = {}) {
  if (Number(user.banned) === 1) return { skipped: 'banned', pushed: [] };
  const settings = await env.DB.prepare('SELECT * FROM settings WHERE user_id = ?1').bind(user.id).first();
  if (!settings) return { skipped: 'no-settings', pushed: [] };
  if (!settings.notify_enabled) return { skipped: 'notify-disabled', pushed: [] };

  const tz = settings.timezone_offset === undefined || settings.timezone_offset === null ? 8 : settings.timezone_offset;
  const today = todayStr(tz);
  const plans = await env.DB.prepare(
    `SELECT p.*, v.current_km, v.nickname, v.plate, v.brand, v.series
       FROM plans p LEFT JOIN vehicles v ON v.id = p.vehicle_id
      WHERE p.user_id = ?1 AND p.status = 'active'`
  ).bind(user.id).all();

  const pushed = [];
  for (const plan of plans.results || []) {
    const ev = evaluatePlan(plan, {
      today,
      advanceDays: settings.advance_days || 7,
      currentKm: plan.current_km,
      advanceKm: settings.advance_km || 500,
    });
    if (ev.level !== 'soon' && ev.level !== 'overdue') continue;

    const stage = ev.level === 'overdue' ? 'due' : 'soon';
    const dueKey = `${plan.next_due_at || ''}|${plan.next_due_km || ''}|${stage}`;
    const dup = await env.DB.prepare(
      `SELECT id FROM push_log WHERE user_id = ?1 AND plan_id = ?2 AND due_key = ?3 AND channel = 'bark'`
    ).bind(user.id, plan.id, dueKey).first();
    if (dup) continue;

    const carName = [plan.nickname, plan.brand, plan.series].filter(Boolean).join(' ') || '我的车';
    const plate = plan.plate ? `（${plan.plate}）` : '';
    const title = ev.level === 'overdue'
      ? `${plan.item_name} 已到期`
      : `${plan.item_name} 即将到期`;
    const body = `${carName}${plate}\n${plan.item_name}：${ev.reason || ''}\n建议尽快安排${plan.item_name}更换或检查。`;

    if (dryRun) {
      pushed.push({ plan_id: plan.id, item_name: plan.item_name, stage, dueKey, dryRun: true, title, body });
      continue;
    }
    const res = await sendBark(settings, { title, body });
    await env.DB.prepare(
      `INSERT OR IGNORE INTO push_log (id, user_id, plan_id, due_key, channel, ok, detail, created_at)
       VALUES (?1, ?2, ?3, ?4, 'bark', ?5, ?6, ?7)`
    ).bind(uuid(), user.id, plan.id, dueKey, res.ok ? 1 : 0, (res.detail || '').slice(0, 300), new Date().toISOString()).run();
    pushed.push({ plan_id: plan.id, item_name: plan.item_name, stage, ok: res.ok, detail: res.detail });
  }
  return { skipped: null, today, pushed };
}

/** Cron 入口：扫描全部用户（封禁账号不推送） */
export async function scanAll(env) {
  const users = await env.DB.prepare('SELECT id, email, banned FROM users').all();
  const summary = [];
  for (const u of users.results || []) {
    try {
      const r = await scanUser(env, u);
      summary.push({ user: u.email, skipped: r.skipped, pushed: (r.pushed || []).length });
    } catch (e) {
      summary.push({ user: u.email, error: String(e.message || e) });
    }
  }
  return summary;
}
