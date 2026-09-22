// 会话与用户鉴权
import { uuid, randomHex, sealVerifier, decoySalt, timingSafeEqual } from './crypto.js';

export const COOKIE_NAME = 'vc_session';
const SESSION_DAYS = 7;
const PBKDF2_ITERATIONS = 210000; // 由浏览器执行，符合 OWASP 建议

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function fail(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

export function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function sessionCookie(token, maxAgeSec) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * 盐由服务端密钥确定性派生，不存库、不看库。
 * 好处：① 注册前后返回完全一致，无法通过接口探测邮箱是否已注册；
 *       ② 客户端只需回传 verifier，不需要（也不被允许）自己挑盐。
 * 注意：APP_SECRET 因此不可更换，换掉等于所有账号失效。
 */
export async function getSalt(env, email) {
  const mail = String(email || '').trim().toLowerCase();
  const salt = await decoySalt(mail, env.APP_SECRET);
  return { salt, iterations: PBKDF2_ITERATIONS, algorithm: 'PBKDF2-SHA256' };
}

export async function register(env, { email, display_name, verifier }) {
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { error: '邮箱格式不正确' };
  if (!verifier) return { error: '缺少密码校验值' };
  if (String(verifier).length !== 64) return { error: '密码校验值长度不合法' };

  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(mail).first();
  if (exists) return { error: '该邮箱已注册' };

  const id = uuid();
  const now = new Date().toISOString();
  const salt = await decoySalt(mail, env.APP_SECRET);
  const sealed = await sealVerifier(verifier, env.APP_SECRET);
  const displayName = String(display_name || mail.split('@')[0]).slice(0, 40);
  await env.DB.prepare(
    `INSERT INTO users (id, email, display_name, pass_hash, pass_salt, iterations, is_admin, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)`
  ).bind(id, mail, displayName, sealed, salt, PBKDF2_ITERATIONS, now).run();

  // 全新部署（库里除自己外没有别人）时，第一个注册的人自动成为管理员，
  // 这样不用手写 SQL 去抬权限。单条语句原子判定，避免并发注册时两个人都当上管理员。
  await env.DB.prepare(
    `UPDATE users SET is_admin = 1
      WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.id <> ?1)`
  ).bind(id).run();
  const row = await env.DB.prepare('SELECT is_admin FROM users WHERE id = ?1').bind(id).first();

  await env.DB.prepare(
    `INSERT INTO settings (user_id, updated_at) VALUES (?1, ?2)
     ON CONFLICT(user_id) DO NOTHING`
  ).bind(id, now).run();
  return { user: { id, email: mail, display_name: displayName, is_admin: (row && row.is_admin) ? 1 : 0 } };
}

export async function login(env, { email, verifier, userAgent }) {
  const mail = String(email || '').trim().toLowerCase();
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(mail).first();
  if (!user) return { error: '邮箱或密码不正确' };
  const sealed = await sealVerifier(verifier, env.APP_SECRET);
  if (!timingSafeEqual(sealed, user.pass_hash)) return { error: '邮箱或密码不正确' };
  if (Number(user.banned) === 1) return { error: '该账号已被停用，如有疑问请联系管理员' };

  const token = randomHex(32);
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400000);
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).bind(token, user.id, now.toISOString(), exp.toISOString(), String(userAgent || '').slice(0, 200)).run();

  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now.toISOString()).run();
  return {
    token,
    cookie: sessionCookie(token, SESSION_DAYS * 86400),
    user: { id: user.id, email: user.email, display_name: user.display_name, is_admin: user.is_admin },
  };
}

export async function logout(env, token) {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?1').bind(token).run();
}

/** 取当前登录用户；未登录返回 null */
export async function currentUser(env, request) {
  const token = getCookie(request, COOKIE_NAME) || request.headers.get('X-Session-Token');
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.token, s.expires_at, u.id, u.email, u.display_name, u.is_admin, u.banned
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?1`
  ).bind(token).first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now() || Number(row.banned) === 1) {
    // 过期或被封禁的会话一律当场作废
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?1').bind(token).run();
    return null;
  }
  return { id: row.id, email: row.email, display_name: row.display_name, is_admin: row.is_admin, token };
}

/** 读设置；不存在则建默认行 */
export async function getSettings(env, userId) {
  let s = await env.DB.prepare('SELECT * FROM settings WHERE user_id = ?1').bind(userId).first();
  if (!s) {
    await env.DB.prepare('INSERT INTO settings (user_id, updated_at) VALUES (?1, ?2)')
      .bind(userId, new Date().toISOString()).run();
    s = await env.DB.prepare('SELECT * FROM settings WHERE user_id = ?1').bind(userId).first();
  }
  return s;
}
