import struct, sys

def decode(buf, seed=0):
    n = len(buf)//4
    out = bytearray(buf)
    if n==0: return bytes(out)
    prev = seed ^ struct.unpack_from('<I',buf,0)[0]
    struct.pack_into('<I', out, 0, prev)
    for i in range(1,n):
        cur = struct.unpack_from('<I',buf,4*i)[0]
        prev = prev ^ cur
        struct.pack_into('<I', out, 4*i, prev)
    rem = len(buf) - 4*n
    for k in range(rem):
        out[4*n+k] = buf[4*n+k] ^ ((prev >> (8*k)) & 0xFF)
    return bytes(out)

for f in ['SkinDsc.idx','SkinRsc.idx','Cx.idx','CharTE.idx','EmoTE.idx','Fx.idx']:
    raw = open(f,'rb').read()
    print('=====', f, len(raw))
    for seed in [0]:
        dec = decode(raw, seed)
        count = struct.unpack_from('<I',dec,0)[0]
        f4 = struct.unpack_from('<I',dec,4)[0]
        print(' seed',hex(seed),'count',count,'f4',f4,hex(f4))
    print('  dec asc ', ''.join(chr(b) if 32<=b<127 else '.' for b in dec[:120]))
