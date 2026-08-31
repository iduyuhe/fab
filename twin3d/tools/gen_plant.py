# -*- coding: utf-8 -*-
"""
晶圆厂数字孪生 · 程序化厂房生成器
================================
在没有真实 BIM / 点云的情况下, 用公开设备外形尺寸 + 工艺布局规则,
程序化生成一栋"足够真实"的多层晶圆厂 glTF, 供 index.html?model= 直接加载。

输出 (位于本脚本上一级目录):
  fab-plant.gltf          自包含 data-URI buffer 的 glTF 2.0 场景
  fab-plant.manifest.json 设备命名 -> 模块 / wph 绑定规则 (命名约定已可零清单绑定)

命名约定 (无需 manifest 也能自动绑定):
  EUV_xx  -> LITHO 光刻   (EUV 扫描机, ~10m)
  ETCH_xx -> ETCH 刻蚀
  CVD_xx  -> DEP  薄膜沉积
  CMP_xx  -> CMP  化学机械抛光
  IMP_xx  -> IMPL 离子注入
  MET_xx  -> METRO 量测检测
结构网格 (FLOOR / AMHS_* / UTIL_* / STR_*) 不绑定, 仅可视化。

运行: python tools/gen_plant.py
"""
import base64, json, struct, math, os

# ----------------------------- 配置 -----------------------------
# 模块: (命名前缀, 模块key, 设备台数, 原型类型, 网格间距m, 示意wph)
MODULES = [
    ("EUV",  "LITHO", 14, "EUV", 11.0, 30),   # 光刻最贵最难, 数量最少
    ("ETCH", "ETCH",  42, "STD",  6.0, 80),
    ("CVD",  "DEP",   54, "STD",  6.0, 60),
    ("CMP",  "CMP",   26, "STD",  6.0, 70),
    ("IMP",  "IMPL",  22, "STD",  6.5, 55),
    ("MET",  "METRO", 34, "MET",  5.0, 120),
]
MODULE_COLS   = 3        # 模块大区排成 3 列 x 2 行
BLOCK_PITCH_X = 95.0     # 模块大区水平间距 (含通道)
BLOCK_PITCH_Z = 95.0     # 模块大区纵深间距
AMHS_Y        = 15.0     # AMHS 天车层高度
UTIL_Y        = -4.0     # 地下 utility 管廊层高度
PAD           = 14.0     # 大区外扩留白

MODULE_HEX = {"LITHO":"ff5c8a","ETCH":"4ea1ff","DEP":"57d6a6","CMP":"f2c14e","IMPL":"b98cff","METRO":"ff9f5c"}
def col(hexc, a=1.0):
    return [int(hexc[0:2],16)/255, int(hexc[2:4],16)/255, int(hexc[4:6],16)/255, a]

# ------------------------- 几何工具 -------------------------
def collect_mesh(boxes):
    bp, bn, bi = [], [], []
    def add(w,h,d,cx,cy,cz):
        x0,x1 = cx-w/2, cx+w/2; y0,y1 = cy-h/2, cy+h/2; z0,z1 = cz-d/2, cz+d/2
        quads = [
            ((x1,y0,z0),(x1,y0,z1),(x1,y1,z1),(x1,y1,z0),(1,0,0)),
            ((x0,y0,z1),(x0,y0,z0),(x0,y1,z0),(x0,y1,z1),(-1,0,0)),
            ((x0,y1,z0),(x0,y1,z1),(x1,y1,z1),(x1,y1,z0),(0,1,0)),
            ((x0,y0,z1),(x0,y0,z0),(x1,y0,z0),(x1,y0,z1),(0,-1,0)),
            ((x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1),(0,0,1)),
            ((x1,y0,z0),(x0,y0,z0),(x0,y1,z0),(x1,y1,z0),(0,0,-1)),
        ]
        b = len(bp)//3
        for (a,b2,c,d_,n) in quads:
            for p in (a,b2,c,d_): bp.extend(p); bn.extend(n)
        bi.extend([b,b+1,b+2,b,b+2,b+3])
    for box in boxes: add(*box)
    xs=[v for i,v in enumerate(bp) if i%3==0]; ys=[v for i,v in enumerate(bp) if i%3==1]; zs=[v for i,v in enumerate(bp) if i%3==2]
    return bp, bn, bi, (min(xs),min(ys),min(zs)), (max(xs),max(ys),max(zs))

