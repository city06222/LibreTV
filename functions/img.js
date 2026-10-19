/**
 * functions/img.js
 * 路由：GET /img?url=<encodeURIComponent(图片原始地址)>
 *
 * 作用：豆瓣图片专用反代。
 *  - 服务端带上 `Referer: https://movie.douban.com/` 取图（这是唯一能拿到 200 的方式）
 *  - 二进制原样透传（streaming，绝不做 response.text()，否则 JPEG 会被 UTF-8 重新编码成乱码）
 *  - Cache API + 长缓存，边缘命中后不再消耗函数配额
 *  - 域名白名单，避免变成公开开放代理
 */

// 允许反代的域名（按需增补）
const ALLOW_HOSTS = [
  /(^|\.)doubanio\.com$/i,   // img1/img2/img3/img9.doubanio.com
  /(^|\.)douban\.com$/i,     // movie.douban.com 等
  /(^|\.)dbstatic\.com$/i,   // 豆瓣静态资源
];

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function fail(msg, status = 404) {
  return new Response(msg, {
    status,
    headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, waitUntil } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'GET') {
    return fail('Method Not Allowed', 405);
  }

  const reqUrl = new URL(request.url);
  let raw = reqUrl.searchParams.get('url') || '';
  if (!raw) return fail('missing url');

  // 兼容「已编码」和「未编码」两种传参
  try {
    raw = decodeURIComponent(raw);
  } catch (_) {
    /* 保留原值 */
  }

  let target;
  try {
    target = new URL(raw);
  } catch (_) {
    return fail('bad url');
  }

  if (target.protocol !== 'https:' && target.protocol !== 'http:') return fail('bad protocol');
  if (!ALLOW_HOSTS.some((re) => re.test(target.hostname))) return fail('host not allowed');
  if (!IMAGE_EXT.test(target.pathname)) return fail('not an image');

  // 统一缓存键：同图不同参数只存一份
  const cacheKey = new Request(
    `${reqUrl.origin}/img?url=${encodeURIComponent(target.toString())}`,
    { method: 'GET' }
  );

  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: 'GET',
      headers: {
        // 关键：豆瓣 CDN 只认 douban 域名的 Referer
        Referer: 'https://movie.douban.com/',
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      redirect: 'follow',
      cf: { cacheEverything: true, cacheTtl: 2592000 },
    });
  } catch (err) {
    return fail(`fetch failed: ${err.message}`, 502);
  }

  if (!upstream.ok) {
    // 返回 404 让前端 onerror 走本地占位图，避免坏图挂着
    return fail(`upstream ${upstream.status}`, 404);
  }

  const headers = new Headers(CORS);
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Img-Proxy', 'douban');

  const len = upstream.headers.get('Content-Length');
  if (len) headers.set('Content-Length', len);

  // 二进制直通，不做任何文本解码
  const res = new Response(upstream.body, { status: 200, headers });

  // 写入边缘缓存（不阻塞响应）
  waitUntil(cache.put(cacheKey, res.clone()));

  return res;
}
