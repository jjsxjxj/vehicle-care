// 保养项目目录与归类规则
// 内置周期表为「主」，D1 item_catalog 可覆盖（source='user' 时优先）

export const FALLBACK_CATALOG = [
  { code: 'engine_oil',   name: '机油',       aliases: '机油,发动机油,润滑油,全合成机油,半合成机油,矿物质机油', interval_months: 6,  interval_km: 5000,  category: '油液', note: '全合成可延至 10000km/12 个月' },
  { code: 'oil_filter',   name: '机油滤芯',   aliases: '机滤,机油滤,机油滤清器,机油格',                     interval_months: 6,  interval_km: 5000,  category: '滤芯', note: '随机油一同更换' },
  { code: 'air_filter',   name: '空气滤芯',   aliases: '空滤,空气滤,空气滤清器,空气格',                     interval_months: 12, interval_km: 10000, category: '滤芯', note: null },
  { code: 'cabin_filter', name: '空调滤芯',   aliases: '空调滤,空调滤清器,空调格,PM2.5滤芯',                interval_months: 12, interval_km: 10000, category: '滤芯', note: null },
  { code: 'fuel_filter',  name: '汽油滤芯',   aliases: '汽滤,燃油滤,汽油滤清器,汽油格',                     interval_months: 24, interval_km: 30000, category: '滤芯', note: null },
  { code: 'brake_fluid',  name: '刹车油',     aliases: '制动液,刹车液,制动油',                              interval_months: 24, interval_km: 40000, category: '油液', note: null },
  { code: 'coolant',      name: '防冻液',     aliases: '冷却液,水箱水,防冻冷却液',                          interval_months: 48, interval_km: 60000, category: '油液', note: null },
  { code: 'spark_plug',   name: '火花塞',     aliases: '火嘴,点火塞',                                       interval_months: 48, interval_km: 40000, category: '点火', note: '铱金可延至 60000-100000km' },
  { code: 'gearbox_oil',  name: '变速箱油',   aliases: '波箱油,ATF,齿轮油,变速器油',                        interval_months: 48, interval_km: 60000, category: '油液', note: null },
  { code: 'steering_oil', name: '转向助力油', aliases: '助力油,方向机油,转向油',                            interval_months: 24, interval_km: 40000, category: '油液', note: null },
  { code: 'brake_pad',    name: '刹车片',     aliases: '制动片,刹车皮,制动块',                              interval_months: 24, interval_km: 40000, category: '制动', note: '按实际磨损更换' },
  { code: 'brake_disc',   name: '刹车盘',     aliases: '制动盘,刹车碟',                                     interval_months: 60, interval_km: 80000, category: '制动', note: '按实际磨损更换' },
  { code: 'tire',         name: '轮胎',       aliases: '车胎,外胎,防爆胎,静音轮胎',                         interval_months: 60, interval_km: 60000, category: '轮胎', note: '或按胎面磨损标记' },
  { code: 'battery',      name: '电瓶',       aliases: '蓄电池,蓄电瓶,启动电池,AGM电池',                    interval_months: 42, interval_km: null,  category: '电气', note: null },
  { code: 'wiper',        name: '雨刮片',     aliases: '雨刷,雨刮器,雨刷片,雨刮条',                         interval_months: 12, interval_km: null,  category: '外观', note: null },
  { code: 'ac_filter',    name: '空调滤网',   aliases: '进气滤网,车内滤网',                                 interval_months: 12, interval_km: 10000, category: '滤芯', note: null },
  { code: 'timing_belt',  name: '正时皮带',   aliases: '时规带,正时带,正时链条',                            interval_months: 72, interval_km: 80000, category: '发动机', note: '以厂家手册为准' },
  { code: 'drive_belt',   name: '发电机皮带', aliases: '附件皮带,多楔带,风扇皮带',                          interval_months: 60, interval_km: 60000, category: '发动机', note: null },
  { code: 'clutch',       name: '离合器',     aliases: '离合片,离合器片,离合器总成',                        interval_months: null, interval_km: 80000, category: '传动', note: '按实际磨损更换' },
  { code: 'shock',        name: '减震器',     aliases: '避震,减震筒,减震总成',                              interval_months: null, interval_km: 80000, category: '底盘', note: '按漏油/异响情况' },
  { code: 'tie_rod',      name: '球头/拉杆',  aliases: '转向拉杆,球笼,悬挂球头',                            interval_months: null, interval_km: 80000, category: '底盘', note: null },
  { code: 'antifreeze',   name: '玻璃水',     aliases: '雨刮水,洗涤液,玻璃清洗液',                          interval_months: 6,  interval_km: null,  category: '耗材', note: null },
  { code: 'wheel_align',  name: '四轮定位',   aliases: '定位,动平衡,轮胎平衡',                              interval_months: 12, interval_km: 20000, category: '服务', note: null },
  { code: 'inspection',   name: '全车检测',   aliases: '免费检测,常规检查,全车检查,保养检测',               interval_months: 6,  interval_km: null,  category: '服务', note: null },
];

