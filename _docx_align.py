# -*- coding: utf-8 -*-
import zipfile, shutil, os, xml.etree.ElementTree as ET, tempfile
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
XMLNS='{http://www.w3.org/XML/1998/namespace}'

def set_para_text(p, new_text):
    # 保留段落 pPr 与首个 run 的 rPr，清空其余 run 的文本，把新文本放到首个含 <w:t> 的 run
    runs = p.findall(W+'r')
    if not runs:
        r = ET.SubElement(p, W+'r')
        t = ET.SubElement(r, W+'t'); t.set(XMLNS+'space','preserve'); t.text = new_text; return
    target = None
    for r in runs:
        if r.find(W+'t') is not None:
            target = r; break
    if target is None:
        t = ET.SubElement(runs[0], W+'t'); t.set(XMLNS+'space','preserve'); t.text = new_text; return
    # 清空该 run 内所有 t，其他 run 删除其 t 文本（保留一个 run 承载）
    for r in runs:
        t = r.find(W+'t')
        if t is not None:
            r.remove(t)
    t = ET.SubElement(target, W+'t'); t.set(XMLNS+'space','preserve'); t.text = new_text

def replace_anchor(docxml, anchor, new_text):
    root = ET.fromstring(docxml)
    for p in root.iter(W+'p'):
        txt = ''.join((t.text or '') for t in p.iter(W+'t'))
        if anchor in txt:
            set_para_text(p, new_text)
            return True
    return False

def process(path, pairs):
    z = zipfile.ZipFile(path)
    data = {n: z.read(n) for n in z.namelist()}
    doc = data['word/document.xml'].decode('utf-8')
    matched = []
    for anchor, new in pairs:
        if replace_anchor(doc, anchor, new):
            matched.append(anchor)
        else:
            print('  [WARN] anchor NOT found:', anchor[:40])
    new_doc = ET.tostring(ET.fromstring(doc), encoding='unicode')
    # 写回
    backup = path + '.bak'
    if not os.path.exists(backup):
        shutil.copy(path, backup)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zo:
        for n, b in data.items():
            if n == 'word/document.xml':
                zo.writestr(n, new_doc.encode('utf-8'))
            else:
                zo.writestr(n, b)
    return matched

BLUEPRINT_NOTE = "（按 2026-08-27 战略审计终态「串主轴不推翻」：零件已齐，只修数字主线 spine 断裂，其余 L4 模块维持 demo/默认关、标蓝图态，不强行接活；保留 fab-erp 独立进程，仅修 CORS/成本，不并入 MES 底座。）"

bp_docx = 'E:/Fab/fab-mes/系统集成诊断与整合蓝图.docx'
chk_docx = 'E:/Fab/fab-mes/完整性一致性整合性核查报告.docx'

bp_pairs = [
 ("已与用户对齐改造方向：（1）ERP 并入 MES 底座；（2）tenant / apc / integrations / adapters 全部接活进运行系统，使文档与代码一致。",
  "已与用户对齐改造方向（2026-08-27 战略审计最终确认）：采用「串主轴不推翻」策略——保留 fab-erp 独立进程（仅修 CORS/成本，不并入 MES 底座）；L4 模块（tenant/apc/integrations/adapters）维持 demo / 默认关、标蓝图态，不强行接活；只修数字主线本身的断裂，其余模块明确标「蓝图态/挂枝」，杜绝两张皮误解。"),
 ("ERP 并入 MES 底座：fab-erp.js 改造为基于共享事件总线 + 共享存储接口的集成模块，经 integrations/erp-adapter.js 接回，消除双进程双存储割裂。",
  "ERP 保留 standalone（:8126 独立进程 + 独立 DB）：仅补 CORS 头与成本归集守卫，经 WS 订阅 MES 事件做领料/成本，不并入 MES 底座——避免引入未验证的存储耦合风险；双库重连补偿已补齐 ISSUE 与 lotDone 成本重放。"),
 ("L4 死模块全部接活：tenant 挂进 server.js 请求链；apc/controller.js 由 autonomy/executor 调度；adapters 接 eap-host 采集入口；integrations/* 作为 MES/ERP/SAP 切换开关。",
  "L4 模块标蓝图态（不强行接活）：tenant/apc/integrations/adapters 顶部已加「蓝图态/未接入 spine」横幅；APC 为顾问级建议器（APC_ENABLED 默认 0），多租户默认单租户零影响，adapters 默认 demo 不启动；仅当接真实设备/客户时再按需接线。"),
 ("删除重复实现：storage 抽象与 ERP 内联 sqlite 二选一统一；services/index.js 的“蓝图”转为真实装配或删除。",
  "避免重复实现：保留 storage 抽象与 ERP 内联 sqlite 双库并存（各有职责：MES 业务库 / ERP 财务台账），services/index.js 等蓝图文件明确标注状态，不强行删除以免破坏既有功能。"),
 ("整合 ERP 并入 MES 底座：fab-erp 逻辑迁至 server.js 集成层，复用 eventbus + 共享存储。",
  "ERP 不并入 MES 底座：保留 fab-erp 独立进程，通过门户 /api/erp/* 代理与 MES 解耦协作，复用事件总线订阅而非共享存储实例。"),
 ("接活 tenant：MULTI_TENANT 默认关，激活后请求链带租户上下文。",
  "tenant 标蓝图态：MULTI_TENANT 默认关，激活后请求链带租户上下文；当前为单租户零影响，不强行接活。"),
 ("接活 apc：由 autonomy/executor 调度，APC_ENABLED 默认 0。",
  "apc 标蓝图态：APC 为偏移补偿建议器（law=offset-compensate P(kp=0.5,deadband=0.05)），由 autonomy/executor 调度，APC_ENABLED 默认 0，写操作走人审闸门，不自动闭环。"),
 ("接活 adapters：ADAPTER_MODE=demo 默认不启动，接口接通 eap-host。",
  "adapters 标蓝图态：ADAPTER_MODE=demo 默认不启动，接口预留接通 eap-host，接真实 OPC-UA/EDA 时再启用。"),
 ("接活 integrations：ERP_MODE / MES_MODE 切换 demo|sap|real，端点经适配器统一。",
  "integrations 标蓝图态：ERP_MODE/MES_MODE 切换 demo|sap|real 仅作配置占位，端点经适配器统一；当前 ERP 走 standalone 真实运行，SAP/real 为蓝图。"),
 ("重启受影响进程并功能 curl 验收：事件总线唯一、ERP 经适配器联动、tenant/apc/adapters 生效、3D 孪生与 EAP 纳入体系、原有 L1-L4 功能零退化。",
  "重启受影响进程并功能 curl 验收：事件总线唯一、ERP 经门户代理联动、3D 孪生与 EAP 纳入体系、原有 L1-L4 功能零退化；L4 模块按蓝图态验收（有标注、有开关，而非强制接活）。"),
 ("对外文档与代码强一致：PPT 与 README 中关于 L4 的描述，必须与运行时实际加载的模块一一对应。",
  "对外文档与代码强一致：PPT / 白皮书 / README 中关于 L4 的描述须标注「已接活 / 蓝图态」，不得把目标态写成已在线；超纲宣称（APC 闭环 / 多租户隔离 / 真实适配即插即用）一律降级为蓝图态注记。"),
]

