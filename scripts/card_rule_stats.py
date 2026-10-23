"""
결과 화면 카드("쓰러진 공격") 표시 규칙의 근거 숫자 (10/23) → docs/03_검증기록.md 7절

  1. 작성자 일반 경기: 기절 원인 중 부위가 남는 공격(settings.csv card_damage_categories) 비율
     → 카드 대부분이 실루엣으로 보이는가
  2. 작성자 일반 경기: 수류탄 한 번의 폭발이 적 몇 명에게 피해를 줬나
     → "외 N명에게도 피해" 규칙이 필요한가
  3. 무작위 일반 경기 100개: 사람이 총에 쓰러진 교전에서 맞은 총 종류 수·공격자 수
     → 버튼 글자를 "마지막 총 외 N종"으로 줄여야 하는가

정의 (기준값은 data/settings.csv):
  - 경기: verify_match_types 에 맞는 경기만 (일반 경기)
  - 1. 기절 = LogPlayerMakeGroggy (모든 플레이어). 원인 = damageTypeCategory
  - 2. 같은 공격자의 수류탄 피해를 same_moment_sec 안에 묶어 "한 번의 폭발"로 봄. 자기 자신·팀원은 뺌
       (블루존 수류탄·화염병은 피해가 몇 초에 걸쳐 나뉘어 들어와 "한 번"을 나눌 수 없으므로 세지 않음)
  - 3. 쓰러짐 = 기절 상태가 아닌 사람(type == "user")이 총에 맞아 체력이 0이 되는 피격 (user_evidence.py와 같은 정의)
       교전 = 쓰러진 발부터 거슬러 올라가며 맞은 총 사이가 engagement_gap_sec 이하인 발들

사용법: .venv/bin/python scripts/card_rule_stats.py
"""

from collections import Counter, defaultdict

from user_evidence import ST, downs_from_hits, gun_hits, matches, t

ZONE_CATS = {c.strip() for c in ST["card_damage_categories"].split(";") if c.strip()}
GAP = float(ST["engagement_gap_sec"])
SAME = float(ST["same_moment_sec"])
GRENADE = "Damage_Explosion_Grenade"


def own_matches():
    """ 작성자 일반 경기 (전체 기록) — 1·2번이 같은 경기 목록을 쓰도록 한 번만 읽음 """
    return [tel for _, tel in matches(own=True)]


def knock_causes(tels):
    """ 1. 기절 원인별 횟수 """
    c = Counter()
    for tel in tels:
        for e in tel:
            if e["_T"] == "LogPlayerMakeGroggy":
                c[e.get("damageTypeCategory")] += 1
    return c


def grenade_victims(tels):
    """ 2. 수류탄 한 번의 폭발이 피해를 준 적의 수 → {적 수: 폭발 수} """
    res = Counter()
    for tel in tels:
        groups = defaultdict(list)   # 공격자 → [(시각, 맞은 사람)]
        for e in tel:
            if e["_T"] != "LogPlayerTakeDamage" or e.get("damageTypeCategory") != GRENADE or e.get("damage", 0) <= 0:
                continue
            a, v = e.get("attacker") or {}, e.get("victim") or {}
            if not a.get("accountId") or a["accountId"] == v.get("accountId") or a.get("teamId") == v.get("teamId"):
                continue
            groups[a["accountId"]].append((t(e["_D"]), v["accountId"]))
        for evs in groups.values():
            evs.sort()
            start, victims = None, set()
            for ts, v in evs:
                if start is None or (ts - start).total_seconds() > SAME:
                    if victims:
                        res[len(victims)] += 1
                    start, victims = ts, set()
                victims.add(v)
            if victims:
                res[len(victims)] += 1
    return res


def multi_weapon_downs():
    """ 3. 사람이 총에 쓰러진 교전에서 맞은 총 종류 수·공격자 수 → (쓰러짐 수, 총 종류 Counter, 공격자 Counter) """
    w_cnt, a_cnt, n = Counter(), Counter(), 0
    for _, tel in matches(own=False):
        hits = gun_hits(tel)
        for d in downs_from_hits(hits):
            if d["victim"].get("type") != "user":
                continue
            v = d["victim"]["accountId"]
            before = [h for h in hits if h["victim"]["accountId"] == v and h["_D"] <= d["_D"] and not h["victim"].get("isDBNO")]
            seq = [before[-1]]
            for h in reversed(before[:-1]):
                if (t(seq[0]["_D"]) - t(h["_D"])).total_seconds() > GAP:
                    break
                seq.insert(0, h)
            n += 1
            w_cnt[len({h["damageCauserName"] for h in seq})] += 1
            a_cnt[len({h["attacker"]["accountId"] for h in seq})] += 1
    return n, w_cnt, a_cnt


def pct(a, b):
    return f"{a / b:.1%}" if b else "-"


def main():
    tels = own_matches()
    knocks = knock_causes(tels)
    n_knock = sum(knocks.values())
    n_zone = sum(v for k, v in knocks.items() if k in ZONE_CATS)
    print(f"[1] 작성자 일반 경기 {len(tels)}개 · 기절 {n_knock}회 (모든 플레이어)")
    print(f"    부위가 남는 공격: {n_zone}회 ({pct(n_zone, n_knock)}) · 그중 총(Damage_Gun): {knocks['Damage_Gun']}회 ({pct(knocks['Damage_Gun'], n_knock)})")
    for k, v in knocks.most_common():
        print(f"      {k}: {v}")

    g = grenade_victims(tels)
    n_g = sum(g.values())
    multi = sum(v for k, v in g.items() if k >= 2)
    print(f"\n[2] 수류탄 폭발 {n_g}번 중 적 2명 이상에게 피해: {multi}번 ({pct(multi, n_g)}) · 적 수별 {dict(sorted(g.items()))}")

    n, w_cnt, a_cnt = multi_weapon_downs()
    w2 = sum(v for k, v in w_cnt.items() if k >= 2)
    a2 = sum(v for k, v in a_cnt.items() if k >= 2)
    print(f"\n[3] 무작위 일반 경기 · 사람이 총에 쓰러진 {n}회")
    print(f"    2종 이상의 총에 맞음: {w2}회 ({pct(w2, n)}) · 2명 이상에게 맞음: {a2}회 ({pct(a2, n)})")


if __name__ == "__main__":
    main()
