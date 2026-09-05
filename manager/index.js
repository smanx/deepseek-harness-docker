#!/usr/bin/env node
// deepseek-harness 管理服务（admin 变体入口）
//
// 职责：
//   1. 服务管理员页面（/__admin/）与 API：选择/安装/切换 DSH 版本、配置 npm 源；
//   2. 托管 DSH 进程（启动/停止/重启/等待就绪）；
//   3. 对 DSH Web UI 做反向代理（复用旧代理的 polyfill / loopback / Origin / Basic Auth / WS 逻辑）；
//   4. 未安装或 DSH 未运行时，访问 / 自动跳转到管理员页。
//
// 数据持久化约定：
//   - DSH 安装到 INSTALL_DIR（建议挂载命名卷，如 dsh-install:/opt/dsh），已装版本与状态文件都在卷上，
//     容器重建后无需重装，管理服务启动时自动识别并拉起 DSH；
//   - DSH 自身配置/会话仍在 ~/.dsh（建议挂载 dsh-data:/root/.dsh）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const httpProxy = require('http-proxy');
const crypto = require('crypto');
const { serveIndex, injectIntoHead } = require('../proxy/upstream-token.js');

// ── 端口与环境 ────────────────────────────────────────────────
const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const LISTEN_PORT = Number(process.env.PROXY_PORT) || 3080;
const TARGET_ORIGIN = `http://127.0.0.1:${DSH_PORT}`;
const DSH_WEB_LOG = process.env.DSH_WEB_LOG || '/app/.dsh-web.log'; // DSH 运行日志落盘，供 launch-token 打捞

// DSH 安装目录（应挂载持久卷 dsh-install:/opt/dsh）
const INSTALL_DIR = process.env.DSH_INSTALL_DIR || '/opt/dsh';
const DSH_BIN = path.join(INSTALL_DIR, 'bin', 'dsh');
const DSH_PKG_JSON = path.join(INSTALL_DIR, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
const MANAGER_DIR = path.join(INSTALL_DIR, 'manager');
const STATE_FILE = path.join(MANAGER_DIR, 'state.json');

// npm 源：默认值（容器启动环境变量 NPM_CONFIG_REGISTRY 可覆盖）+ 管理员页面保存值（优先级最高）
const DEFAULT_REGISTRY = process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org/';

// Windows 本地调试时 npm 是 npm.cmd；Linux 容器内是 npm
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Basic Auth（与旧代理一致：两个都设置才启用）
const AUTH_USER = process.env.PROXY_USERNAME || '';
const AUTH_PASS = process.env.PROXY_PASSWORD || '';
const AUTH_REALM = 'dsh-admin';
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg', '/favicon.ico']);

// ── 状态（含 npm 源配置）─────────────────────────────────────
let state = loadState();
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}
function saveState() {
  try {
    fs.mkdirSync(MANAGER_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[manager] 保存状态失败:', e.message);
  }
}
function effectiveRegistry() {
  return (state.registry && state.registry.trim()) || DEFAULT_REGISTRY;
}
function registryInfo() {
  return {
    default: DEFAULT_REGISTRY,
    saved: state.registry || null,
    effective: effectiveRegistry(),
  };
}

// ── 基础工具 ──────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function isDshInstalled() {
  return fs.existsSync(DSH_BIN) && fs.existsSync(DSH_PKG_JSON);
}
function actualVersion() {
  try {
    return JSON.parse(fs.readFileSync(DSH_PKG_JSON, 'utf8')).version || null;
  } catch {
    return null;
  }
}

// ── DSH 进程管理 ─────────────────────────────────────────────
let dshProc = null;
let dshReady = false;

function bootDsh() {
  return new Promise(resolve => {
    if (dshProc) return resolve({ ok: true });
    if (!isDshInstalled()) return resolve({ ok: false, reason: '未安装 DSH' });
    dshReady = false;
    const env = {
      ...process.env,
      PATH: `${path.join(INSTALL_DIR, 'bin')}:${process.env.PATH || ''}`,
      NPM_CONFIG_REGISTRY: effectiveRegistry(),
    };
    console.log(`[manager] 启动 DSH: ${DSH_BIN} web --port ${DSH_PORT}`);
    const p = spawn(DSH_BIN, ['web', '--port', String(DSH_PORT)], { env, stdio: 'pipe' });
    dshProc = p;
    // DSH 运行日志：同一份内容同时写容器输出（可见）与 DSH_WEB_LOG 落盘（供 launch-token 打捞）
    const logStream = fs.createWriteStream(DSH_WEB_LOG, { flags: 'a' });
    p.stdout.on('data', d => { logStream.write(d); process.stdout.write(`[dsh] ${d}`); });
    p.stderr.on('data', d => { logStream.write(d); process.stderr.write(`[dsh] ${d}`); });
    p.on('error', err => {
      console.error('[manager] DSH 启动失败:', err.message);
      dshProc = null;
      dshReady = false;
      resolve({ ok: false, reason: err.message });
    });
    p.on('exit', (code, sig) => {
      console.log(`[manager] DSH 已退出 (code=${code}, sig=${sig})`);
      if (dshProc === p) dshProc = null;
      dshReady = false;
      try { logStream.end(); } catch {}
    });
    waitDshReady().then(ok => {
      dshReady = ok;
      console.log(ok ? '[manager] DSH 就绪' : '[manager] DSH 120 秒内未就绪');
      resolve({ ok });
    });
  });
}

