set -e
export TMPDIR=$PWD/.tmp
python3 -m venv qa/.font-venv
qa/.font-venv/bin/pip -q install fonttools
# 字符集：ASCII + CJK 标点/全角 + GB2312 一级常用字 3755
python3 - <<'PY' > qa/.og-charset.txt
import string
chars = set(chr(c) for c in range(0x20, 0x7F))
for a,b in [(0x3000,0x3040),(0xFF00,0xFFEF),(0x2013,0x2027)]:
    chars.update(chr(c) for c in range(a,b))
chars.add('·')
for hi in range(0xB0,0xD8):
    for lo in range(0xA1,0xFF):
        try: chars.add(bytes([hi,lo]).decode('gb2312'))
        except Exception: pass
print('\n'.join(sorted(chars)))
PY
# 定位 TTC 内 Noto Sans CJK SC Bold 的 face 序号
IDX=$(qa/.font-venv/bin/python - <<'PY'
from fontTools.ttLib.ttCollection import TTCollection
c = TTCollection('/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc', lazy=True)
for i,f in enumerate(c.fonts):
    n = f['name'].getDebugName(4) or ''
    if 'SC' in n and 'Bold' in n:
        print(i); break
PY
)
echo "SC Bold face index = $IDX"
qa/.font-venv/bin/pyftsubset /usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc \
  --font-number="$IDX" \
  --unicodes-file=qa/.og-charset.txt \
  --output-file=src/assets/og/NotoSansSC-Bold-subset.ttf \
  --layout-features='' --no-hinting --desubroutinize
ls -lh src/assets/og/
