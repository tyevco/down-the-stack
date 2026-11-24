import combat4 as C, math, random
from model import g, DR
C.P['C_ATK']=0.03; C.P['regen_walk']=0.02; C.P['C_HP']=1.0
C.P['rf']=lambda m: 1.6+0.62*math.sqrt(m)
def fight(classes, L, Lb, Bk=40, atkm=1.6, aoe=0.20, aoe_every=25, invuln=0.12, enrage=180, seed=1, coffee=20):
    rng=random.Random(seed); n=len(classes)
    heroes=[C.Hero(c,L) for c in classes]
    sts=[dict(cd={'area':0,'buff':0,'ult':0},buff_t=0,actions=0,stand_t=0,retro_t=0,boss=True) for _ in heroes]
    hp=Bk*C.mobHP(Lb)*(1+0.75*(n-1)); maxhp=hp
    boss=dict(hp=hp,max=hp,m=Lb,arrived=True,new=False,eng=0)
    cof=[coffee]*n; ccd=[0]*n; down=[0]*n; used=0; crashes=0
    front=0
    for i,c in enumerate(classes):
        if c=='refactorer': front=i
    for t in range(1, enrage+1):
        inv = (t % 50) < 50*invuln   # invulnerable windows
        for i,h in enumerate(heroes):
            if down[i]>0:
                down[i]-=1
                if down[i]==0: h.hp=0.5*h.maxhp
                continue
            st=sts[i]
            for k in st['cd']: st['cd'][k]=max(0,st['cd'][k]-1)
            for k in ('buff_t','stand_t','retro_t'): st[k]=max(0,st[k]-1)
            d=C.rotation(h,st,boss,[boss],rng)+C.passives(h,st,boss,[boss],rng)
            if not inv: boss['hp']-=sum(x for _,x in d)
            boss['eng']+=1
        if boss['hp']<=0: return dict(win=True,t=t,coffee=used,crash=crashes)
        # boss attacks front (or next alive)
        alive=[i for i in range(n) if down[i]==0]
        if not alive: return dict(win=False,t=t,coffee=used,crash=crashes,wipe=True)
        tgt=front if down[front]==0 else alive[0]
        if t%2==0:
            h=heroes[tgt]; raw=C.mobATK(Lb)*atkm*rng.uniform(0.9,1.1)
            dr=min(0.75,DR(h.armor,Lb)+h.drflat)
            if rng.random()>=h.dodge: h.hp-=raw*(1-dr)
        if t%aoe_every==0:
            for i in alive: heroes[i].hp-=aoe*heroes[i].maxhp*(1-heroes[i].drflat)
        for i,h in enumerate(heroes):
            if down[i]>0: continue
            h.hp=min(h.maxhp,h.hp+0.005*h.maxhp)
            ccd[i]=max(0,ccd[i]-1)
            if h.hp/h.maxhp<0.45 and ccd[i]==0 and cof[i]>0 and h.hp>0:
                h.hp=min(h.maxhp,h.hp+0.35*h.maxhp); cof[i]-=1; used+=1; ccd[i]=5
            if h.hp<=0: crashes+=1; down[i]=10
    return dict(win=False,t=enrage,coffee=used,crash=crashes,left=boss['hp']/maxhp)
import statistics
for Lb in [23,45,67,89]:
  for d in [0,2,3,4]:
    for party in [['refactorer'],['hotfixer'],['shellmancer'],['rubberducker'],['refactorer','shellmancer','rubberducker']]:
      L=Lb-d
      rs=[fight(party,L,Lb,seed=s) for s in range(20)]
      wins=sum(r['win'] for r in rs)/len(rs)
      tt=statistics.mean(r['t'] for r in rs)
      cf=statistics.mean(r['coffee'] for r in rs)/len(party)
      cr=statistics.mean(r['crash'] for r in rs)
      print(f"Lb{Lb} d{d} {'+'.join(p[:4] for p in party):16s} win {wins:.2f} t {tt:5.0f} coffee/hero {cf:4.1f} crashes {cr:.1f}")
  print()
