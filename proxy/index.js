const http = require('http');
const httpProxy = require('http-proxy');
const crypto = require('crypto');
const { serveIndex, injectIntoHead } = require('./upstream-token.js');
const { attachBodyTransform } = require('./compression.js');

// 源端口（DSH 监听端口，默认 3079）与代理端口（代理对外监听端口，默认 3080）。
// 两者必须不同（同一端口只能被一个进程监听），均可通过环境变量覆盖：
//   DSH_PORT=源端口（DSH）   PROXY_PORT=代理端口（对外）
const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const LISTEN_PORT = Number(process.env.PROXY_PORT) || 3080;
const TARGET_ORIGIN = `http://127.0.0.1:${DSH_PORT}`;
const AUTH_REALM = 'dsh-proxy';

// Basic Auth：用户名/密码通过环境变量设置。
// 两个都设置了才启用认证；任一未设置则完全放行（不需要认证）。
const AUTH_USER = process.env.PROXY_USERNAME || '';
const AUTH_PASS = process.env.PROXY_PASSWORD || '';

// 公开静态资源白名单：只含应用名/图标等非敏感数据（PWA manifest、站点图标）。
// 浏览器抓取 <link rel="manifest"> 时（标签未带 crossorigin="use-credentials"）
// 不会携带 Basic Auth 凭据，若这些路径也强制认证，控制台会一直报
// /manifest.webmanifest 401。因此对白名单路径跳过认证；页面、API、WS 仍全部要求认证。
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg', '/favicon.ico']);

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function checkAuth(req) {
  if (!AUTH_USER || !AUTH_PASS) return true; // 未配置 → 不需要认证
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  if (i === -1) return false;
  return safeEqual(decoded.slice(0, i), AUTH_USER) && safeEqual(decoded.slice(i + 1), AUTH_PASS);
}

function rejectUnauthorized(res) {
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${AUTH_REALM}"`,
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('401 Unauthorized');
}

function rejectUpgrade(socket) {
  socket.end(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="${AUTH_REALM}"\r\nConnection: close\r\n\r\n`);
}

const proxy = httpProxy.createProxyServer({
  target: TARGET_ORIGIN,
  ws: true,
  changeOrigin: true,
});

// 核心修复：crypto.randomUUID polyfill。
// DSH 前端用 crypto.randomUUID() 生成 rpcId，但该 API 只在 https/localhost
// 等安全上下文可用；通过局域网 IP 访问时页面是非安全上下文，randomUUID
// 不存在 → RPC 请求发不出去 → 实时通道(WS)建立失败。
// 代理在转发 HTML 时注入基于 getRandomValues 的兼容实现（该 API 非安全源可用）。
const POLYFILL = '<script>(function(){try{if(typeof crypto!=="undefined"&&crypto&&typeof crypto.randomUUID!=="function"){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h="";for(var i=0;i<16;i++){h+=b[i].toString(16).padStart(2,"0")}return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}}catch(e){}})();</script>';

// DSH 前端用 connection.isLoopback 决定设置类功能是否可用（插件配置卡片、设置文件按钮等）：
// 只有通过 localhost/127.0.0.1 等回环地址访问才为真，主机名/局域网访问时这些功能会被隐藏。
// 本代理是对外访问的唯一入口，浏览器永远从非回环地址发起，因此把
// `isLoopbackHostname(pageLocation.hostname)` 判定改写为恒真，让局域网访问同样能用设置功能。
const LOOPBACK_JS_NEEDLE = 'isLoopbackHostname(pageLocation.hostname)';
const LOOPBACK_JS_REPLACEMENT = 'true';

proxy.on('proxyRes', (proxyRes, req, res) => {
  const ct = String(proxyRes.headers['content-type'] || '');
  const isHtml = ct.includes('text/html');
  const isJs = ct.includes('javascript');
  if (!isHtml && !isJs) return;

  // 兼容浏览器/上游的所有压缩形态（gzip / deflate / br，以及不压缩的 identity）：
  // 缓冲整个响应体 → 按 Content-Encoding 解压成明文 → 完成 HTML/JS 改写 → 再按原编码
  // 重压回传。这样无论上游是否开启压缩、压缩成哪种格式，下面的改写逻辑都能生效。
  // （上一版做法是转发时剥离 Accept-Encoding 强制上游返回明文，这里不再依赖该前提）
  attachBodyTransform(res, proxyRes, plain => {
    const text = plain.toString('utf8');
    if (isHtml) {
      // HTML：注入 crypto.randomUUID polyfill
      return Buffer.from(injectIntoHead(text, POLYFILL));
    }
    // JS：仅当命中目标判定串时才改写（未命中返回 null → 原样透传，不做无谓重压）
    if (text.includes(LOOPBACK_JS_NEEDLE)) {
      return Buffer.from(text.split(LOOPBACK_JS_NEEDLE).join(LOOPBACK_JS_REPLACEMENT));
    }
    return null;
  });
});

// changeOrigin 把 Host 改写为目标地址，浏览器带的 Origin 需同步对齐，
// 否则 DSH 的 /api 同源校验(Origin 必须等于它看到的 Host)会拒绝(403)，
// WS 握手同样走该校验。
// 注意：不再剥离 Accept-Encoding。上游无论是否压缩（gzip/deflate/br 均可），
// proxyRes 的压缩兼容管线都会「解压 → 改写 → 重压」，保留带宽收益。
function alignOrigin(req) {
  if (req.headers.origin) req.headers.origin = TARGET_ORIGIN;
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://proxy').pathname;
  if (!PUBLIC_PATHS.has(pathname) && !checkAuth(req)) {
    rejectUnauthorized(res);
    return;
  }
  // 根目录 GET 走 serveIndex：上游(如官方 0.1.2+)返回 401 时携带 launch token 重发一次，
  // 换取会话 cookie；返回 false（异常）则回退到普通反向代理。
  if (req.method === 'GET' && pathname === '/') {
    serveIndex(req, res, { origin: TARGET_ORIGIN, transformHtml: html => injectIntoHead(html, POLYFILL) })
      .then((handled) => {
        if (handled) return;
        alignOrigin(req);
        proxy.web(req, res);
      });
    return;
  }
  alignOrigin(req);
  proxy.web(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (!checkAuth(req)) {
    rejectUpgrade(socket);
    return;
  }
  alignOrigin(req);
  proxy.ws(req, socket, head);
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`代理已启动，监听 0.0.0.0:${LISTEN_PORT}，转发到 ${TARGET_ORIGIN}${AUTH_USER && AUTH_PASS ? '（Basic Auth 已启用）' : '（未启用认证）'}`);
});
