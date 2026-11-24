import math
import model as M
def g(x): return 1.07**(max(1,x)-1)
refHit=M.refDmg; refHP=M.refHP
def refDR(m): return M.DR(M.refArmor(m), m)
def mobHP(m,mult=1.0): return round((1.6+0.62*math.sqrt(m))*refHit(m)*mult)
def mobATK(m,mult=1.0): return round(0.03*refHP(m)/(1-refDR(m))*mult)
def mobXP(m): return round((4+m)*1.06**(m-1))
def gold(m): return round((2+m)*1.05**(m-1))
def K(L): return round(22+8*L+0.18*L**2.5)
def need(L): return mobXP(L)*K(L)
print("| m | refHit | mobHP | mobATK | refHP | refDR | XP | gold | K | Need |")
for m in [1,2,3,5,8,10,12,15,20,23,25,30,34,40,45,50,56,60,67,70,78,80,89,90,99,100]:
    print(f"| {m} | {refHit(m):.1f} | {mobHP(m)} | {mobATK(m)} | {refHP(m):.0f} | {refDR(m)*100:.0f}% | {mobXP(m)} | {gold(m)} | {K(m)} | {need(m)} |")
print()
BOSS=[(12,16,1.0),(23,28,1.3),(34,32,1.6),(45,32,1.6),(56,32,1.6),(67,32,1.6),(78,32,1.6),(89,32,1.6),(100,40,1.6)]
for i,(Lb,Bk,Ak) in enumerate(BOSS):
    h=lambda n: round(Bk*mobHP(Lb)*(1+0.75*(n-1)))
    print(f"boss{i+1} L{Lb} HP solo {h(1)} duo {h(2)} trio {h(3)} six {h(6)} swing {round(Ak*mobATK(Lb))} refHP {refHP(Lb):.0f}")
print('trial1', 20*mobHP(30), round(1.3*mobATK(30)), 'trial2', 26*mobHP(60), round(2*mobATK(60)), 'nitpick', mobHP(60), round(0.5*mobATK(60)))
def need_r(r): return round(8*r**1.35)
print('release', [(r,need_r(r)) for r in (1,5,10,20,30,40,50,60)])
# cumulative pure hours
t=0
for L in range(1,100):
    t+=K(L)/15.5
    if L+1 in (2,5,10,20,30,40,50,60,70,80,90,100): print('pure to',L+1, round(t/60,2),'h')
# polish cost at i=50
for i in (10,30,50,80,100):
    tot=sum(round(100*g(i)*(p+1)**1.6) for p in range(9))
    print('polish 0->9 at i',i,'=',tot,'gold; income/h ~',round(1050*gold(i)))
for n in range(1,11): print('bldg',n, round(800*3**(n-1)))
