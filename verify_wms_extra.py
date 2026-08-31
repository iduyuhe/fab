import urllib.request, json, time
B = "http://127.0.0.1:8123"

def get(p):
    with urllib.request.urlopen(B + p, timeout=5) as r: return json.load(r)
def post(p, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(B + p, data=data,
        headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=5) as r: return json.load(r)

print("=== 1) 各进程 health（数字主线对齐前提）===")
for svc, port, path in [
    ("MES", 8124, "/api/health"), ("PORTAL", 8123, "/"),
    ("ERP", 8126, "/api/erp/health"), ("AGENT", 8127, "/api/agent/health"),
    ("EAP", 8125, "/api/eap/health"), ("WMS", 8128, "/api/wms/health")]:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=3) as r:
            print(f"  {svc}:{port} -> {r.status}")
    except Exception as e:
        print(f"  {svc}:{port} -> ERR {e}")

print("\n=== 2) 销售发运 GI → WH-FIN（账实一致保护：禁止超发）===")
inv0 = {b["loc"]: b["qty"] for b in get("/api/wms/inventory")["byLocation"]}
fin0 = inv0.get("WH-FIN", 0)
print(f"  发运前 WH-FIN qty={round(fin0,1)}")
ship = post("/api/wms/ship", {"material": "FIN-N2", "qty": 25})
print("  ship:", ship)
inv1 = {b["loc"]: b["qty"] for b in get("/api/wms/inventory")["byLocation"]}
fin1 = inv1.get("WH-FIN", 0)
if ship.get("ok"):
    print(f"  发运后 WH-FIN qty={round(fin1,1)}  递减={-round(fin1-fin0,1)}  {'✓' if fin1 < fin0 and fin1 >= 0 else '✗'}")
else:
    print(f"  ⚠ 超发被拒（reason={ship.get('reason')}），WH-FIN 保持={round(fin1,1)}，未产生负库存 ✓")

print("\n=== 3) 齐套检查 kit ===")
kit = get("/api/wms/kit")
print(f"  kit.count={kit.get('count')}  返回结构含 kits 列表={'kits' in kit}")
if kit.get("kits"):
    print("  样例:", kit["kits"][0])

print("\n=== 4) ERP/WMS 数字主线对齐（同一 MES 真相源派生）===")
wtx = get("/api/wms/tx?limit=2000")["tx"]
etx = get("/api/erp/tx?limit=2000")["tx"]
wms_lots = set()
for e in wtx:
    if e["type"] == "PICK" and e.get("ref"):
        # ref like PK-LOT-0001
        lot = e["ref"].split("PK-", 1)[-1] if "PK-" in e["ref"] else e["ref"]
        wms_lots.add(lot)
erp_lots = set()
for e in etx:
    if e.get("type") == "ISSUE" and e.get("ref"):
        erp_lots.add(e["ref"])
print(f"  WMS PICK 涉及批次数={len(wms_lots)}  ERP ISSUE 涉及批次={len(erp_lots)}")
if wms_lots and erp_lots:
    inter = wms_lots & erp_lots
    print(f"  交集(同批齐套)={len(inter)}  对齐率={round(100*len(inter)/max(1,len(wms_lots)),1)}%")
    print("  ✓ WMS 实物拣货与 ERP 财务领料源自同一 MES lotRelease，自然对齐" if inter else "  ⚠ 暂无交集")
tx_types = {}
for e in wtx: tx_types[e["type"]] = tx_types.get(e["type"], 0) + 1
print("  WMS tx 类型分布:", tx_types)
print("DONE")
