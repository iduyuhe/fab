// ============================================================
//  门户静态进程（§6.2 / C11）：仅 serve 静态 HTML（数字孪生页 + 控制台）
//  监听 PORTAL_PORT || 8123。不开 WS 源、不承载 /api/*。
//  孪生页经本进程加载，前端直连 8124 WS 订阅事件流。
//  启动：node portal.js
// ============================================================
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const auth = require('./auth');
const { USER, PASS, COOKIE, createToken, cookieOpts, getUser, GATEWAY } = auth;

const PORTAL_PORT = process.env.PORTAL_PORT || 8123;
const MES_HOST = process.env.MES_HOST || '127.0.0.1';
const MES_PORT = process.env.MES_PORT || 8124;
const EAP_HOST = process.env.EAP_HOST || '127.0.0.1';
const EAP_PORT = process.env.EAP_PORT || 8125;
const AGENT_HOST = process.env.AGENT_HOST || '127.0.0.1';
const AGENT_PORT = process.env.AGENT_PORT || 8127;
const ERP_HOST = process.env.ERP_HOST || '127.0.0.1';
const ERP_PORT = process.env.ERP_PORT || 8126;
const WMS_HOST = process.env.WMS_HOST || '127.0.0.1';
const WMS_PORT = process.env.WMS_PORT || 8128;

// 启动时一次性读入内存，避免异步 I/O 饿死事件循环（同原 server.js 策略）
const PAGES = {
  '/console.html': 'console.html',
  '/portal.html': 'portal.html',
  '/twin.html': 'twin.html',
  '/line-twin.html': 'line-twin.html',
  '/fab-twin.html': 'fab-twin.html',
  '/sim.html': 'sim.html',
  '/agent.html': 'agent.html',
  '/lab.html': 'lab.html',
  '/eap-console.html': 'eap-console.html',
  '/erp-ops.html': 'erp-ops.html',
  '/wms-ops.html': 'wms-ops.html',
  '/config-admin.html': 'config-admin.html',
  '/npi-ops.html': 'npi-ops.html',
  '/otd-flow.html': 'otd-flow.html',
  '/npi-flow.html': 'npi-flow.html',
  '/predict.html': 'predict.html',
  '/login.html': 'login.html',
  '/first-order-sample.html': 'first-order-sample.html',
  '/secs-sample.html': 'secs-sample.html',
  '/data-asset.html': 'data-asset.html',
};
const cache = {};
for (const [route, file] of Object.entries(PAGES)) {
  try { cache[route] = fs.readFileSync(path.join(__dirname, file), 'utf8'); }
  catch (e) { console.log(`[portal] ${file} 读取失败: ${e.message}`); }
}

