// Worker 入口：API 路由 + 静态资源 + 定时扫描
import { handleApi } from './api.js';
import { currentUser, json } from './auth.js';
import { scanAll } from './plans.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const user = await currentUser(env, request);
      try {
        return await handleApi(request, env, ctx, user, pathname, url);
      } catch (e) {
        const msg = String((e && e.message) || e);
        console.error('API error', pathname, msg, e && e.stack);
        return json({ ok: false, error: '服务端异常：' + msg }, 500);
      }
    }

    // 静态资源：明确禁止强缓存，否则部署后浏览器 / 边缘还在跑旧的 app.js、style.css
    const noCache = (res) => {
      const ct = res.headers.get('content-type') || '';
      if (!/text\/html|javascript|text\/css/.test(ct)) return res;
      const h = new Headers(res.headers);
      h.set('Cache-Control', 'no-cache, must-revalidate');
      h.delete('Expires');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    };
    try {
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404 && request.method === 'GET') {
        return noCache(await env.ASSETS.fetch(new Request(new URL('/index.html', url), request)));
      }
      return noCache(res);
    } catch (e) {
      return new Response('资源不可用', { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const summary = await scanAll(env);
        console.log('[cron] 到期扫描完成', JSON.stringify(summary));
      } catch (e) {
        console.error('[cron] 扫描失败', String((e && e.message) || e));
      }
    })());
  },
};