chk_pairs = [
 ("本报告的结论基于整合前的“分裂态”事实编写。截至本注记日期，报告中的整合蓝图已全部落地执行：eap-host.js(8125) 已纳入默认启动编排；3D 数字孪生 fab-digital-twin 已并入 fab-mes/twin3d/ 由门户统一托管；ERP 支持 stand",
  "本报告的结论基于整合前的“分裂态”事实编写。截至本注记日期，整合编排已落地：eap-host.js(8125) 已纳入 start-community.sh 默认启动；3D 数字孪生 fab-digital-twin 已并入 fab-mes/twin3d/ 由门户统一托管；ERP 保留 standalone(:8126) 独立进程（仅修 CORS/成本）。L4 模块(tanant/apc/adapters/integrations)按「串主轴不推翻」策略维持蓝图态标注，不强行接活，非系统缺陷。"),
 ("WMS 缺失；tenant/apc/adapters/integrations 死模块未接活",
  "WMS 业务域本期内未建（ERP 的 stock 为财务台账，非仓储执行，已在文档明示）；tenant/apc/adapters/integrations 按策略维持蓝图态标注，非缺陷。"),
 ("总结报告/EAP/孪生“✓在线”失实；L4 多租户/APC 文档宣称未落地",
  "总结报告/EAP/孪生状态已与运行时对齐（见 D1/D2）；L4 多租户/APC 的文档宣称已降级为蓝图态注记，与运行时一致。"),
 ("要达到你设计的“同一底座、统一整合”，必须完成：文档纠偏 → 编排补全（EAP+3D孪生）→ ERP 并入 → L4 接活。",
  "要达到「串主轴不推翻」终态：文档纠偏（已完成）→ 编排补全(EAP+3D 已并入) → ERP 保留 standalone 修 CORS/成本 → L4 标蓝图态不强行接活。其中文档纠偏关乎对外演示诚信，已优先完成。"),
 ("ERP 并入 MES 底座：复用事件总线+共享存储，消除双存储弱耦合。",
  "ERP 保留 standalone：复用事件总线订阅 MES 事件做领料/成本，不共享存储实例，消除双存储弱耦合的同时避免未验证耦合风险。"),
 ("L4 死模块接活：tenant 挂请求链、apc 由 autonomy 调度、adapters/integrations 接回主链路。",
  "L4 模块标蓝图态：tenant/apc/adapters/integrations 顶部已加「蓝图态/未接入 spine」横幅，APC 默认关、多租户默认单租户、adapters 默认 demo，不强行接回主链路。"),
]

print("=== 整合蓝图.docx ===")
m1 = process(bp_docx, bp_pairs)
print("matched", len(m1), "/", len(bp_pairs))
print("=== 核查报告.docx ===")
m2 = process(chk_docx, chk_pairs)
print("matched", len(m2), "/", len(chk_pairs))
print("DONE")