// 共享业务流导航：按 履约/研发/运维/驾驶舱/工具 分组，取代各页平铺的子系统罗列。
// 由 serveHtml 注入所有根级页，并自动高亮当前页（name → 对应 nav href）。
const NAV_FRAGMENT = `<nav class="unav">
  <a class="unav-brand" href="/portal.html">晶圆厂智能制造平台</a>
  <span class="unav-group">履约流</span>
  <a href="/otd-flow.html">进度墙</a>
  <a href="/erp-ops.html">接单·发运</a>
  <a href="/first-order-sample.html">第一单样品</a>
  <a href="/secs-sample.html">SECS/GEM 联调</a>
  <a href="/console.html">在制</a>
  <a href="/twin.html">量测</a>
  <span class="unav-group">研发流</span>
  <a href="/npi-ops.html">NPI 流片</a>
  <a href="/npi-flow.html">进度墙</a>
  <span class="unav-group">运维流</span>
  <a href="/eap-console.html">EAP</a>
  <a href="/twin.html">装备孪生</a>
  <a href="/agent.html">问答副驾</a>
  <span class="unav-group">数字孪生</span>
  <a href="/fab-twin.html">工厂孪生</a>
  <a href="/line-twin.html">产线孪生</a>
  <a href="/twin3d/">3D 工厂</a>
  <a href="/twin3d/portal.html">3D 角色</a>
  <span class="unav-group">驾驶舱</span>
  <a href="/sim.html">仿真</a>
  <a href="/predict.html">预测·根因</a>
  <a href="/data-asset.html">数据资产·自学习</a>
  <span class="unav-group">工具</span>
  <a href="/wms-ops.html">仓储</a>
  <a href="/config-admin.html">主数据</a>
  <a href="/lab.html">实验台</a>
</nav>
<style>
.unav{position:sticky;top:0;z-index:999;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:8px 14px;background:#0e1530;border-bottom:1px solid #25304f;font:13px/1.4 system-ui,'Segoe UI','Microsoft YaHei',sans-serif}
.unav-brand{font-weight:700;color:#7fd1ff;text-decoration:none;margin-right:6px}
.unav a{color:#cdd6f0;text-decoration:none;padding:3px 8px;border-radius:6px;white-space:nowrap}
.unav a:hover{background:#1a2444;color:#fff}
.unav a.cur{background:#27407a;color:#fff}
</style>`;
const NAV_CUR = {
  'console.html': '/console.html', 'portal.html': '/portal.html', 'twin.html': '/twin.html',
  'line-twin.html': '/line-twin.html', 'fab-twin.html': '/fab-twin.html', 'sim.html': '/sim.html',
  'agent.html': '/agent.html', 'lab.html': '/lab.html', 'eap-console.html': '/eap-console.html',
  'erp-ops.html': '/erp-ops.html', 'wms-ops.html': '/wms-ops.html', 'config-admin.html': '/config-admin.html',
  'npi-ops.html': '/npi-ops.html',
  'otd-flow.html': '/otd-flow.html',
  'npi-flow.html': '/npi-flow.html',
  'predict.html': '/predict.html',
  'first-order-sample.html': '/first-order-sample.html',
  'secs-sample.html': '/secs-sample.html',
  'data-asset.html': '/data-asset.html'
};
function serveHtml(res, html, name) {
  if (html) {
    // 全局共享业务流导航：移除各页自带 unav，统一注入（让分组导航贯穿所有页面，消除"首页改了、子页还是迷宫"）
    let nav = NAV_FRAGMENT;
    const cur = NAV_CUR[name] || '/console.html';
    nav = nav.replace('href="' + cur + '"', 'href="' + cur + '" class="cur"');
    html = html.replace(/<nav class="unav">[\s\S]*?<\/nav>/, '');
    html = html.replace('<body>', '<body>\n' + nav);
    // U3：统一注入六灯进程健康组件（幂等：已含则跳过）
    if (html.indexOf('/health-lamp.js') === -1) {
      html = html.replace('</body>', '<script src="/health-lamp.js"></script>\n</body>');
    }
    // U6：统一注入全站预测告警横幅（幂等：已含则跳过）
    if (html.indexOf('/banner.js') === -1) {
      html = html.replace('</body>', '<script src="/banner.js"></script>\n</body>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html);
  }
  else { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `${name} missing` })); }
}