function stopDsh() {
  return new Promise(resolve => {
    const p = dshProc;
    dshProc = null;
    dshReady = false;
    if (!p) return resolve();
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 10000);
    p.once('exit', () => { clearTimeout(timer); resolve(); });
    try { p.kill('SIGTERM'); } catch { resolve(); }
  });
}

async function restartDsh() {
  await stopDsh();
  return bootDsh();
}

async function waitDshReady(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!dshProc) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${DSH_PORT}/`);
      if (res.status < 500) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

// ── 安装（流式日志 → SSE）────────────────────────────────────
let installing = false;
let installMeta = { running: false, version: null, ok: null, done: false };
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

// 管理性日志：同一条内容同时进 SSE（前端）与容器日志（docker logs）
function emitLog(line) {
  broadcast('log', { line });
  process.stdout.write(`[manager-cmd] ${line}\n`);
}

function runCmd(cmd, args, env, onLine) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: 'pipe' });
    } catch (e) { return reject(e); }
    let buf = '';
    const push = chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.trim()) {
          process.stdout.write(`[manager-cmd] ${line}\n`); // 同时进容器日志
          onLine(line);
        }
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', reject);
    // 用 exit 而非 close：npm 会派生 node-gyp/make 等子进程并可能继承管道，
    // 导致 close 在命令真正结束后一直不触发（表现为安装任务卡在"安装中"）
    child.on('exit', (code, sig) => {
      if (buf.trim()) {
        process.stdout.write(`[manager-cmd] ${buf.trim()}\n`); // 同时进容器日志
        onLine(buf);
      }
      if (code === 0) resolve();
      else reject(new Error(`命令退出码 ${code == null ? '信号 ' + sig : code}`));
    });
  });
}

async function installDsh(version, registry) {
  if (installing) return { ok: false, reason: '已有安装任务进行中' };
  installing = true;
  installMeta = { running: true, version, ok: null, done: false };
  broadcast('start', { version });
  let ok = false;
  try {
    const args = ['install', '-g', '--prefix', INSTALL_DIR, '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`];
    emitLog(`> ${NPM_CMD} ${args.join(' ')}`);
    emitLog(`> npm 源: ${registry}`);
    await runCmd(NPM_CMD, args, { ...process.env, NPM_CONFIG_REGISTRY: registry }, line => broadcast('log', { line }));
    if (!isDshInstalled()) throw new Error('安装完成但未找到 dsh 可执行文件，请确认版本号存在');
    const ver = actualVersion();
    state.installedVersion = ver;
    state.requestedVersion = version;
    state.installedAt = new Date().toISOString();
    saveState();
    emitLog(`已安装 DSH ${ver}`);
    ok = true;
  } catch (e) {
    broadcast('log', { line: `[错误] ${e.message}` });
    ok = false;
  }
  installMeta.ok = ok;
  installMeta.done = true;
  installMeta.running = false; // 复位安装中标志，否则页面顶部状态会一直显示「安装中」
  installing = false;
  broadcast('done', { ok, version: actualVersion() });
  if (ok) {
    // 必须先停掉旧进程再启动：bootDsh 有 dshProc 就会直接返回，
    // 否则运行中的仍是旧版本 DSH
    const r = await restartDsh();
    broadcast('boot', { ok: r.ok, reason: r.reason || '' });
  }
  return { ok };
}

