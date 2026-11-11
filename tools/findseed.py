import struct, os

def e_array(buf):
    return list(struct.unpack_from('<%dI'%(len(buf)//4), buf, 0))

def dec(buf, seed):
    n=len(buf)//4
    out=bytearray(buf)
    prev=seed ^ struct.unpack_from('<I',buf,0)[0]
    struct.pack_into('<I',out,0,prev)
    for i in range(1,n):
        prev ^= struct.unpack_from('<I',buf,4*i)[0]
        struct.pack_into('<I',out,4*i,prev)
    for k in range(len(buf)-4*n):
        out[4*n+k]=buf[4*n+k]^((prev>>(8*k))&0xFF)
    return bytes(out)

def parse_ok(d):
    try:
        v0,v1,v2=struct.unpack_from('<III',d,0)
        if v0==0:
            if v1!=15: return None
            count=v2; off=12; extra=True
        else:
            if v0>20000: return None
            count=v0; off=4; extra=False
        ents=[]
        for i in range(count):
            nlen=struct.unpack_from('<I',d,off)[0]; off+=4
            if not(1<=nlen<=200) or off+nlen>len(d): return None
            nm=d[off:off+nlen]; off+=nlen
            if any(c<0x20 or c>0x7e for c in nm): return None
            o,s,a=struct.unpack_from('<III',d,off); off+=12
            if extra: b=struct.unpack_from('<I',d,off)[0]; off+=4
            else: b=0
            ents.append((nm.decode('latin1'),o,s,a,b))
        return ents,off,len(d)
    except Exception:
        return None

import sys
for path in sys.argv[1:]:
    buf=open(path,'rb').read()
    E=e_array(buf)
    found=None
    # seed candidates: upper 24 bits constrained by name-length field at offset 4 -> seed upper 3 bytes = E[4] upper 3 bytes
    base = E[1] & 0xFFFFFF00
    for b in range(256):
        seed = base | b
        d = dec(buf, seed)
        r = parse_ok(d)
        if r:
            found=(seed,)+ r
            break
    if found:
        seed,ents,used,total = found
        print('==',path,'seed=%08X'%seed,'count',len(ents),'used',used,'/',total)
        for e in ents[:6]: print('   ',e)
        if len(ents)>6: print('    ... last', ents[-1])
    else:
        print('==',path,'NOT FOUND')