// 「不计入保养计划」的服务类项目：装拆、清洁、贴膜等
export const NON_PLAN_PATTERNS = [
  '安装', '拆卸', '拆装', '工时', '贴膜', '镀晶', '打蜡', '抛光', '洗车',
  '补胎', '救援', '拖车', '代办', '年检', '上门', '运费', '材料费',
];

let _cache = null;
let _cacheAt = 0;

/** 读取项目目录：D1 优先，失败回退内置表。5 分钟本地缓存。 */
export async function getCatalog(env) {
  const now = Date.now();
  if (_cache && now - _cacheAt < 5 * 60 * 1000) return _cache;
  let rows = null;
  try {
    const r = await env.DB.prepare(
      'SELECT code, name, aliases, interval_months, interval_km, category, source, note FROM item_catalog WHERE enabled = 1'
    ).all();
    rows = r.results || [];
  } catch (e) {
    rows = null;
  }
  if (!rows || rows.length === 0) {
    _cache = FALLBACK_CATALOG.map((x) => ({ ...x, source: 'builtin' }));
  } else {
    _cache = rows;
  }
  _cacheAt = now;
  return _cache;
}

export function clearCatalogCache() {
  _cache = null;
  _cacheAt = 0;
}

/** 把任意项目名归类到 item_code。返回 { code, name, catalog, via } */
export async function classifyItem(env, rawName, spec) {
  const catalog = await getCatalog(env);
  const text = String(rawName || '') + ' ' + String(spec || '');
  const compact = text.replace(/\s+/g, '');

  let best = null;
  let bestLen = 0;
  for (const item of catalog) {
    const keys = String(item.aliases || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    keys.push(item.name);
    for (const k of keys) {
      if (!k) continue;
      if (compact.indexOf(k) >= 0 && k.length > bestLen) {
        best = item;
        bestLen = k.length;
      }
    }
  }
  if (best) {
    return { code: best.code, name: best.name, catalog: best, via: 'keyword' };
  }
  // 兜底：直接拿原名建一个「自定义项目」，不做周期推算，只记录
  const slug = 'custom_' + hashStr(compact.slice(0, 24));
  return { code: slug, name: stripSpec(rawName), catalog: null, via: 'custom' };
}

function stripSpec(name) {
  let s = String(name || '').replace(/【[^】]*】/g, '').trim();
  if (s.length > 40) s = s.slice(0, 40);
  return s || '未命名项目';
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function isPlanCandidate(rawName) {
  const s = String(rawName || '');
  if (!s) return false;
  // 主体优先：「轮胎安装及动平衡」「四轮定位」这种要保留
  const keepBody = s.indexOf('动平衡') >= 0 || s.indexOf('定位') >= 0;
  if (!keepBody && NON_PLAN_PATTERNS.some((k) => s.indexOf(k) >= 0)) return false;
  return true;
}
