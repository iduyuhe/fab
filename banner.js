// ============================================================
//  全站预测告警横幅（U6）：被门户 serveHtml 统一注入所有根级页。
//  轮询 /api/tsdb/pred-alarms（经门户 8123 同源代理到 MES 8124），
//  一旦发现预测越界告警即常驻顶部红色横幅（全站可见），并附"查看数据资产/忽略"。
//  与右下六灯、副驾主动推送共用同一告警源，表现一致。
// ============================================================
(function () {
  if (document.getElementById('pred-banner')) return;   // 防重复注入

  // 横幅置于 body 首个子节点（在注入的 unav 之上，正常文档流推进，不遮挡 sticky 导航）
  var bar = document.createElement('div');
  bar.id = 'pred-banner';
  bar.setAttribute('role', 'alert');
  bar.style.cssText = 'display:none;width:100%;box-sizing:border-box;' +
    'background:linear-gradient(90deg,#7a1020,#b21f2d);color:#fff;' +
    'padding:9px 16px;font:13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;' +
    'display:flex;align-items:center;gap:14px;flex-wrap:wrap;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.35);z-index:10002;' +
    'animation:predBannerPulse 1.6s ease-in-out infinite';
  bar.innerHTML =
    '<style>@keyframes predBannerPulse{0%,100%{background:linear-gradient(90deg,#7a1020,#b21f2d)}50%{background:linear-gradient(90deg,#9a1428,#d62839)}}' +
    '#pred-banner a{color:#ffe08a;text-decoration:none;border-bottom:1px dotted #ffe08a}#pred-banner a:hover{color:#fff}' +
    '#pred-banner .pb-msg{flex:1;min-width:240px;font-weight:600}' +
    '#pred-banner .pb-x{margin-left:auto;cursor:pointer;background:rgba(255,255,255,.18);border:none;color:#fff;' +
    'border-radius:6px;padding:3px 10px;font-size:12px}' +
    '#pred-banner .pb-x:hover{background:rgba(255,255,255,.32)}</style>' +
    '<span style="font-size:16px">⚠</span>' +
    '<span class="pb-msg" id="pb-msg"></span>' +
    '<a href="/data-asset.html" target="_blank" style="white-space:nowrap">查看数据资产 →</a>' +
    '<a href="/agent.html" target="_blank" style="white-space:nowrap">问副驾 →</a>' +
    '<button class="pb-x" id="pb-x">忽略</button>';

  document.body.insertBefore(bar, document.body.firstChild);

  var msgEl = document.getElementById('pb-msg');
  var xEl = document.getElementById('pb-x');
  var dismissedSig = null;   // 已忽略的告警签名（同签名不再自动弹出）

  function sigOf(list) {
    return list.map(function (a) { return a.ts + '|' + a.metric + '|' + (a.product || '') + '|' + (a.tool || '') + '|' + a.firstStep; }).sort().join(',');
  }
  function fmt(a) {
    var where = [a.metric, a.product, a.tool].filter(Boolean).join('/');
    return where + ' 预测第' + a.firstStep + '步' + (a.level === 'bad' ? '越界' : '触限');
  }

  function render(list) {
    if (!list || !list.length) { bar.style.display = 'none'; dismissedSig = null; return; }
    var sig = sigOf(list);
    if (sig === dismissedSig) { bar.style.display = 'none'; return; }
    var head = '预测告警 · 共 ' + list.length + ' 条越界：';
    var items = list.slice(0, 4).map(fmt).join('；');
    if (list.length > 4) items += ' …';
    msgEl.textContent = head + items;
    bar.style.display = 'flex';
  }

  xEl.onclick = function () {
    // 忽略当前告警集合（新告警仍会弹出）
    dismissedSig = sigOf(currentList);
    bar.style.display = 'none';
  };

  var currentList = [];
  function tick() {
    fetch('/api/tsdb/pred-alarms?limit=30', { cache: 'no-store' })
      .then(function (r) { if (!r || !r.ok) throw new Error('http ' + (r && r.status)); return r.json(); })
      .then(function (j) {
        currentList = (j && Array.isArray(j.alarms)) ? j.alarms : [];
        render(currentList);
      })
      .catch(function () { /* 未登录/接口不可达：不显示横幅 */ });
  }
  tick();
  setInterval(tick, 5000);
})();