// 主轴反向代理网关：按 /api/<svc>/ 前缀分流到各微服务（MES/EAP/AGENT/ERP），其余默认 MES。
// 前端统一使用相对 /api/* 路径（同源 8123），经此网关转发，避免跨源 CORS 与连错后端（如 EAP 控制台错连 MES）。
function proxyApi(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  let host = MES_HOST, port = MES_PORT, fwd = u.pathname + u.search;
  if (u.pathname.startsWith('/api/eap/')) {
    host = EAP_HOST; port = EAP_PORT; fwd = u.pathname.replace('/api/eap', '/api') + u.search;
  } else if (u.pathname.startsWith('/api/agent/')) {
    host = AGENT_HOST; port = AGENT_PORT; fwd = u.pathname + u.search;
  } else if (u.pathname.startsWith('/api/erp/')) {
    host = ERP_HOST; port = ERP_PORT; fwd = u.pathname + u.search;
  } else if (u.pathname.startsWith('/api/wms/')) {
    host = WMS_HOST; port = WMS_PORT; fwd = u.pathname + u.search;
  }
  const options = { host, port, method: req.method, path: fwd, headers: { ...req.headers, 'X-Fab-Gateway': GATEWAY } };
  const p = http.request(options, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  p.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream_unreachable', detail: e.message, host, port })); });
  req.pipe(p);
}

// ===== P0 基础鉴权（信任门槛）=====
// 公开资源：登录页本身、/api/auth/* 鉴权端点、静态资源（css/js/png…）免登录；
// 其余（业务页面 / /api/* 业务接口 / /twin3d/* / WS 隧道）一律要求登录。
const STATIC_RE = /\.(css|js|mjs|json|svg|png|jpe?g|ico|woff2?|map|gltf|glb|bin)$/i;
function isPublic(route) {
  if (route === '/login.html') return true;
  if (route.startsWith('/api/auth/')) return true;
  if (STATIC_RE.test(route)) return true;
  return false;
}
function handleAuth(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  if (p === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let c = {}; try { c = JSON.parse(body || '{}'); } catch {}
      if (c.user === USER && c.pass === PASS) {
        const tok = createToken(c.user);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${COOKIE}=${tok}; ${cookieOpts()}` });
        return res.end(JSON.stringify({ ok: true, user: c.user }));
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid_credentials' }));
    });
    return;
  }
  if (p === '/api/auth/logout') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0` });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (p === '/api/auth/me') {
    const user = getUser(req);
    res.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(user ? { ok: true, user } : { ok: false }));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}
// 返回 true 表示已放行；false 表示已拦截并写出响应
function gate(req, res, route, u) {
  if (getUser(req)) return true;
  if (route.startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  const next = encodeURIComponent(route + (u.search || ''));
  res.writeHead(302, { 'Location': `/login.html?next=${next}` });
  res.end();
  return false;
}

// ===== 样品复现 API（门户本地处理，不转发）=====
// POST /api/sample/{first-order|secs}/run    → 后台复现（spawn 对应 .mjs，立即返回）
// GET  /api/sample/{first-order|secs}/status  → 轮询状态（running / last 结果）
const sampleDefs = {
  'first-order': { file: 'first-order.mjs', statusFile: path.join(__dirname, 'first-order.status.json'), getProc: () => sampleProc, setProc: c => { sampleProc = c; } },
  'secs': { file: 'secs-demo.mjs', statusFile: path.join(__dirname, 'secs.status.json'), getProc: () => secsProc, setProc: c => { secsProc = c; } },
};
let sampleProc = null, secsProc = null;
function serveSampleApi(req, res, u) {
  const p = u.pathname;
  const m = p.match(/^\/api\/sample\/([\w-]+)\/(run|status)$/);
  if (!m) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
  const kind = m[1], action = m[2];
  const def = sampleDefs[kind];
  if (!def) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'unknown sample' })); }
  if (action === 'run' && req.method === 'POST') {
    const proc = def.getProc();
    const busy = proc && !proc.killed && proc.exitCode === null;
    if (busy) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, msg: '已有复现任务在运行中，请稍候' })); }
    try {
      fs.writeFileSync(def.statusFile, JSON.stringify({ running: true, startedAt: Date.now() }));
      const child = spawn(process.execPath, [def.file], { cwd: __dirname, stdio: 'ignore', detached: true });
      child.unref();
      def.setProc(child);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, pid: child.pid, msg: '复现任务已启动' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
  if (action === 'status' && req.method === 'GET') {
    const proc = def.getProc();
    const running = !!(proc && !proc.killed && proc.exitCode === null);
    let last = null;
    try { last = JSON.parse(fs.readFileSync(def.statusFile, 'utf8')); } catch (_) {}
    if (last && last.running && !running) last = Object.assign({}, last, { running: false, crashed: true });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ running, last }));
  }
  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'method not allowed' }));
}

