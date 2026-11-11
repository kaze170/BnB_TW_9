import struct, sys

def parse_idx(path):
    d = open(path,'rb').read()
    magic, f4, f8, namelen = struct.unpack_from('<IIII', d, 0)
    off = 16
    entries = []
    while off + 4 <= len(d):
        nlen = struct.unpack_from('<I', d, off)[0]; off += 4
        if nlen <= 0 or nlen > 512 or off + nlen > len(d): break
        name = d[off:off+nlen]; off += nlen
        o, size, extra = struct.unpack_from('<III', d, off); off += 12
        entries.append((name, o, size, extra))
    return (magic, f4, f8, namelen), entries

if __name__ == '__main__':
    for p in sys.argv[1:]:
        hdr, es = parse_idx(p)
        print('==', p, 'hdr=', [hex(h) for h in hdr], 'count=', len(es), 'declared f8=', hdr[2], 'namelen-hdr=', hdr[3])
        for name,o,s,e in es[:20]:
            print('   ', name, o, s, e)
