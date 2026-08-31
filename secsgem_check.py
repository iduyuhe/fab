#!/usr/bin/env python3
# 第三方交叉验证 v2：Python secsgem 0.3.0（行业标准库）连接自研 HSMS 网关 :5000
# 验证：HSMS 会话 + S1F1→S1F2 + S6F11 事件报告
import time, sys

from secsgem.hsms import HsmsSettings, HsmsConnectMode
from secsgem.secs import SecsHandler

ok = True
def check(name, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name + ("  " + extra if extra else ""))
    if not cond: ok = False

# session_id=1 → LITHO-001（引擎派工热点，状态事件密集，避免 10s 抽样窗口无事件）
settings = HsmsSettings(address="127.0.0.1", port=5000, session_id=1, connect_mode=HsmsConnectMode.ACTIVE)
h = SecsHandler(settings)
h.enable()
try:
    time.sleep(2)
    # S1F1 → S1F2
    try:
        r = h.are_you_there()
        check("HSMS 会话 + S1F1→S1F2", r is not None, "resp=" + str(r)[:90])
    except Exception as e:
        check("HSMS 会话 + S1F1→S1F2", False, "err=" + str(e))

    # 订阅 S6F11 事件（收集 10s）
    got = []
    try:
        def on_s6f11(msg, *a, **k):
            got.append(str(msg))
        h.register_stream_function(6, 11, on_s6f11)
        sub_ok = True
    except Exception as e:
        sub_ok = False
        print("  (register_stream_function 不可用: %s)" % e)

    print("  等待 S6F11 设备事件 15s …")
    time.sleep(15)
    if sub_ok:
        check("S6F11 事件报告收到", len(got) > 0, "收到 %d 条" % len(got))
        if got: print("  样例:", got[0][:100])
    else:
        evts = getattr(h, "events", None)
        n = len(evts) if evts is not None else 0
        check("S6F11 事件报告收到 (events 队列)", n > 0, "events=%d" % n)
finally:
    try:
        h.disable()
    except Exception:
        pass

print("\n=== %s ===" % ("全部通过" if ok else "存在失败"))
sys.exit(0 if ok else 1)
