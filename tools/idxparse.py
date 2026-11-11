import struct, sys

SEED = 0x719cab30
def decode(buf, seed=SEED):
    n = len(buf)//4
    out = bytearray(buf)
    prev = seed ^ struct.unpack_from('<I',buf,0)[0]
    struct.pack_into('<I', out, 0, prev)
    for i in range(1,n):
        prev = prev ^ struct.unpack_from('<I',buf,4*i)[0]
        struct.pack_into('<I', out, 4*i, prev)
    for k in range(len(buf)-4*n):
        out[4*n+k] = buf[4*n+k] ^ ((prev>>(8*k))&0xFF)
    return bytes(out)

def parse(path):
    d = decode(open(path,'rb').read())
    v0,v1,v2 = struct.unpack_from('<III', d, 0)
    if v0 == 0:
        assert v1 == 15, v1
        count = v2; off = 12; extra = True
    else:
        count = v0; off = 4; extra = False
    ents=[]
    for i in range(count):
        nlen = struct.unpack_from('<I', d, off)[0]; off+=4
        name = d[off:off+nlen].decode('cp950'); off+=nlen
        o,s,a,b = struct.unpack_from('<IIII', d, off); off+=16
        if not extra: b=None
        ents.append((name,o,s,a,b))
    return ents, off, len(d)

for p in sys.argv[1:]:
    ents, used, total = parse(p)
    print('==',p,'count',len(ents),'used',used,'of',total)
    idd = p.replace('.idx','.idd')
    import os
    sz = os.path.getsize(idd) if os.path.exists(idd) else 0
    print('   idd size', sz)
    for e in ents[:12]: print('   ', e)
