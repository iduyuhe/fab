import zipfile, re

SRC = "fab-mes-平台介绍.pptx"
BAK = "fab-mes-平台介绍.pptx.bak"
OUT = "fab-mes-平台介绍.repaired.pptx"

src = zipfile.ZipFile(SRC)
bak = zipfile.ZipFile(BAK)

# --- thanks slide from bak (slide18) ---
thanks_xml = bak.read("ppt/slides/slide18.xml")
thanks_rels = bak.read("ppt/slides/_rels/slide18.xml.rels").decode("utf-8")
thanks_rels = re.sub(r'<Relationship[^>]*notesSlide[^>]*/>', '', thanks_rels)  # drop notes
thanks_media = [f"ppt/media/image-18-{i}.png" for i in range(1, 5)
                if f"ppt/media/image-18-{i}.png" in bak.namelist()]

# --- patch manifest from SRC: remove duplicate NPI (rId16 -> slide17) ---
pres = src.read("ppt/presentation.xml").decode("utf-8")
rels = src.read("ppt/_rels/presentation.xml.rels").decode("utf-8")

# remove rId16 sldId entry
pres2 = re.sub(r'<p:sldId id="\d+" r:id="rId16"/>', '', pres)
# remove rId16 relationship
rels2 = re.sub(r'<Relationship Id="rId16"[^>]*/>', '', rels)
# pick a fresh id for the new thanks slide
ids = [int(m) for m in re.findall(r'<p:sldId id="(\d+)"', pres2)]
new_id = max(ids) + 1
# append new sldId entry at end of sldIdLst
pres2 = re.sub(r'(</p:sldIdLst>)',
               f'<p:sldId id="{new_id}" r:id="rId100"/></p:sldIdLst>', pres2)
# add relationship for rId100 -> slide18
rels2 = re.sub(r'(</Relationships>)',
               f'<Relationship Id="rId100" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide18.xml"/></Relationships>',
               rels2)

# --- build output zip ---
src_names = set(src.namelist())
written = set()
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
    for item in src.infolist():
        name = item.filename
        if name in written:           # dedupe duplicate slide17.xml
            continue
        if name in ("ppt/presentation.xml", "ppt/_rels/presentation.xml.rels",
                    "[Content_Types].xml"):
            continue                  # written once, patched, below
        zf.writestr(item, src.read(name))
        written.add(name)
    zf.writestr("ppt/presentation.xml", pres2)
    zf.writestr("ppt/_rels/presentation.xml.rels", rels2)
    zf.writestr("ppt/slides/slide18.xml", thanks_xml)
    zf.writestr("ppt/slides/_rels/slide18.xml.rels", thanks_rels)
    for media in thanks_media:
        if media in src_names:
            continue
        zf.writestr(media, bak.read(media))
    # register slide18 content-type (correct namespace!)
    ct = src.read("[Content_Types].xml").decode("utf-8")
    if "/ppt/slides/slide18.xml" not in ct:
        ct = ct.replace("</Types>",
            '<Override PartName="/ppt/slides/slide18.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>')
        zf.writestr("[Content_Types].xml", ct)

print("WROTE", OUT)
