// AI 双通道识别：默认 Workers AI（零 Key），配置了外部 Key 则自动切换
//
// 实测结论（2026-09-20，用真实途虎换胎工单截图对比免费版可用模型）：
//   1) 传图必须用 OpenAI 风格 content: [{type:'text'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,...'}}]
//      用 {type:'image', image:[...bytes]} / base64 字符串 / data URL 字符串 三种写法全部报 AiError 8001 Invalid input。
//   2) 返回的 result.response 可能是字符串，也可能是**已经解析好的对象**（llama-4-scout / llama-3.2-vision 都是对象）。
//      qwen 系则把内容放在 choices[0].message.content。三种都要兜住。
//   3) 免费版可用且效果最好的默认模型是 llama-4-scout：单张 6.4s、门店名/规格/质保期/项目数全对。
//      llama-3.2-11b-vision 更快但会把「春晖街店」读成「春暖街店」；mistral-small 更差；qwen3.8-27b 要 36s。
//      kimi-k2.6 / kimi-k2.7-code / glm-5.3-flash 在免费版直接 403。

import { b64encode } from './crypto.js';

export const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

export const RECORD_PROMPT = `你是中国汽车保养工单识别助手。请仔细阅读这张截图（可能是途虎/京东养车/天猫养车/4S 店的订单详情页或养护记录），提取结构化信息。

只输出一个 JSON 对象。不要输出解释文字，不要用 markdown 代码块。

JSON 结构：
{
  "shop": "门店或平台名称，例如 途虎养车工场店（德清春晖街店）",
  "order_no": "订单号，没有就 null",
  "order_time": "下单或施工时间，格式 YYYY-MM-DDTHH:mm:ss，只有日期就 YYYY-MM-DD，没有就 null",
  "total_amount": 实付金额数字，例如 1241.52，没有就 null,
  "mileage_km": 截图中出现的里程数字（整数），没有就 null,
  "items": [
    {
      "name": "项目或商品名称，例如 波浪静音棉 雷神轮胎 静悦 Silence Pro 2",
      "spec": "规格型号，例如 205/50ZR17 93W XL，没有就 null",
      "qty": 数量数字，没有就 null,
      "unit_price": 单价数字，没有就 null,
      "amount": 该项小计金额数字，没有就 null,
      "warranty_until": "质保截止日期，格式 YYYY-MM-DD，例如 2029-08-16，没有就 null",
      "note": "补充说明，例如 途虎轮胎保障"
    }
  ]
}

规则：
1. 每一项商品、服务、材料都要单独列成一个 item，价格是 0 的服务（如「17寸及以下轮胎安装及动平衡」）也要列。
2. warranty_until 只填明确写出的质保截止日期或服务有效期，不要把订单日期当质保期。注意「质保截止至2029年08月16日」要转成 2029-08-16。
3. 金额只填数字，不要带 ¥ 符号和千分位逗号。
4. 门店名要逐字照抄，不要改字。
5. 看不清或截图中没有的字段一律填 null，不要编造。
6. items 至少要有 1 项；如果截图不是保养订单/养护记录，items 返回空数组。`;

export const VEHICLE_PROMPT = `你是中国车辆信息识别助手。请仔细阅读这张截图（通常是途虎养车等 App 的「我的车辆」页面或行驶证），提取车辆档案。

只输出一个 JSON 对象。不要输出解释文字，不要用 markdown 代码块。

JSON 结构：
{
  "brand": "品牌，例如 大众、丰田、比亚迪，没有就 null",
  "series": "车系或车型全称，例如 朗逸、凯美瑞、汉 EV，没有就 null",
  "model_year": "年款，例如 2021款，没有就 null",
  "plate": "车牌号，例如 浙E12345，没有就 null",
  "vin": "车架号 VIN（17位），没有就 null",
  "purchase_date": "购车日期，格式 YYYY-MM-DD，没有就 null",
  "current_km": 当前里程数字（整数），没有就 null,
  "nickname": "给这辆车起个简短昵称，例如 朗逸，没有就 null"
}

规则：
1. 每个字段逐字照抄，不要改写、不要补全。
2. 看不清或截图中没有的字段一律填 null，不要编造。
3. 车牌号不要加空格，不要加 · 符号。
4. 如果截图里有多辆车，只取第一辆被展示的。`;

function promptFor(target) {
  return target === 'vehicle' ? VEHICLE_PROMPT : RECORD_PROMPT;
}

/** 从模型返回里抠出对象；输入可能已经是解析好的对象 */
export function extractJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return Array.isArray(value) ? null : value;
  let s = String(value).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const candidate = s.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (e) {
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
    } catch (e2) {
      return null;
    }
  }
}

/** 统一取出模型正文：兼容 response 为字符串/对象、OpenAI choices、description */
export function extractContent(result) {
  if (result === null || result === undefined) return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    if (Array.isArray(result)) return null;
    const r = result.response;
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object') return r;
    const ch = result.choices;
    if (Array.isArray(ch) && ch.length) {
      const msg = ch[0] && ch[0].message;
      if (msg && typeof msg.content === 'string') return msg.content;
      if (ch[0] && typeof ch[0].text === 'string') return ch[0].text;
    }
    if (typeof result.description === 'string') return result.description;
    if (typeof result.text === 'string') return result.text;
    if (typeof result.output_text === 'string') return result.output_text;
  }
  return null;
}

// ---------- 字段归一化 ----------

