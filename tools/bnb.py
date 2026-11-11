import struct, os, json, sys

def decrypt(buf, seed):
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

def try_parse(d):
    try:
        v0,v1,v2 = struct.unpack_from('<III',d,0)
        if v0==0:
            if v1!=15: return None
            count=v2; off=12; fmt=24
        else:
            if not (1<=v0<=40000): return None
            count=v0; off=4; fmt=16
        ents=[]
        for i in range(count):
            nl=struct.unpack_from('<I',d,off)[0]; off+=4
            if not(1<=nl<=250) or off+nl>len(d): return None
            nm=d[off:off+nl]; off+=nl
            if any(c<0x20 or c>0x7e for c in nm): return None
            if fmt==16:
                o,s=struct.unpack_from('<II',d,off); off+=8
                extra=[]
            else:
                o,s,a,b=struct.unpack_from('<IIII',d,off); off+=16
                extra=[a,b]
            ents.append([nm.decode('latin1'),o,s]+extra)
        return {'fmt':fmt,'count':count,'ents':ents,'used':off,'total':len(d)}
    except Exception:
        return None

def find_index(path):
    raw=open(path,'rb').read()
    E0=struct.unpack_from('<I',raw,0)[0]
    # cumulative: out[i] independent of seed except XOR-mask? out[i] = seed ^ E[0]^...^E[i]
    # so for 24-byte: out[0]=0 -> seed=E0.  count=0
    for count in range(0,40001):
        seed = E0 ^ count
        d = decrypt(raw, seed)
        r = try_parse(d)
        if r and d[0:4]==struct.pack('<I',count):
            r['seed']=seed
            return r
    return None

if __name__=='__main__':
    for p in sys.argv[1:]:
        r=find_index(p)
        if not r: print(p,'FAIL'); continue
        idd=p.replace('.idx','.idd')
        sz=os.path.getsize(idd)
        print('==',p,'seed=%08X'%r['seed'],'fmt',r['fmt'],'count',r['count'],'used',r['used'],'/',r['total'],'iddsize',sz)
        print('   first',r['ents'][0],'last',r['ents'][-1])