def proto_std():   # 标准设备: 底座 + 机柜 + 顶盖
    return [(4.6,0.3,4.8, 0,0.15,0), (4.2,4.0,4.6, 0,2.30,0), (4.4,0.3,4.8, 0,4.55,0)]
def proto_euv():   # EUV: 大底座 + 主机 + 镜筒
    return [(9.6,0.5,9.6, 0,0.25,0), (9.0,8.5,9.0, 0,4.75,0), (2.6,1.6,2.6, 0,9.80,0)]
def proto_met():   # 量测: 较小
    return [(3.4,0.3,3.4, 0,0.15,0), (3.0,3.0,3.0, 0,1.80,0), (3.2,0.2,3.4, 0,3.40,0)]
PROTO = {"STD": proto_std, "EUV": proto_euv, "MET": proto_met}

# ------------------------- 装配 -------------------------
materials = []
meshes    = []   # {name, pos, nrm, idx, mn, mx, mat_name}
nodes     = []

def add_mesh(name, boxes, mat_name):
    bp, bn, bi, mn, mx = collect_mesh(boxes)
    meshes.append({"name":name, "pos":bp, "nrm":bn, "idx":bi, "mn":mn, "mx":mx, "mat_name":mat_name})

def add_material(name, hexc):
    materials.append({"name":name, "pbrMetallicRoughness":{"baseColorFactor":col(hexc),"metallicFactor":0.25,"roughnessFactor":0.7}})
    return len(materials)-1

# 1) 设备层: 每模块一个 mesh (原型几何 + 模块色), 设备为 node (引用 mesh + translation)
mod_mesh_idx = {}
for (prefix, key, count, ptype, spacing, wph) in MODULES:
    mat_name = key
    add_material(mat_name, MODULE_HEX[key])
    m_idx = len(meshes)
    add_mesh("m_"+key, PROTO[ptype](), mat_name)
    mod_mesh_idx[key] = m_idx
    mc = MODULES.index((prefix,key,count,ptype,spacing,wph)) % MODULE_COLS
    mr = MODULES.index((prefix,key,count,ptype,spacing,wph)) // MODULE_COLS
    bx = (mc - (MODULE_COLS-1)/2) * BLOCK_PITCH_X
    bz = (mr - 0.5) * BLOCK_PITCH_Z
    cols = max(1, math.ceil(math.sqrt(count)))
    rows = math.ceil(count/cols)
    for i in range(count):
        c = i % cols; r = i // cols
        lx = (c - (cols-1)/2) * spacing
        lz = (r - (rows-1)/2) * spacing
        seq = i + 1
        nodes.append({"name": f"{prefix}_{seq:02d}", "mesh": m_idx, "translation":[round(bx+lx,2), 0.0, round(bz+lz,2)]})

# 2) 地板
plant_w = MODULE_COLS * BLOCK_PITCH_X + PAD*2
plant_d = 2 * BLOCK_PITCH_Z + PAD*2
add_material("FLOOR","1f2a38")
add_mesh("FLOOR", [(plant_w,0.4,plant_d, 0,-0.2,0)], "FLOOR")
nodes.append({"name":"FLOOR", "mesh": len(meshes)-1})

# 3) AMHS 天车层: 环形轨道 + 天车
add_material("AMHS","73859c")
rx, rz = plant_w/2 - 8, plant_d/2 - 8
add_mesh("AMHS_RAIL", [
    (2*rx,0.6,0.6, 0,AMHS_Y,-rz),(2*rx,0.6,0.6, 0,AMHS_Y,rz),
    (0.6,0.6,2*rz,-rx,AMHS_Y,0),(0.6,0.6,2*rz, rx,AMHS_Y,0)], "AMHS")
nodes.append({"name":"AMHS_RAIL","mesh":len(meshes)-1})
veh = []
for k in range(12):
    ang = k/12*2*math.pi
    veh.append((2.2,1.0,2.2, rx*math.cos(ang), AMHS_Y+0.8, rz*math.sin(ang)))
add_mesh("AMHS_VEH", veh, "AMHS")
nodes.append({"name":"AMHS_VEH","mesh":len(meshes)-1})