export function normDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/(\d{4})\s*[年\-\/\.]\s*(\d{1,2})\s*[月\-\/\.]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

export function normDateTime(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 19);
  const d = normDate(s);
  const t = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (d && t) return `${d}T${String(t[1]).padStart(2, '0')}:${t[2]}:${t[3] || '00'}`;
  return d;
}

export function normNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  const s = String(v).replace(/[¥￥,\s元]/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

export function normInt(v) {
  const n = normNum(v);
  return n === null ? null : Math.round(n);
}

function normStr(v, max = 200) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  return s.slice(0, max);
}

/** 把模型输出归一成受控结构，防止脏数据入库 */
export function normalizeParsed(raw, target) {
  const o = raw && typeof raw === 'object' ? raw : {};
  if (target === 'vehicle') {
    return {
      target: 'vehicle',
      brand: normStr(o.brand, 40),
      series: normStr(o.series, 60),
      model_year: normStr(o.model_year, 20),
      plate: normStr(o.plate, 16),
      vin: normStr(o.vin, 20),
      purchase_date: normDate(o.purchase_date),
      current_km: normInt(o.current_km),
      nickname: normStr(o.nickname, 30),
    };
  }
  const items = Array.isArray(o.items) ? o.items : [];
  return {
    target: 'record',
    shop: normStr(o.shop, 80),
    order_no: normStr(o.order_no, 40),
    order_time: normDateTime(o.order_time),
    total_amount: normNum(o.total_amount),
    mileage_km: normInt(o.mileage_km),
    items: items.slice(0, 40).map((it) => ({
      name: normStr(it && it.name, 120) || '未命名项目',
      spec: normStr(it && it.spec, 80),
      qty: normNum(it && it.qty),
      unit_price: normNum(it && it.unit_price),
      amount: normNum(it && it.amount),
      warranty_until: normDate(it && it.warranty_until),
      note: normStr(it && it.note, 80),
    })),
  };
}

// ---------- 通道实现 ----------

function visionContent(prompt, mime, bytes) {
  return [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: `data:${mime || 'image/jpeg'};base64,${b64encode(bytes)}` } },
  ];
}

async function callWorkersAi(env, modelName, bytes, mime, prompt) {
  if (!env.AI) throw new Error('当前部署没有绑定 Workers AI，请在设置里改用外部 API 通道');
  const res = await env.AI.run(modelName || DEFAULT_WORKERS_AI_MODEL, {
    messages: [
      { role: 'system', content: '你只输出 JSON，不输出任何多余文字。' },
      { role: 'user', content: visionContent(prompt, mime, bytes) },
    ],
    max_tokens: 1600,
    temperature: 0.1,
  });
  return { value: extractContent(res), raw: res };
}

async function callExternal(env, settings, bytes, mime, prompt) {
  const base = String(settings.ai_base_url || '').trim().replace(/\/+$/, '');
  const key = settings._aiApiKey;
  if (!base) throw new Error('未配置外部 API 地址');
  if (!key) throw new Error('未配置外部 API Key');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const body = {
    model: settings.ai_model || 'qwen-vl-max',
    messages: [
      { role: 'system', content: '你只输出 JSON，不输出任何多余文字。' },
      { role: 'user', content: visionContent(prompt, mime, bytes) },
    ],
    max_tokens: 1600,
    temperature: 0.1,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`外部 API ${r.status}: ${txt.slice(0, 300)}`);
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { throw new Error('外部 API 返回非 JSON：' + txt.slice(0, 200)); }
    const text = j?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('外部 API 返回结构异常：' + txt.slice(0, 200));
    return { value: text, raw: j };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 识别入口。
 * @returns {{ channel, model, text, parsed, error, fellBack, attempts }}
 */
export async function recognize(env, settings, { bytes, mime, target = 'record' }) {
  const prompt = promptFor(target);
  const chat = String(settings.ai_channel || 'workers-ai');
  const hasExternal = !!(settings._aiApiKey && settings.ai_base_url);
  const useExternal = chat === 'external' && hasExternal;
  const waModel = (!useExternal && settings.ai_model) ? settings.ai_model : DEFAULT_WORKERS_AI_MODEL;

  const attempts = [];
  if (useExternal) {
    attempts.push({
      channel: 'external', model: settings.ai_model || 'qwen-vl-max',
      run: () => callExternal(env, settings, bytes, mime, prompt),
    });
  }
  attempts.push({
    channel: 'workers-ai', model: waModel,
    run: () => callWorkersAi(env, waModel, bytes, mime, prompt),
  });

  const errors = [];
  for (const a of attempts) {
    try {
      const { value } = await a.run();
      const parsedRaw = extractJson(value);
      if (!parsedRaw) {
        errors.push(a.channel + ': 模型没有返回可解析的 JSON（' + JSON.stringify(value).slice(0, 200) + '）');
        continue;
      }
      return {
        channel: a.channel,
        model: a.model,
        text: typeof value === 'string' ? value.slice(0, 4000) : JSON.stringify(value).slice(0, 4000),
        parsed: normalizeParsed(parsedRaw, target),
        error: null,
        fellBack: false,
        attempts: errors,
      };
    } catch (e) {
      errors.push(a.channel + ': ' + String((e && e.message) || e));
    }
  }
  return {
    channel: useExternal ? 'external' : 'workers-ai',
    model: null, text: '', parsed: null,
    error: errors.join('；') || '识别失败',
    fellBack: attempts.length > 1,
    attempts: errors,
  };
}