// ── 版本列表（npm view，缓存 5 分钟）──────────────────────────
let versionsCache = { key: null, at: 0, data: null };
async function fetchVersions(force = false) {
  const key = effectiveRegistry();
  const now = Date.now();
  if (!force && versionsCache.key === key && now - versionsCache.at < 300000 && versionsCache.data) {
    return versionsCache.data;
  }
  const env = { ...process.env, NPM_CONFIG_REGISTRY: key };
  const out = { distTags: null, list: [], error: null };
  const runView = (arg) => {
    try {
      return spawnSync(NPM_CMD, ['view', '@deepseek-ai/dsh', arg, '--json'], { encoding: 'utf8', env, timeout: 60000 });
    } catch (e) {
      return { status: -1, stdout: '', stderr: e.message };
    }
  };
  const tags = runView('dist-tags');
  if (tags.status === 0) {
    try { out.distTags = JSON.parse(tags.stdout.trim()); } catch { out.distTags = null; }
  } else {
    out.error = String(tags.stderr || tags.stdout || 'npm view dist-tags 失败').trim().split('\n').pop();
  }
  const versions = runView('versions');
  if (versions.status === 0) {
    try {
      const arr = JSON.parse(versions.stdout.trim());
      out.list = Array.isArray(arr) ? arr : [];
    } catch { out.list = []; }
  } else if (!out.error) {
    out.error = String(versions.stderr || versions.stdout || 'npm view versions 失败').trim().split('\n').pop();
  }
  if (out.list.length || out.distTags) versionsCache = { key, at: now, data: out };
  return out;
}

// ── Basic Auth（与旧代理一致）────────────────────────────────
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function checkAuth(req) {
  if (!AUTH_USER || !AUTH_PASS) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  let decoded;
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
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

// ── 反向代理（复用旧代理逻辑）────────────────────────────────
// crypto.randomUUID polyfill：局域网 IP 是非安全上下文，DSH 前端依赖该 API 生成 rpcId
const POLYFILL = '<script>(function(){try{if(typeof crypto!=="undefined"&&crypto&&typeof crypto.randomUUID!=="function"){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h="";for(var i=0;i<16;i++){h+=b[i].toString(16).padStart(2,"0")}return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}}catch(e){}})();</script>';
// 在 DSH 页面注入「管理」悬浮按钮，随时可回到管理员页调整版本
const ADMIN_BUTTON = '<script>(function(){var a=document.createElement("a");a.href="/__admin/";a.textContent="\u2699 \u7ba1\u7406";a.title="DSH \u7248\u672c\u7ba1\u7406";a.style.cssText="position:fixed;right:14px;bottom:14px;z-index:2147483000;padding:8px 14px;background:rgba(15,23,42,.92);color:#fff;border-radius:8px;text-decoration:none;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35)";document.body.appendChild(a)})();</script>';
const HTML_INJECT = POLYFILL + ADMIN_BUTTON;
// isLoopbackHostname 恒真改写：局域网访问也能用设置类功能
const LOOPBACK_JS_NEEDLE = 'isLoopbackHostname(pageLocation.hostname)';
const LOOPBACK_JS_REPLACEMENT = 'true';

const proxy = httpProxy.createProxyServer({ target: TARGET_ORIGIN, ws: true, changeOrigin: true });

proxy.on('proxyRes', (proxyRes, req, res) => {
  const ct = String(proxyRes.headers['content-type'] || '');
  if (proxyRes.headers['content-encoding']) return;
  if (ct.includes('text/html')) {
    delete proxyRes.headers['content-length'];
    res.removeHeader('content-length');
    let injected = false;
    const origWrite = res.write.bind(res);
    res.write = function (chunk, ...rest) {
      if (!injected) {
        injected = true;
        let str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const i = str.toLowerCase().indexOf('<head');
        if (i !== -1) {
          const e = str.indexOf('>', i);
          str = e !== -1 ? str.slice(0, e + 1) + HTML_INJECT + str.slice(e + 1) : HTML_INJECT + str;
        } else {
          str = HTML_INJECT + str;
        }
        chunk = Buffer.from(str);
      }
      return origWrite(chunk, ...rest);
    };
    return;
  }
  if (ct.includes('javascript')) {
    delete proxyRes.headers['content-length'];
    res.removeHeader('content-length');
    const chunks = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    res.write = function (chunk, ...rest) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };
    res.end = function (chunk, ...rest) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      res.write = origWrite;
      res.end = origEnd;
      let body = Buffer.concat(chunks).toString('utf8');
      if (body.includes(LOOPBACK_JS_NEEDLE)) body = body.split(LOOPBACK_JS_NEEDLE).join(LOOPBACK_JS_REPLACEMENT);
      origEnd(Buffer.from(body), ...rest);
    };
  }
});
function alignOrigin(req) {
  if (req.headers.origin) req.headers.origin = TARGET_ORIGIN;
  // 上游开启 gzip 时，压缩响应会让 proxyRes 的 content-encoding 短路，
  // isLoopbackHostname(...) 改写与 polyfill 注入失效；强制上游返回明文。
  delete req.headers['accept-encoding'];
}

