import urllib.request, json, time
B = "http://127.0.0.1:8123"
def get(p):
    with urllib.request.urlopen(B + p, timeout=5) as r: return json.load(r)
def post(p, body):
    req = urllib.request.Request(B + p, data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=5) as r: return json.load(r)
def inv_rows():
    return get("/api/wms/inventory")["inventory"]

print("=== health ===")
h = get("/api/wms/health"); print("  WMS ok=", h.get("ok"), "mesConnected=", h.get("mesConnected"))

print("=== A) 采购收货 GR → 上架，验证 RCV-01 账实修复 ===")
gr = post("/api/wms/goods-receipt", {"material":"WAFER-300","qty":100,"po":"PO-V2"})
gid = gr["grId"]; print("  GR:", gid)
batch = f"GR-{gid}"
rcv0 = [r for r in inv_rows() if r["batch"]==batch and r["loc_code"]=="RCV-01"]
print("  收货后 RCV-01 该批次库存:", rcv0[0]["qty"] if rcv0 else "无(异常)")
tid = None
for t in get("/api/wms/tasks")["tasks"]:
    if t["type"]=="PUTAWAY" and t["status"]=="OPEN": tid=t["id"]; break
print("  putaway task:", tid, post("/api/wms/putaway", {"taskId":tid,"locCode":"WH-RAW"}))
rcv1 = [r for r in inv_rows() if r["batch"]==batch and r["loc_code"]=="RCV-01"]
print("  上架后 RCV-01 该批次库存:", (rcv1[0]["qty"] if rcv1 else "0 (已清零 ✓)"))

print("=== B) 轮询等待自动上架 PUTAWAY (MES lotDone 驱动) ===")
found=0
for i in range(20):
    tx = get("/api/wms/tx?limit=600")
    cnt = sum(1 for e in tx["tx"] if e["type"]=="PUTAWAY")
    if cnt>0:
        found=cnt; print(f"  ✓ PUTAWAY 在 {i*3}s 出现, count={cnt}"); break
    time.sleep(3)
if not found: print("  ⚠ 超时未出现（生产途中）")

print("=== C) 库存流转自洽 ===")
bl = {b["loc"]: b for b in get("/api/wms/inventory")["byLocation"]}
for loc in ["WH-RAW","STAGE-A","WH-FIN","RCV-01"]:
    if loc in bl: print(f"   {loc}: skus={bl[loc]['skus']} qty={round(bl[loc]['qty'],1)}")
tx = get("/api/wms/tx?limit=1000")
from collections import Counter
print("  tx 类型分布:", dict(Counter(e["type"] for e in tx["tx"])))
print("  说明: WH-RAW 随 PICK 递减(原料出库); STAGE-A 随 PICK 增、随 lotDone 消耗; WH-FIN 随 PUTAWAY 增(成品入库)")
print("DONE")
