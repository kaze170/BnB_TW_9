import struct
def cum(buf, seed, magic_xor=0):
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

def show(dec, tag, cnt=None):
    print('--',tag)
    for off in range(0,80,16):
        b=dec[off:off+16]
        print('   %04x'%off, ' '.join('%02x'%x for x in b), '|', ''.join(chr(c) if 32<=c<127 else '.' for c in b))

raw=open('SkinDsc.idx','rb').read()
for seed in [0, 0x5B201FC, 0x9C6C95CE, 0x719cab30]:
    show(cum(raw,seed), 'cum seed=%x'%seed)