// ── 管理员页面 ───────────────────────────────────────────────
let adminHtmlCache = null;
function serveAdmin(res) {
  if (!adminHtmlCache) adminHtmlCache = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(adminHtmlCache);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname, u) {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (pathname === '/__admin/api/state' && req.method === 'GET') {
      const versions = await fetchVersions(false);
      return send(200, {
        installed: state.installedVersion || null,
        requested: state.requestedVersion || null,
        installedAt: state.installedAt || null,
        running: dshReady,
        actual: actualVersion(),
        install: installMeta,
        registry: registryInfo(),
        versions,
      });
    }
    if (pathname === '/__admin/api/versions' && req.method === 'GET') {
      const force = u.searchParams.get('refresh') === '1';
      return send(200, await fetchVersions(force));
    }
    if (pathname === '/__admin/api/registry' && req.method === 'POST') {
      const body = await readJsonBody(req);
      let v = String(body.registry || '').trim();
      if (v === '') {
        delete state.registry;
      } else {
        if (!/^https?:\/\//i.test(v)) return send(400, { ok: false, error: '必须以 http:// 或 https:// 开头的地址' });
        v = v.replace(/\/+$/, '');
        state.registry = v;
      }
      saveState();
      return send(200, { ok: true, registry: registryInfo() });
    }
    if (pathname === '/__admin/api/install' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const version = String(body.version || '').trim();
      if (!version) return send(400, { ok: false, error: '缺少版本号' });
      if (installing) return send(409, { ok: false, error: '已有安装任务进行中' });
      installDsh(version, effectiveRegistry()); // 异步执行，进度走 SSE
      return send(200, { ok: true, started: true, version });
    }
    if (pathname === '/__admin/api/restart' && req.method === 'POST') {
      const r = await restartDsh();
      return send(200, { ok: r.ok, reason: r.reason || '' });
    }
    if (pathname === '/__admin/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res));
      return;
    }
    return send(404, { ok: false, error: '接口不存在' });
  } catch (e) {
    return send(500, { ok: false, error: e.message });
  }
}

// ── HTTP 服务 ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://admin');
  const pathname = u.pathname;
  if (!PUBLIC_PATHS.has(pathname) && !checkAuth(req)) return rejectUnauthorized(res);

  if (pathname === '/__admin' || pathname === '/__admin/') return serveAdmin(res);
  if (pathname.startsWith('/__admin/api/')) return handleApi(req, res, pathname, u);

  // 其余路径：DSH 就绪则反代，否则跳到管理员页
  if (dshReady) {
    // 根目录 GET 走 serveIndex：上游(如官方 0.1.2+)返回 401 时携带 launch token 重发一次
    if (req.method === 'GET' && pathname === '/') {
      const handled = await serveIndex(req, res, { origin: TARGET_ORIGIN, transformHtml: html => injectIntoHead(html, HTML_INJECT) });
      if (handled) return;
    }
    alignOrigin(req);
    return proxy.web(req, res);
  }
  res.writeHead(302, { Location: '/__admin/' });
  res.end();
});

server.on('upgrade', (req, socket, head) => {
  if (!checkAuth(req)) return rejectUpgrade(socket);
  if (!dshReady) {
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    return;
  }
  alignOrigin(req);
  proxy.ws(req, socket, head);
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[manager] 管理服务已启动，监听 0.0.0.0:${LISTEN_PORT}`);
  console.log(`[manager] 管理员页面: http://<host>:${LISTEN_PORT}/__admin/（未安装 DSH 时访问 / 会自动跳转）`);
  console.log(`[manager] npm 源: 默认 ${DEFAULT_REGISTRY}${state.registry ? `，页面已配置 ${state.registry}` : ''}`);
  if (isDshInstalled()) {
    // 镜像预装 / 卷上已有 DSH 时，同步版本到状态，保证页面「当前版本」正常显示
    if (!state.installedVersion) {
      state.installedVersion = actualVersion();
      state.requestedVersion = state.installedVersion;
      saveState();
    }
    bootDsh().then(r => console.log(r.ok ? `[manager] DSH ${actualVersion()} 已就绪` : `[manager] DSH 启动失败: ${r.reason}`));
  } else {
    console.log('[manager] 未检测到已安装的 DSH，请打开管理员页选择版本安装');
  }
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
async function shutdown() {
  console.log('[manager] 收到退出信号，停止 DSH ...');
  await stopDsh();
  process.exit(0);
}
