M2_MAX_OFFSET = 0x0800

def lzo1x_decompress(src):
    src = memoryview(src)
    ip = 0; op = bytearray(); n = len(src)
    def copylit(t):
        nonlocal ip
        if t:
            op.extend(src[ip:ip+t]); ip += t
    def copym(m_pos, t):
        # copy t bytes from op[m_pos] (may overlap)
        if m_pos < 0: raise ValueError('neg m_pos')
        for i in range(t):
            op.append(op[m_pos+i])
    t = src[ip]; ip += 1
    if t > 17:
        t -= 17
        if t < 4:
            copylit(t); t = src[ip]; ip += 1
        else:
            copylit(t); t = src[ip]; ip += 1
            if t >= 16: pass
            else:
                m_pos = len(op) - (1 + M2_MAX_OFFSET) - (t >> 2) - (src[ip] << 2); ip += 1
                copym(m_pos, 3)
                t = src[ip-2] & 3
                if t: copylit(t); t = src[ip]; ip += 1
                else: t = -1
    while True:
        if t == -1:
            t = src[ip]; ip += 1
        if t >= 16:
            # match
            if t >= 64:
                m_pos = len(op) - 1 - ((t >> 2) & 7) - (src[ip] << 3); ip += 1
                ln = (t >> 5) + 1
                copym(m_pos, ln)
            elif t >= 32:
                t &= 31
                if t == 0:
                    while src[ip] == 0: t += 255; ip += 1
                    t += 31 + src[ip]; ip += 1
                m_pos = len(op) - 1 - ((src[ip] >> 2) + (src[ip+1] << 6)); ip += 2
                copym(m_pos, t + 2)
            elif t >= 16:
                m_pos = len(op) - ((t & 8) << 11)
                t &= 7
                if t == 0:
                    while src[ip] == 0: t += 255; ip += 1
                    t += 7 + src[ip]; ip += 1
                m_pos -= (src[ip] >> 2) + (src[ip+1] << 6); ip += 2
                if m_pos == len(op): break   # eof marker
                m_pos -= 0x4000
                copym(m_pos, t + 2)
            else:
                m_pos = len(op) - 1 - (t >> 2) - (src[ip] << 2); ip += 1
                copym(m_pos, 2)
            # match_done
            t = src[ip-2] & 3
            if t: copylit(t); t = -1
            else: t = -1
            continue
        else:
            # literal run
            if t == 0:
                while src[ip] == 0: t += 255; ip += 1
                t += 15 + src[ip]; ip += 1
            copylit(t + 3)
            # first_literal_run
            t = src[ip]; ip += 1
            if t >= 16: continue
            m_pos = len(op) - (1 + M2_MAX_OFFSET) - (t >> 2) - (src[ip] << 2); ip += 1
            copym(m_pos, 3)
            t = src[ip-2] & 3
            if t: copylit(t); t = -1
            else: t = -1
            continue
    return bytes(op)

if __name__ == '__main__':
    import sys
    sys.path.insert(0,'tools')
    from bnb import find_index
    for name in ['Cx','Fx','CharTE','EmoTE']:
        ids = find_index(name+'.idx'); data = open(name+'.idd','rb').read()
        print('==', name)
        for e in ids['ents'][:4]:
            nm,o,s,a,b = e
            blob = data[o:o+s]
            try:
                out = lzo1x_decompress(blob)
                print('  %-40s %6d -> %6d  %s' % (nm, s, len(out), out[:24].hex()))
            except Exception as ex:
                print('  %-40s ERR %s' % (nm, ex))
