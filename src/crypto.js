// 密码学工具：客户端派生 + 服务端轻量比对
// 设计要点：Workers 免费版 10ms CPU，服务端绝不跑 PBKDF2（实测 1 万次就 12.7ms）

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToHex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex) {
  const s = String(hex || '');
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function b64encode(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function b64decode(str) {
  const s = atob(String(str || ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function uuid() {
  return crypto.randomUUID();
}

export function randomHex(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return bytesToHex(d);
}

export async function sha256Bytes(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(text)));
  return bytesToHex(sig);
}

/** 定长比较，避免时序侧信道 */
export function timingSafeEqual(a, b) {
  const s1 = String(a || '');
  const s2 = String(b || '');
  let diff = s1.length ^ s2.length;
  const n = Math.max(s1.length, s2.length);
  for (let i = 0; i < n; i++) {
    diff |= (s1.charCodeAt(i) || 0) ^ (s2.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function pepperOf(secret) {
  return String(secret || 'vehicle-care-default-pepper-change-me');
}

/**
 * 把客户端传来的 verifier 再夹一层服务端 pepper 后落库。
 * 好处：单靠数据库泄露无法直接登录（pepper 存在 Worker secret 里）。
 */
export async function sealVerifier(verifier, secret) {
  return sha256Hex(pepperOf(secret) + '|v1|' + String(verifier));
}

/** 未注册邮箱也要返回一个稳定假盐，避免通过接口探测邮箱是否存在 */
export async function decoySalt(email, secret) {
  const h = await hmacHex(pepperOf(secret), 'salt|' + String(email).trim().toLowerCase());
  return h.slice(0, 32);
}

// ---------- AES-GCM：加密用户填的外部 API Key ----------

async function aesKey(secret) {
  const raw = await sha256Bytes(enc.encode(pepperOf(secret) + '|aes'));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptText(secret, plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await aesKey(secret);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(plain)));
  const merged = new Uint8Array(iv.length + ct.byteLength);
  merged.set(iv, 0);
  merged.set(new Uint8Array(ct), iv.length);
  return 'v1:' + b64encode(merged);
}

export async function decryptText(secret, payload) {
  if (!payload) return null;
  const s = String(payload);
  if (s.indexOf('v1:') !== 0) return null;
  try {
    const merged = b64decode(s.slice(3));
    const iv = merged.slice(0, 12);
    const ct = merged.slice(12);
    const key = await aesKey(secret);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return dec.decode(pt);
  } catch (e) {
    return null;
  }
}
