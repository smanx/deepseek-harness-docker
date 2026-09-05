// 上游自动授权（前向兼容官方 DSH 0.1.2+ 的 launch-token 机制）。
//
// 设计目标：token 完全由本镜像处理，LAN 用户经 Basic Auth 通过后，不再需要任何额外动作。
// 关键点：绝不在每次转发时注入 token——官方模型是「launch token 换取浏览器会话 cookie」，
// 若每请求都带 token，上游会为每个请求签发一个全新身份，出现身份错乱。
const fs = require('fs');

const LOG_FILE = process.env.DSH_WEB_LOG || '/app/.dsh-web.log';
const TOKEN_FILE_AUTO = process.env.DSH_TOKEN_FILE_AUTO || '/app/.dsh-launch-token';
// 官方 DSH 0.1.2+ 的 launch token 通过「首页 URL 上的 ?token=」传入（见 dsh web 打印的
// 地址格式），换取会话 cookie；不接受把 token 放请求头，因此这里用 query 追加。
const TOKEN_QUERY_KEY = process.env.DSH_TOKEN_QUERY_KEY || 'token';

const HARD_TOKEN = process.env.DSH_TOKEN || '';
const HARD_TOKEN_FILE = process.env.DSH_TOKEN_FILE || '';

let PATTERN = null;
if (process.env.DSH_LAUNCH_TOKEN_PATTERN) {
  try { PATTERN = new RegExp(process.env.DSH_LAUNCH_TOKEN_PATTERN); } catch {}
}
const DEFAULT_TOKEN_RE = /(?:[?&,]|^)token[=:]\s*["']?([A-Za-z0-9._~-]{16,})/i;

let state = { token: '', source: null, scanning: false, attempts: 0, done: false };
const SCAN_INTERVAL = 2000;
const MAX_SCAN_ATTEMPTS = 30;

function readTail(p, maxBytes) {
  try {
    const st = fs.statSync(p);
    if (!st.size) return '';
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

// 返回文本中 regex 的【最后一个】匹配（日志里可能有多次启动打印的旧 token，
// 越新的打印越靠后，取最后一个即当前最新 token），无匹配返回 null。
function lastMatch(text, regex) {
  let re;
  try {
    re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  } catch {
    return null;
  }
  let last = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    last = m;
    if (m[0] === '') re.lastIndex += 1;
  }
  return last;
}

// token 去敏：仅保留头尾 4 个字符，中间用 * 填充，便于日志排查又不泄露完整 token
function maskToken(t) {
  const s = String(t || '');
  if (s.length <= 8) return s ? s.slice(0, 1) + '****' : '(empty)';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

// 从日志文本中提取最新（末尾）的 launch token
function extractFromText(text) {
  if (PATTERN) {
    const m = lastMatch(text, PATTERN);
    if (m) return (m[1] !== undefined ? m[1] : m[0]).trim();
  }
  const m = lastMatch(text, DEFAULT_TOKEN_RE);
  return m ? m[1] : null;
}

// 打捞一次：读 DSH 日志尾部提取 token，命中则落盘到 TOKEN_FILE_AUTO
function scanOnce() {
  const token = extractFromText(readTail(LOG_FILE, 512 * 1024));
  if (token) {
    const t = token.trim();
    try { fs.writeFileSync(TOKEN_FILE_AUTO, t); } catch {}
    state.token = t;
    state.source = 'auto';
    state.done = true;
    console.log(`[upstream-token] 已自动捕获 DSH launch token（长度 ${t.length}），仅用于根目录 401 时换取会话`);
    return t;
  }
  return null;
}

function readHardToken() {
  if (HARD_TOKEN) return HARD_TOKEN;
  if (HARD_TOKEN_FILE) {
    try { return fs.readFileSync(HARD_TOKEN_FILE, 'utf8').trim(); } catch {}
  }
  return '';
}

// 确保已拿到 token：优先手工，其次自动打捞（必要时启动周期性轮询）
function ensureToken() {
  if (state.done && state.token) return state.token;
  const hard = readHardToken();
  if (hard) {
    state.token = hard;
    state.source = 'manual';
    state.done = true;
    return hard;
  }
  const fromLog = scanOnce();
  if (fromLog) return fromLog;
  if (state.scanning) return state.token;
  if (state.attempts >= MAX_SCAN_ATTEMPTS) {
    state.done = true;
    return '';
  }
  state.scanning = true;
  const timer = setInterval(() => {
    const t = scanOnce();
    state.attempts += 1;
    if (t || state.attempts >= MAX_SCAN_ATTEMPTS) {
      clearInterval(timer);
      state.scanning = false;
      state.done = true;
    }
  }, SCAN_INTERVAL);
  timer.unref();
  return state.token;
}

// 版本探测：供诊断与后续按版本细化判断；一般不需要
const VERSION_PATHS = [
  process.env.DSH_VERSION,
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
  '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json',
];
function detectDshVersion() {
  for (const p of VERSION_PATHS) {
    if (!p) continue;
    if (String(p).includes('package.json')) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || null; } catch {}
    } else {
      return p;
    }
  }
  return null;
}

// ── 根目录授权引导（401 → 带 token 重发 → 透传 set-cookie）─────────
const FORWARD_HEADERS = [
  'accept', 'accept-language', 'user-agent', 'cookie', 'referer',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
];
function pickIndexHeaders(req) {
  const src = req.headers || {};
  const out = { accept: '*/*', 'accept-encoding': 'identity' };
  for (let i = 0; i < FORWARD_HEADERS.length; i++) {
    const n = FORWARD_HEADERS[i];
    if (src[n]) out[n] = src[n];
  }
  return out;
}

async function fetchRaw(origin, headers, path) {
  const url = path && path !== '/' ? origin + path : origin + '/';
  const res = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
  const getSetCache = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return {
    status: res.status,
    headers: res.headers,
    setCookies: Array.isArray(getSetCache) ? getSetCache : [],
    body: await res.text(),
  };
}

// 把 HTML 内容注入一段脚本，插入到第一个 <head> 之后（无则插到最前）。
function injectIntoHead(content, snippet) {
  const i = content.toLowerCase().indexOf('<head');
  if (i !== -1) {
    const e = content.indexOf('>', i);
    return e !== -1 ? content.slice(0, e + 1) + snippet + content.slice(e + 1) : snippet + content;
  }
  return snippet + content;
}

// 把上游响应整体透传给浏览器（保留 set-cookie 供浏览器建立会话；对 html 做注入改写）。
function sendRaw(r, res, transformHtml) {
  const hs = {};
  for (const [k, v] of r.headers) {
    const lk = k.toLowerCase();
    if (['content-length', 'content-encoding', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'set-cookie'].includes(lk)) continue;
    hs[k] = v;
  }
  hs['Cache-Control'] = hs['Cache-Control'] || 'no-store';
  if (r.setCookies.length) hs['Set-Cookie'] = r.setCookies;

  let body = r.body;
  const ct = String(r.headers.get ? r.headers.get('content-type') : '').toLowerCase();
  if (ct.includes('text/html') && transformHtml) body = transformHtml(body);
  hs['Content-Type'] = ct || 'text/html; charset=utf-8';

  res.writeHead(r.status, hs);
  res.end(body);
  return true;
}

// 处理根目录 GET：正常情况下直接转发；上游返回 401 时携带 launch token 重发一次，
// 并把上游（重试）返回的 set-cookie 透传给浏览器，此后浏览器自动携带 cookie 通过认证。
// 返回 true 表示已接管响应；返回 false 表示出现异常，调用方应回退到普通反向代理。
async function serveIndex(req, res, ctx) {
  const origin = ctx.origin;
  const transformHtml = ctx.transformHtml;
  const reqUrl = req.url || '/';
  let first;
  try {
    first = await fetchRaw(origin, pickIndexHeaders(req), reqUrl);
  } catch {
    return false;
  }
  if (first.status === 401) {
    const token = ensureToken();
    if (token) {
      console.log(`[upstream-token] 根目录首次请求返回 401，尝试携带 launch token（${maskToken(token)}）重发以换取会话 cookie`);
      // 官方格式：把 launch token 追加进根目录 URL 的 query，换取上游会话 cookie
      const sep = reqUrl.includes('?') ? '&' : '?';
      const authUrl = `${reqUrl}${sep}${TOKEN_QUERY_KEY}=${encodeURIComponent(token)}`;
      let retry;
      try { retry = await fetchRaw(origin, pickIndexHeaders(req), authUrl); } catch { retry = null; }
      if (retry) {
        const sc = retry.setCookies.length;
        console.log(`[upstream-token] 携带 token 重发 → 上游返回 ${retry.status}，下发 ${sc} 个会话 cookie`);
        if (retry.status === 401) {
          console.log(`[upstream-token] 自动登录失败：携带 launch token（${maskToken(token)}）重发仍返回 401（token 可能已过期/失效，或该上游版本不支持 query token 方式）`);
        }
        return sendRaw(retry, res, transformHtml);
      }
      console.log('[upstream-token] 携带 token 重发失败（网络异常或上游无响应），回退透传首次 401');
    } else {
      console.log('[upstream-token] 未获取到 launch token，跳过重发，透传首次 401');
    }
  } else if (first.status !== 200) {
    console.log(`[upstream-token] 根目录首次请求返回 ${first.status}（非 401），直接透传`);
  }
  return sendRaw(first, res, transformHtml);
}

module.exports = { serveIndex, ensureToken, injectIntoHead, detectDshVersion };