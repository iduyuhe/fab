import zipfile, os, shutil

SRC = "fab-mes-平台介绍.pptx"
TMP = "repair_tmp"
OUT = "fab-mes-平台介绍.repaired.pptx"

os.makedirs(TMP, exist_ok=True)

z = zipfile.ZipFile(SRC)
z.extractall(TMP)

def P(*parts):
    return os.path.join(TMP, *parts)

s12 = open(P("ppt", "slides", "slide12.xml"), encoding="utf-8").read()
print("slide12 twin:", ("数字孪生" in s12) or ("DIGITAL TWIN" in s12))
s17 = open(P("ppt", "slides", "slide17.xml"), encoding="utf-8").read()
print("slide17 NPI:", "NPI THREAD" in s17,
      "| stray footer:", "投料 → 执行 → 量测 → 判异 → 孪生 → 成本 → 问答" in s17)

relp = P("ppt", "_rels", "presentation.xml.rels")
rels = open(relp, encoding="utf-8").read()
needle = ('<Relationship Id="rId16" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
          'Target="slides/slide17.xml"/>')
assert needle in rels, "needle not found in rels"
rels2 = rels.replace(needle,
                     '<Relationship Id="rId16" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
                     'Target="slides/slide12.xml"/>')
open(relp, "w", encoding="utf-8").write(rels2)
print("rels patched: rId16 -> slide12.xml")

if os.path.exists(OUT):
    os.remove(OUT)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk(TMP):
        for f in files:
            full = os.path.join(root, f)
            arc = os.path.relpath(full, TMP).replace(os.sep, "/")
            zf.write(full, arc)
print("REZIP DONE ->", OUT, os.path.getsize(OUT))
