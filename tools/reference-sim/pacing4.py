import math
from model import mobXP, mobGold

def K(L): return round(22 + 8 * L + 0.18 * L ** 2.5)
def need(L): return mobXP(L) * K(L)
KPM = 15.5

# zones: base level b_k = 1 + 11(k-1); maps: [b,b+3],[b+4,b+7],[b+8,b+10]; boss b+11
ZB = [1 + 11 * k for k in range(9)]
def maps(z):
    b = ZB[z]
    return [(b, b + 3), (b + 4, b + 7), (b + 8, b + 10)]
BOSSL = [b + 11 for b in ZB]
SEAL_TARGET = [6, 10, 25, 45, 70, 105, 160, 215, 300]

def gap(L, m):
    d = L - m
    if d < 0: return 1 + 0.05 * min(5, -d)
    if d <= 2: return 1.0
    return max(0.1, 1 - 0.1 * (d - 2))

def need_r(r): return round(8 * r ** 1.35)
def release_of(seals):
    r = 0
    while r < 60 and need_r(r + 1) <= seals: r += 1
    return r

def pick_map(PL, frontier):
    # all maps in zones < frontier unlocked, plus maps of frontier zone; boss zone = frontier
    best = maps(0)[0]
    for z in range(min(frontier, 8) + 1):
        for (a, b) in maps(z):
            mid = (a + b) / 2
            if mid <= PL + 1: best = (a, b)
    return best

def bot(days, hours=24):
    L = 1; xp = 0
    for d in range(days):
        for minute in range(int(hours * 60)):
            s = 1 if minute < 240 else (0.5 if minute < 480 else 0.25)
            a, b = pick_map(L, 0)
            mid = (a + b) / 2
            xp += KPM * mobXP(round(mid)) * gap(L, mid) * s
            while xp >= need(L) and L < 100: xp -= need(L); L += 1
    return L

def persona(name, A, H, T, days=400, ack=1.0, report=True, party_overlap=0.6):
    heroes = [dict(L=1, xp=0.0, fe=0.0) for _ in range(A)]
    frontier = 0; meter = 0.0; bank = 0.0; cum_seals = 0.0; gold = 0.0; docs = 0; lint_kills = 0
    trophies = 0
    events = {}
    hours_worked = 0.0
    first_boss_hours = None
    for day in range(1, days + 1):
        W = int(H * 60)
        # FE accrual from the previous idle stretch (day 1: none)
        cap = 60 + 15 * min(10, day // 6)
        if day > 1:
            for h in heroes: h['fe'] = min(cap, h['fe'] + (1440 - W) / 4)
        for minute in range(W):
            hours_worked += 1 / 60
            ks = 1 if minute < 240 else (0.5 if minute < 480 else 0.25)
            ss = 1 if minute < 240 else (0.75 if minute < 480 else 0.5)
            rel = release_of(cum_seals)
            lint = 0.02 * ((lint_kills >= 500) + (lint_kills >= 5000) + (lint_kills >= 50000))
            herd = min(0.60, 0.005 * rel + 0.02 * docs + lint)
            party = 0.06 * min(3, (A - 1)) * party_overlap if A > 1 else 0
            for h in heroes:
                L = h['L']
                PL = L + round(math.log(1 + 0.01 * trophies) / math.log(1.07))
                a, b = pick_map(PL, frontier)
                mid = (a + b) / 2
                xpm = mobXP(round(mid))
                fe = 1.5 if h['fe'] > 0 else 1.0
                if h['fe'] > 0: h['fe'] -= 1
                bonus = 1 + herd + party
                h['xp'] += KPM * xpm * gap(L, mid) * bonus * fe * ks
                # chest xp (acknowledged)
                h['xp'] += ack * 0.1 * ss * 45 * xpm * bonus
                gold += KPM * mobGold(round(mid)) * ks + ack * 0.1 * ss * 20 * mobGold(round(mid))
                if a <= 11: lint_kills += KPM * ks
                while h['xp'] >= need(h['L']) and h['L'] < 100:
                    h['xp'] -= need(h['L']); h['L'] += 1
                    for lv in (2, 5, 10, 12, 20, 30, 40, 50, 60, 70, 80, 90, 100):
                        if h['L'] == lv and ('L%d' % lv) not in events:
                            events['L%d' % lv] = (day, round(hours_worked, 1))
            s_add = ack * A * 0.1 * ss
            cum_seals += s_add
            if frontier < 9:
                meter += s_add
            # docs library purchase with 1/4 of gold
            while docs < 10 and gold * 0.25 >= 1500 * 3 ** docs:
                gold -= 1500 * 3 ** docs; docs += 1
            # boss check
            if frontier < 9 and meter >= SEAL_TARGET[frontier]:
                Lb = BOSSL[frontier]
                pls = sorted([h['L'] for h in heroes], reverse=True)[:6]
                n = len(pls)
                delta = 2 if n == 1 else (3 if n == 2 else 5)
                avgPL = sum(pls) / n + round(math.log(1 + 0.01 * trophies) / math.log(1.07))
                if avgPL >= Lb - delta and max(pls) >= ZB[frontier] + 8:
                    events['B%d' % (frontier + 1)] = (day, round(hours_worked, 1), round(avgPL), round(cum_seals))
                    if frontier == 0: first_boss_hours = hours_worked / A
                    over = meter - SEAL_TARGET[frontier]
                    frontier += 1; trophies += 1
                    meter = min(over, SEAL_TARGET[frontier] if frontier < 9 else 0)
    if report:
        print(f"== {name}: {A} agent(s) x {H} h/day, {T}-min tasks")
        for k in ['L2', 'L5', 'L10', 'L20', 'L30', 'L40', 'L50', 'L60', 'L70', 'L80', 'L90', 'L100']:
            if k in events: print(f"  {k:5s} day {events[k][0]:4d}  ({events[k][1]} working h per hero)")
        for i in range(1, 10):
            k = 'B%d' % i
            if k in events: print(f"  {k:5s} day {events[k][0]:4d}  ({events[k][1]} h/hero, party Lv {events[k][2]}, cum seals {events[k][3]})")
    return events

if __name__ == '__main__':
    persona('Casual', 1, 1.5, 8)
    persona('Solo', 1, 3, 12)
    persona('Typical', 3, 2, 10)
    persona('Heavy', 5, 5, 15)
    for d in (1, 2, 7, 30, 90, 365):
        print('bot day', d, 'Lv', bot(d))