const handler = (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const route = u.pathname;
  // 鉴权端点（免登录）
  if (route.startsWith('/api/auth/')) return handleAuth(req, res);
  // 公开资源直接放行（登录页走专门 serveHtml）
  if (isPublic(route)) {
    if (route === '/login.html') return serveHtml(res, cache['/login.html'], 'login.html');
  } else if (!gate(req, res, route, u)) {
    return;
  }
  // 样品复现 API（门户本地处理，不转发到 MES）
  if (route.startsWith('/api/sample/')) return serveSampleApi(req, res, u);
  // 主轴反向代理：/api/* 与 WebSocket 统一转发到 MES(8124)，使 2D 孪生/控制台相对路径真正连上数据
  if (route.startsWith('/api/')) return proxyApi(req, res);
  // U3：六灯进程健康组件（被 serveHtml 注入所有根级页）
  if (route === '/health-lamp.js') {
    fs.readFile(path.join(__dirname, 'health-lamp.js'), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(data);
    });
    return;
  }
  // U6：全站预测告警横幅组件（被 serveHtml 注入所有根级页）
  if (route === '/banner.js') {
    fs.readFile(path.join(__dirname, 'banner.js'), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(data);
    });
    return;
  }
  // 数字孪生（装备级）：twin.html / 兼容旧的伪入口 ?src=mes
  if (route === '/twin.html' || (route === '/' && u.searchParams.get('src') === 'mes')) {
    return serveHtml(res, cache['/twin.html'], 'twin.html');
  }
  if (route === '/line-twin.html') return serveHtml(res, cache['/line-twin.html'], 'line-twin.html');
  if (route === '/fab-twin.html') return serveHtml(res, cache['/fab-twin.html'], 'fab-twin.html');
  if (route === '/sim.html') return serveHtml(res, cache['/sim.html'], 'sim.html');
  if (route === '/agent.html') return serveHtml(res, cache['/agent.html'], 'agent.html');
  if (route === '/lab.html') return serveHtml(res, cache['/lab.html'], 'lab.html');
  if (route === '/portal.html') return serveHtml(res, cache['/portal.html'], 'portal.html');
  if (route === '/eap-console.html') return serveHtml(res, cache['/eap-console.html'], 'eap-console.html');
  // ERP 原生制造操作台（库存/采购/销售/成本，由门户代理 /api/erp/* 转发 8126）
  if (route === '/erp-ops.html') return serveHtml(res, cache['/erp-ops.html'], 'erp-ops.html');
  // WMS 原生仓储操作台（库位/批次/上架/齐套/收发流水，由门户代理 /api/wms/* 转发 8128）
  if (route === '/wms-ops.html') return serveHtml(res, cache['/wms-ops.html'], 'wms-ops.html');
  // 主数据配置管理台（产品/物料/BOM/费率/供应商/客户，由门户代理 /api/erp/config/* 转发 8126）
  if (route === '/config-admin.html') return serveHtml(res, cache['/config-admin.html'], 'config-admin.html');
  // NPI 设计到流片管理台（设计档案/光罩/工程批/流片，由门户代理 /api/npi/* 与 /api/designs 转发 8124）
  if (route === '/npi-ops.html') return serveHtml(res, cache['/npi-ops.html'], 'npi-ops.html');
  // OTD 履约流进度墙（一屏看全接单→回款 + 卡点识别，由门户代理 /api/erp/* 与 /api/wip 转发）
  if (route === '/otd-flow.html') return serveHtml(res, cache['/otd-flow.html'], 'otd-flow.html');
  if (route === '/first-order-sample.html') return serveHtml(res, cache['/first-order-sample.html'], 'first-order-sample.html');
  if (route === '/secs-sample.html') return serveHtml(res, cache['/secs-sample.html'], 'secs-sample.html');
  if (route === '/data-asset.html') return serveHtml(res, cache['/data-asset.html'], 'data-asset.html');
  if (route === '/npi-flow.html') return serveHtml(res, cache['/npi-flow.html'], 'npi-flow.html');
  if (route === '/predict.html') return serveHtml(res, cache['/predict.html'], 'predict.html');

  // 3D 数字孪生（fab-digital-twin 并入后的统一入口）：/twin3d/ 托管整个子目录
  if (route === '/twin3d' || route === '/twin3d/' || route.startsWith('/twin3d/')) {
    return serveTwin3d(u, res);
  }

  // 控制台（默认首页）
  if (route === '/' || route === '/console.html') return serveHtml(res, cache['/console.html'], 'console.html');
  // U5：报告类文档 + 主题静态兜底（受限白名单 + 路径穿越防护，不暴露 .js 源码）
  if (/\.(html|css|json|svg|png|jpe?g|ico|woff2?|map)$/i.test(route)) {
    return serveStaticAsset(route, res);
  }
  res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: 'not found' }));
};

