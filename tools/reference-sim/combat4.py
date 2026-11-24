import random, math, sys
import model as M
from model import g, iref, R_ref, pol_ref, d_ref, refArmor, DR, refHP, refDR, mobXP

UNLOCK = [1, 5, 10, 20, 30, 60, 90]
MAXR   = [20, 15, 15, 15, 15, 15, 10]
TIE    = [5, 4, 0, 1, 6, 2, 3]

GROWTH = {
  'intern':      (2.3, 1.7, 0.5, 0.5),
  'refactorer':  (2.2, 2.3, 0.5, 0.0),
  'hotfixer':    (2.4, 1.0, 1.6, 0.0),
  'shellmancer': (2.6, 1.4, 0.5, 0.5),
  'forkbinder':  (2.2, 1.6, 0.6, 0.6),
  'rubberducker':(2.0, 2.0, 0.5, 0.5),
}
P = dict(C_HP=3.0, C_ATK=0.025, regen_eng=0.005, regen_walk=0.03, first_swing=1, rf=None)

def rf(m):
    if P['rf'] is None: return 1.0
    return P['rf'](m)

def mobHP(m): return round(P['C_HP'] * rf(m) * M.refDmg(m))
def mobATK(m): return round(P['C_ATK'] * refHP(m) / (1 - refDR(m)))

def ranks(L, trials=True):
    r = [0] * 7
    sp = max(0, L - 1) + (1 if trials and L >= 30 else 0) + (1 if trials and L >= 60 else 0)
    for lv in range(2, L + 1):
        pts = 1 + (1 if lv == 30 else 0) + (1 if lv == 60 else 0)
        for _ in range(pts):
            best = None
            for i in range(7):
                if lv < UNLOCK[i] or r[i] >= MAXR[i] or lv < UNLOCK[i] + r[i]: continue
                key = (r[i] / MAXR[i], TIE.index(i))
                if best is None or key < best[0]: best = (key, i)
            if best: r[best[1]] += 1
    return r

class Hero:
    def __init__(s, cls, L, gear_shift=0.0, intern_ranks=False):
        s.cls, s.L = cls, L
        gm, gg, gk, gl = GROWTH[cls]
        s.might = 4 + gm * (L - 1); s.grit = 4 + gg * (L - 1); s.keen = 4 + gk * (L - 1)
        s.r = ranks(L) if cls != 'intern' else [min(20, max(0, min(L, 9) - 1 - min(4, max(0, min(L, 9) - 5)))), min(4, max(0, min(L, 9) - 5)), 0, 0, 0, 0, 0]
        s.wdmg = 6 * g(iref(L)) * R_ref(L) * pol_ref(L) * (1.07 ** gear_shift)
        s.dmgp = d_ref(L)
        s.crit = min(0.5, 0.05 + 0.0015 * s.keen + 0.0005 * L)
        s.critm = 1.5
        hpp = M.hp_pct_ref(L); s.drflat = 0; s.dodge = 0
        r = s.r
        if cls == 'refactorer':
            hpp += 0.10 + 0.02 * r[2]; s.drflat = 0.01 * r[2] + 0.01 * r[6]; s.dmgp += 0.02 * r[6]
        if cls == 'hotfixer':
            s.crit = min(0.5, s.crit + 0.05); s.critm = 1.6 + 0.02 * r[6]; s.dodge = 0.01 * r[2] + 0.01 * r[6]
        if cls == 'shellmancer': s.dmgp += 0.02 * r[6]
        if cls == 'forkbinder': s.dmgp += 0.01 * r[6] * (1 if r[3] > 0 else 0)
        if cls == 'rubberducker': s.dmgp += 0.005 * r[2]; s.drflat = 0.01 * r[6]
        s.maxhp = 60 * g(L) * (1 + s.grit / 100) * (1 + hpp)
        s.armor = refArmor(L) * (1.07 ** gear_shift)
        s.hp = s.maxhp

    def hit(s, coef, rng, extra=0.0, force_crit=False):
        c = force_crit or rng.random() < s.crit
        return s.wdmg * (1 + s.might / 100) * coef * (1 + s.dmgp + extra) * (s.critm if c else 1) * rng.uniform(0.92, 1.08)

