"""Generate the pinned Unicode 17 namespace tables from official cached UCD inputs."""
from pathlib import Path
import hashlib,json
base=Path('.tools/unicode17')
fold={}
for line in (base/'CaseFolding.txt').read_text().splitlines():
    text=line.split('#')[0].strip()
    if not text: continue
    code,status,mapping,*_=map(str.strip,text.split(';'))
    if status in ('C','F'): fold[str(int(code,16))]=''.join(chr(int(v,16)) for v in mapping.split())
ranges=[]
for line in (base/'DerivedAge.txt').read_text().splitlines():
    text=line.split('#')[0].strip()
    if not text: continue
    code=text.split(';')[0].strip().split('..')
    ranges.append([int(code[0],16),int(code[-1],16)])
ranges.sort()
merged=[]
for start,end in ranges:
    if merged and start<=merged[-1][1]+1: merged[-1][1]=max(end,merged[-1][1])
    else: merged.append([start,end])
data={'version':'17.0.0','sources':{name:hashlib.sha256((base/name).read_bytes()).hexdigest() for name in ['CaseFolding.txt','DerivedAge.txt']},'fold':fold,'assigned':merged}
Path('fixtures/unicode/namespace-v1.json').write_text(json.dumps(data,ensure_ascii=False,separators=(',',':'))+'\n')
