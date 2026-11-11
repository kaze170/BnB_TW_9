import struct
class PE:
    def __init__(self, path):
        self.d = open(path,'rb').read()
        d=self.d
        pe=struct.unpack_from('<I',d,0x3c)[0]
        assert d[pe:pe+4]==b'PE\0\0'
        nsec=struct.unpack_from('<H',d,pe+6)[0]
        opt=pe+24
        self.imagebase=struct.unpack_from('<I',d,opt+28)[0]
        self.secs=[]
        for i in range(nsec):
            o=opt+struct.unpack_from('<H',d,pe+20)[0]+i*40
            name=d[o:o+8].rstrip(b'\0').decode('latin1')
            vsize,vaddr,rsize,raddr=struct.unpack_from('<IIII',d,o+8)
            self.secs.append((name,vaddr,vsize,raddr,rsize))
    def rva2off(self,rva):
        for name,va,vs,ra,rs in self.secs:
            if va<=rva<va+max(vs,rs): return ra+(rva-va)
        return None
    def u32(self,va):  # va includes imagebase
        o=self.rva2off(va-self.imagebase)
        return struct.unpack_from('<I',self.d,o)[0] if o is not None else None
    def cstr(self,va):
        o=self.rva2off(va-self.imagebase)
        if o is None: return None
        e=self.d.index(b'\0',o)
        return self.d[o:e].decode('latin1')
