// ============================================================
//  六灯 · 进程健康灯（U3）：自举组件，被门户 serveHtml 统一注入所有根级页。
//  固定右下角，轮询 6 进程健康端点（经门户 8123 同源代理，避免 CORS）：
//  门户(8123) / MES(8124) / EAP(8125) / ERP(8126) / Agent(8127) / WMS(8128)。
//  与 twin3d/portal.html 既有六灯共用同一组健康端点，表现一致。
// ============================================================
(function () {
  if (document.getElementById('syslamps')) return;   // 防重复注入
  var box = document.createElement('div');
  box.id = 'syslamps';
  box.setAttribute('role', 'status');
  box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;background:rgba(20,24,33,.92);' +
    'border:1px solid #2a3344;border-radius:10px;padding:9px 11px;font:12px/1.55 system-ui,-apple-system,sans-serif;' +
    'color:#cdd6e4;box-shadow:0 4px 18px rgba(0,0,0,.45);min-width:168px;backdrop-filter:blur(4px)';
  document.body.appendChild(box);

  var PROCS = [
    { n: '门户', u: '/' },            // 门户自身：能取到首页即在线
    { n: 'MES',  u: '/api/health' },
    { n: 'EAP',  u: '/api/eap/health' },
    { n: 'ERP',  u: '/api/erp/health' },
    { n: 'WMS',  u: '/api/wms/health' },
    { n: 'Agent', u: '/api/agent/health' },
    { n: '预测告警', u: '/api/tsdb/pred-alarms', alarm: true },
  ];

  function render() {
    var hasAlarm = false;
    var rows = PROCS.map(function (p) {
      var color, text;
      if (p.alarm) {
        var n = p.alarmCount || 0;
        if (n > 0) hasAlarm = true;
        color = n > 0 ? '#ff5c5c' : '#39d98a';
        text = n > 0 ? (n + ' 条越界') : '正常';
      } else {
        var ok = p.ok, tried = p.tried;
        if (ok) { color = '#39d98a'; text = '在线'; }
        else if (tried) { color = '#ff5c5c'; text = '离线'; }
        else { color = '#f2c14e'; text = '…'; }
      }
      return '<div style="display:flex;justify-content:space-between;gap:14px;white-space:nowrap">' +
        '<span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color +
        ';margin-right:7px;box-shadow:0 0 6px ' + color + '"></i>' + p.n + '</span>' +
        '<span style="color:' + color + '">' + text + '</span></div>';
    }).join('');
    box.style.borderColor = hasAlarm ? '#ff5c5c' : '#2a3344';
    box.innerHTML = '<div style="opacity:.65;font-size:11px;margin-bottom:5px;letter-spacing:.5px">六灯 · 进程健康</div>' + rows;
  }

  function tick() {
    PROCS.forEach(function (p) {
      if (p.alarm) {
        fetch(p.u, { cache: 'no-store' }).then(function (r) {
          if (!r || !r.ok) { p.alarmCount = 0; return; }
          return r.json();
        }).then(function (j) {
          p.alarmCount = (j && Array.isArray(j.alarms)) ? j.alarms.length : 0;
        }).catch(function () { p.alarmCount = 0; });
        return;
      }
      p.tried = true;
      fetch(p.u, { cache: 'no-store' }).then(function (r) { p.ok = (r && r.ok); })
        .catch(function () { p.ok = false; });
    });
    render();
  }

  render(); tick();
  setInterval(tick, 5000);
})();
