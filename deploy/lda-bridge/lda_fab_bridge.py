#!/usr/bin/env python3
"""
LDA → fab-mes 有机桥接器（Org-bridge）
--------------------------------
把 LDA 的设计（货架 shelf 或完整 DesignPackage）导入 fab-mes NPI，
成为可流片的制造工单。这是"上游设计 → 下游制造"有机衔接的执行件。

用法：
  python3 lda_fab_bridge.py <shelfId> [tapeout|engineering|volume]
  python3 lda_fab_bridge.py --package /path/to/package.json

默认：IM-CPO-WDM5 → tapeout
"""
import sys, json, urllib.request, urllib.error

FAB = "http://127.0.0.1:8204"   # fab-mes MES 引擎（NPI 端点在引擎层，不经门户鉴权）


def post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(FAB + path, data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:  # noqa
        return 0, str(e)


def main():
    args = sys.argv[1:]
    if not args or args[0] == "--help":
        print(__doc__)
        return
    if args[0] == "--package":
        with open(args[1]) as f:
            pkg = json.load(f)
        status, body = post("/api/npi/import-lda", {"package": pkg})
    else:
        shelf = args[0]
        typ = args[1] if len(args) > 1 else "tapeout"
        status, body = post("/api/npi/import-lda", {"shelfId": shelf, "type": typ})
    print(f"HTTP {status}")
    try:
        print(json.dumps(json.loads(body), ensure_ascii=False, indent=2))
    except Exception:
        print(body)


if __name__ == "__main__":
    main()