# 4) Utility 管廊层 (地下)
add_material("UTIL","4d5560")
util = []
for j in range(5):
    zz = -plant_d/2 + 12 + j*(plant_d-24)/4
    util.append((plant_w-20,0.8,0.8, 0,UTIL_Y,zz))
    util.append((0.8,0.8,plant_d-20, -plant_w/2+12, UTIL_Y, 0))
add_mesh("UTIL_PIPE", util, "UTIL")
nodes.append({"name":"UTIL_PIPE","mesh":len(meshes)-1})

# 5) 支柱
add_material("STR","383d47")
strb = []
for sx in [-plant_w/2+10, plant_w/2-10]:
    for sz in [-plant_d/2+10, 0, plant_d/2-10]:
        strb.append((1.2,16,1.2, sx,8,sz))
add_mesh("STR", strb, "STR")
nodes.append({"name":"STR","mesh":len(meshes)-1})

# ------------------------- 打包 glTF -------------------------
buf = b""
bufferViews, accessors, mesh_json = [], [], []
mat_index = {m["name"]: i for i,m in enumerate(materials)}
for m in meshes:
    pos_b = struct.pack("<%df"%len(m["pos"]), *m["pos"])
    nrm_b = struct.pack("<%df"%len(m["nrm"]), *m["nrm"])
    idx_b = struct.pack("<%dH"%len(m["idx"]),  *m["idx"])
    views_this = []
    for part in (pos_b, nrm_b, idx_b):
        while len(buf) % 4 != 0: buf += b'\x00'
        off = len(buf); bufferViews.append({"buffer":0,"byteOffset":off,"byteLength":len(part)}); views_this.append(len(bufferViews)-1)
        buf += part
    pV, nV, iV = views_this
    bufferViews[pV]["target"] = 34962
    bufferViews[nV]["target"] = 34962
    bufferViews[iV]["target"] = 34963
    accessors.append({"bufferView":pV,"componentType":5126,"count":len(m["pos"])//3,"type":"VEC3","min":list(m["mn"]),"max":list(m["mx"])})
    accessors.append({"bufferView":nV,"componentType":5126,"count":len(m["nrm"])//3,"type":"VEC3"})
    accessors.append({"bufferView":iV,"componentType":5123,"count":len(m["idx"]),"type":"SCALAR"})
    mat_i = mat_index.get(m["mat_name"], 0)
    mesh_json.append({"name":m["name"],"primitives":[{"attributes":{"POSITION":pV,"NORMAL":nV},"indices":iV,"material":mat_i}]})

gltf = {
    "asset":{"version":"2.0","generator":"fab-digital-twin gen_plant.py"},
    "scenes":[{"nodes":list(range(len(nodes)))}],
    "scene":0,
    "nodes":nodes,
    "meshes":mesh_json,
    "materials":materials,
    "buffers":[{"byteLength":len(buf),"uri":"data:application/octet-stream;base64,"+base64.b64encode(buf).decode()}],
    "bufferViews":bufferViews,
    "accessors":accessors,
}

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.abspath(os.path.join(HERE, ".."))
with open(os.path.join(OUT_DIR, "fab-plant.gltf"), "w", encoding="utf-8") as f:
    json.dump(gltf, f, ensure_ascii=False, indent=1)
manifest = {"rules":[
    {"match":"EUV","module":"LITHO","wph":30,"type":"EUV Scanner"},
    {"match":"ETCH","module":"ETCH","wph":80,"type":"Etcher"},
    {"match":"CVD","module":"DEP","wph":60,"type":"Deposition"},
    {"match":"CMP","module":"CMP","wph":70,"type":"CMP"},
    {"match":"IMP","module":"IMPL","wph":55,"type":"Implant"},
    {"match":"MET","module":"METRO","wph":120,"type":"Metrology"},
]}
with open(os.path.join(OUT_DIR, "fab-plant.manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)

n_equip = len([n for n in nodes if any(n["name"].startswith(p+"_") for p,_,_,_,_,_ in MODULES)])
print("fab-plant.gltf written")
print("  nodes:", len(nodes), "| meshes:", len(mesh_json), "| equip nodes:", n_equip)
print("  plant size (m): %.0f x %.0f | AMHS_Y=%.0f UTIL_Y=%.0f" % (plant_w, plant_d, AMHS_Y, UTIL_Y))
print("fab-plant.manifest.json written")
