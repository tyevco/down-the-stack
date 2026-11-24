import math, random

# ---------- core curves ----------
def g(x): return 1.07 ** (max(1, x) - 1)

C_HP = 3.0     # mob HP = C_HP * refDmg(m)
C_ATK = 0.03   # mob swing = 3% of ref HP after ref DR

def iref(L): return max(1, L - 2)
def R_ref(L): return 1 + 0.0048 * L
def pol_ref(L): return 1 + 0.005 * L          # polish p = L/10, 5% each
def d_ref(L): return 0.003 * L                # affix damage %
def might_ref(L): return 4 + 2.3 * (L - 1)
def grit_ref(L): return 4 + 1.7 * (L - 1)
def keen_ref(L): return 4 + 0.7 * (L - 1)
def crit_ref(L): return min(0.5, 0.05 + 0.0015 * keen_ref(L) + 0.0005 * L)  # gear crit ~ +5% at 100
def hp_pct_ref(L): return 0.003 * L

def refDmg(L):
    return 6 * g(iref(L)) * R_ref(L) * pol_ref(L) * (1 + might_ref(L) / 100) * (1 + d_ref(L)) * (1 + 0.5 * crit_ref(L))

def refHP(L):
    return 60 * g(L) * (1 + grit_ref(L) / 100) * (1 + hp_pct_ref(L))

K_ARMOR = 4.5
def refArmor(L):
    return 3 * K_ARMOR * g(iref(L)) * R_ref(L) * pol_ref(L) * (1 + 0.002 * L)

def DR(A, m): return min(0.75, A / (A + 25 * g(m)))
def refDR(L): return DR(refArmor(L), L)

def mobHP(m): return round(C_HP * refDmg(m))
def mobATK(m): return round(C_ATK * refHP(m) / (1 - refDR(m)))
def mobXP(m): return round((4 + m) * 1.06 ** (m - 1))
def mobGold(m): return round((2 + m) * 1.05 ** (m - 1))

def K(L): return round(12 + 4 * L + 0.085 * L ** 2.5)
def need(L): return mobXP(L) * K(L)

if __name__ == '__main__':
    print('m  mobHP  mobATK  XP  gold  refDmg refHP refDR')
    for m in [1, 2, 5, 10, 12, 20, 23, 30, 34, 40, 45, 50, 56, 60, 67, 70, 78, 80, 89, 90, 100]:
        print(m, mobHP(m), mobATK(m), mobXP(m), mobGold(m), round(refDmg(m), 1), round(refHP(m)), round(refDR(m), 3))