// ---- 3D 数字孪生静态托管（twin3d/ 子目录）----
const TWIN3D_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.gltf': 'model/gltf+json; charset=utf-8', '.glb': 'model/gltf-binary',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.bin': 'application/octet-stream',
};
function serveTwin3d(u, res) {
  let rel = decodeURIComponent(u.pathname.replace(/^\/twin3d\/?/, ''));
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  // 路径穿越防护
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, 'twin3d', safe);
  if (!filePath.startsWith(path.join(__dirname, 'twin3d'))) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 无扩展名时回退到 index.html（前端路由）
      if (!path.extname(safe)) {
        fs.readFile(path.join(__dirname, 'twin3d', 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
          res.writeHead(200, { 'Content-Type': TWIN3D_MIME['.html'], 'Cache-Control': 'no-store' }); res.end(d2);
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': TWIN3D_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// U5：受限静态兜底（仅白名单扩展名 + 穿越防护），用于 serve 报告类文档与 theme.css，不暴露 .js/.mjs 源码
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};
function serveStaticAsset(route, res) {
  const rel = decodeURIComponent(route.replace(/^\/+/, ''));
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const fp = path.join(__dirname, safe);
  if (!fp.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': STATIC_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(handler);
// WS 隧道：把门户(8123)上的 WebSocket 升级请求转发到 MES(8124) 唯一 WS 源，使 2D 孪生实时订阅打通
server.on('upgrade', (req, clientSocket, head) => {
  if (!getUser(req)) {
    clientSocket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return clientSocket.destroy();
  }
  // 副驾 WebSocket（问答主动推送）走 Agent(8127)；其余事件流 WS 走 MES(8124) 唯一源
  const u = new URL(req.url, 'http://' + req.headers.host);
  const toAgent = u.pathname.startsWith('/api/agent/');
  const TPORT = toAgent ? AGENT_PORT : MES_PORT;
  const THOST = toAgent ? AGENT_HOST : MES_HOST;
  const target = net.connect(TPORT, THOST, () => {
    target.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === 'proxy-connection') continue;
      target.write(`${k}: ${v}\r\n`);
    }
    target.write('\r\n');
    if (head && head.length) target.write(head);
  });
  target.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => target.destroy());
  target.pipe(clientSocket);
  clientSocket.pipe(target);
});
server.listen(PORTAL_PORT, () => {
  console.log(`fab-portal (数字孪生门户) 已启动 [阶段0 多进程拆分]`);
  console.log(`  静态页 : http://127.0.0.1:${PORTAL_PORT}/  (console / twin / line-twin / fab-twin / sim / twin3d)`);
  console.log(`  事件源 : 前端请连 ws://127.0.0.1:${process.env.PORT || 8124}  (唯一 WS 源在 MES 主进程)`);
});