def rotation(h, st, target, arrived, rng):
    """returns list of (mob, dmg)."""
    r = h.r; c = h.cls; out = []
    st['actions'] += 1
    extra = 0.0
    cd = st['cd']
    # buffs
    if r[3] > 0 and cd['buff'] == 0:
        if c == 'refactorer': st['buff_t'] = 10; cd['buff'] = 30
        if c == 'shellmancer': st['buff_t'] = 8; cd['buff'] = 30
        if c == 'hotfixer': st['buff_t'] = 5 + r[3] // 5; cd['buff'] = 30
        if c == 'rubberducker': st['buff_t'] = 10; cd['buff'] = 30
    if st['buff_t'] > 0:
        if c == 'refactorer': extra += 0.10
        if c == 'shellmancer': extra += 0.15 + 0.01 * (r[3] - 1)
        if c == 'rubberducker': extra += (0.12 + 0.01 * (r[3] - 1))
    
    if c == 'rubberducker' and st['retro_t'] > 0: extra += 0.30 + 0.01 * (r[5] - 1)
    force = (c == 'hotfixer' and st['buff_t'] > 0)
    def H(coef, fc=False): return h.hit(coef, rng, extra, fc or force)
    # ultimate
    if r[5] > 0 and cd['ult'] == 0 and (len(arrived) >= 2 or st.get('boss')):
        if c == 'refactorer':
            for mb in arrived: out.append((mb, H(5 + 0.25 * (r[5] - 1))))
            cd['ult'] = 45
        elif c == 'shellmancer':
            for _ in range(3):
                for mb in arrived: out.append((mb, H(0.8 + 0.04 * (r[5] - 1))))
            cd['ult'] = 50
        elif c == 'hotfixer':
            for _ in range(8): out.append((target, H(1.0 + 0.05 * (r[5] - 1), True)))
            cd['ult'] = 40
        elif c == 'forkbinder':
            for _ in range(8): out.append((rng.choice(arrived), H(0.9 + 0.045 * (r[5] - 1))))
            cd['ult'] = 45
        elif c == 'rubberducker':
            st['retro_t'] = 15; cd['ult'] = 45
            out.append((target, H(0.95 + 0.03 * max(0, r[0] - 1))))
        return out
    # signature procs
    if r[4] > 0 and st['actions'] % 6 == 0 and c in ('refactorer', 'shellmancer', 'forkbinder'):
        if c == 'refactorer': coef = 2.0 + 0.08 * (r[4] - 1)
        elif c == 'shellmancer': coef = 2.0 + 0.08 * (r[4] - 1)
        else: coef = None
        if coef:
            out.append((target, H(coef)))
            for mb in arrived:
                if mb is not target: out.append((mb, 0.5 * H(coef)))
        else:
            for mb in arrived: out.append((mb, 1.5 * H(0.6 + 0.03 * (r[4] - 1))))
        return out
    # area
    if r[1] > 0 and cd['area'] == 0 and (len(arrived) >= 2 or c == 'hotfixer'):
        cd['area'] = 4
        if c == 'hotfixer':
            lo = min(arrived, key=lambda x: x['hp'])
            out.append((lo, H(1.8 + 0.06 * (r[1] - 1))))
        elif c == 'shellmancer':
            for mb in arrived[:4]: out.append((mb, H(0.65 + 0.03 * (r[1] - 1))))
        elif c == 'forkbinder':
            for mb in arrived[:3]: out.append((mb, H(0.65 + 0.03 * (r[1] - 1))))
        else:  # refactorer, intern, rubberducker (solo: no ally to heal)
            base = 0.70
            for mb in arrived[:3]: out.append((mb, H(base + 0.03 * (r[1] - 1))))
        return out
    # main
    if c == 'hotfixer':
        bis = 1.0
        if r[4] > 0:
            stacks = min(target['eng'], 5 + r[4] // 3); bis = 1 + 0.05 * stacks
        out.append((target, bis * (H(0.6 + 0.02 * max(0, r[0] - 1)) + H(0.6 + 0.02 * max(0, r[0] - 1)))))
    elif c == 'forkbinder':
        out.append((target, H(0.85 + 0.025 * max(0, r[0] - 1)) + H(0.2)))
    elif c == 'rubberducker':
        out.append((target, H(1.05 + 0.03 * max(0, r[0] - 1))))
    else:
        out.append((target, H(1.0 + 0.03 * max(0, r[0] - 1))))
    return out

def passives(h, st, target, arrived, rng):
    out = []; r = h.r
    if h.cls == 'shellmancer' and r[2] > 0 and rng.random() < 0.01 * r[2]:
        out.append((target, h.hit(1.0 + 0.03 * max(0, r[0] - 1), rng)))
    if h.cls == 'rubberducker' and r[4] > 0:
        n = 1 if r[4] < 8 else 2
        for _ in range(n): out.append((target, (0.20 + 0.01 * (r[4] - 1)) * h.hit(1.05 + 0.03 * max(0, r[0] - 1), rng)))
    if h.cls == 'forkbinder' and r[3] > 0:
        out.append((target, (0.15 + 0.01 * (r[3] - 1)) * h.hit(0.85 + 0.025 * max(0, r[0] - 1), rng)))
    return out

def sim_farm(cls, L, ticks=7200, seed=1, map_off=0, gear_shift=0.0):
    rng = random.Random(seed)
    h = Hero(cls, L, gear_shift)
    lane = []
    kills = xp = coffees = crashes = down = 0
    st = dict(cd={'area': 0, 'buff': 0, 'ult': 0}, buff_t=0, actions=0, stand_t=0, retro_t=0)
    coffee_cd = 0; target = None; tick_stand = 0
    for t in range(ticks):
        if len(lane) < 3:
            m = max(1, L + map_off + rng.choice([-1, 0, 1]))
            hp = mobHP(m)
            lane.append(dict(hp=hp, max=hp, m=m, arrived=False, new=True, eng=0))
        for mb in lane:
            if not mb['new']: mb['arrived'] = True
            mb['new'] = False
        if down > 0:
            down -= 1
            if down == 0: h.hp = 0.5 * h.maxhp
            continue
        for k in st['cd']: st['cd'][k] = max(0, st['cd'][k] - 1)
        for k in ('buff_t', 'stand_t', 'retro_t'): st[k] = max(0, st[k] - 1)
        if False:
            tick_stand += 1
            if tick_stand % 15 == 0:
                st['stand_t'] = 5; h.hp = min(h.maxhp, h.hp + (0.05 + 0.003 * h.r[4]) * h.maxhp)
        coffee_cd = max(0, coffee_cd - 1)
        arrived = [mb for mb in lane if mb['arrived']]
        if target is None or target not in lane:
            h.hp = min(h.maxhp, h.hp + P['regen_walk'] * h.maxhp)
            if arrived: target = arrived[0]; target['eng'] = 0
            continue
        dealt = rotation(h, st, target, arrived, rng) + passives(h, st, target, arrived, rng)
        for mb, d in dealt: mb['hp'] -= d
        target['eng'] += 1
        if target['hp'] > 0 and (target['eng'] - P['first_swing']) % 2 == 0:
            if rng.random() >= h.dodge and not (h.cls == 'hotfixer' and st['buff_t'] > 0):
                raw = mobATK(target['m']) * rng.uniform(0.9, 1.1)
                dr = min(0.75, DR(h.armor, target['m']) + h.drflat)
                h.hp -= raw * (1 - dr)
        for mb in list(lane):
            if mb['hp'] <= 0:
                lane.remove(mb); kills += 1; xp += mobXP(mb['m'])
        if target not in lane: target = None
        h.hp = min(h.maxhp, h.hp + P['regen_eng'] * h.maxhp)
        if h.hp / h.maxhp < 0.45 and coffee_cd == 0 and h.hp > 0:
            h.hp = min(h.maxhp, h.hp + 0.35 * h.maxhp); coffees += 1; coffee_cd = 5
        if h.hp <= 0:
            crashes += 1; down = 5; target = None
    mins = ticks / 60
    return dict(kpm=kills / mins, coffee_h=coffees / mins * 60, crash_h=crashes / mins * 60)

CLS5 = ['refactorer', 'hotfixer', 'shellmancer', 'forkbinder', 'rubberducker']

def table(levels, off=0, ticks=7200):
    rows = {}
    for L in levels:
        row = {}
        for cls in (['intern'] if L < 10 else CLS5):
            row[cls] = sim_farm(cls, L, ticks=ticks, seed=L * 7 + off, map_off=off)
        rows[L] = row
    return rows

if __name__ == '__main__':
    levels = [1, 3, 5, 9, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100]
    for off in [0, 3, 5]:
        print('map offset', off)
        rows = table(levels, off)
        for L, row in rows.items():
            avg = sum(v['kpm'] for v in row.values()) / len(row)
            s = ' '.join(f"{k[:4]} {v['kpm']:.1f}/{v['coffee_h']:.0f}/{v['crash_h']:.1f}" for k, v in row.items())
            print(f"L{L:3d} avg {avg:.1f} | {s}")
