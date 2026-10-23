"""
텔레메트리 실측 검증 (Day 3 - 2단계)

질문: data/ 의 수치(기본 피해량 × 부위 배율 × 분류 배율 × (1 − 방어구 감소율))로
      실제 경기의 피해량이 설명되는가?

입력: data/raw/telemetry_*.json (받아 둔 경기 전부), data/ 의 무기·부위·분류·거리·방어구 CSV
출력:
  data/verify_damage_summary.csv   무기별 일치율
  data/verify_zone_map.csv         텔레메트리 부위 기록(HeadShot 등) ↔ 13개 세부 부위 대응 (실측으로 찾은 것)

방법:
  1. 피격 이벤트(LogPlayerTakeDamage) 중 총기 피해만, 벽 관통·기절 상태·체력에 잘린 발은 제외
  2. 맞은 사람의 그 순간 조끼·헬멧 레벨을 장착/해제/파괴 이벤트로 추적
  3. 거리 감쇠가 없는 거리(falloff.csv에서 0m 값이 그대로 유지되는 구간)의 피격만 정확 비교
  4. 13개 부위 × 방어구 레벨 조합 중 실제 피해량과 맞는 것을 찾는다
     - 추적한 레벨로 맞으면 "일치", 다른 레벨로만 맞으면 "레벨 다름", 어디에도 안 맞으면 "불일치"
  5. 감쇠 구간 피격은 측정 지점 사이(가까운 지점 값 ~ 먼 지점 값) 범위 안인지만 확인

필드 의미 (확인한 것만 사용):
  - victim.health: 맞기 "전" 체력, damage: 방어구 적용 후 피해 (작성자 확인 10/19)
  - location 단위: cm (공식 문서 telemetry-objects)
  - 방어구 레벨: itemId의 Lv 숫자 (공식 pubg/api-assets itemId 사전: Item_Armor_D_01_Lv2_C = Police Vest (Level 2))
  - 조끼 파괴(LogArmorDestroy)는 같은 attackId의 피격보다 먼저 기록됨 (10/20 확인)
  - 개인 정보: 계정 ID는 추적에만 쓰고 저장하지 않는다

사용법: .venv/bin/python scripts/verify_damage.py
"""

import csv
import glob
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW_DIR = DATA / "raw"

TOL = 0.1          # 계산값과 실측값이 이 이하로 차이 나면 같은 값으로 본다 (표시 소수점 오차)
CLIP_EPS = 0.01    # 체력에 맞춰 잘린 발 판단 오차
SLOT = {"Vest": "vest", "Headgear": "helmet"}
FOCUS = ["M416", "AKM", "베릴 M762"]  # Day 3 지시문의 주요 무기 (화면 출력 순서용)
GROUP_KO = {"helmet": "머리·목", "vest": "몸통", "none": "팔·다리"}  # 덮는 방어구 → 화면용 부위 묶음 이름


def read_csv(name):
    with open(DATA / name, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def load_model():
    """ data/ 파일 → 계산에 필요한 표 """
    weapons = read_csv("weapons.csv")
    by_api = {}
    for w in weapons:
        for aid in filter(None, w["api_id"].split("|")):
            by_api.setdefault(aid, w)  # MG3처럼 같은 ID가 두 줄이면 첫 줄 (피해량 같음)
    falloff = defaultdict(list)
    for r in read_csv("falloff.csv"):
        if r["base_damage"]:
            falloff[r["weapon"]].append((int(r["distance_m"]), float(r["base_damage"])))
    zones = read_csv("hit_zones.csv")
    cmult = {(r["weapon"], r["zone"]): float(r["class_mult"]) for r in read_csv("weapon_multipliers.csv")}
    # level은 숫자(0~3) 또는 "broken"(부서진 조끼, 10/21 실측)
    red = {(r["item"], int(r["level"]) if r["level"].isdigit() else r["level"]): float(r["damage_reduction"])
           for r in read_csv("armor.csv")}
    return by_api, {k: sorted(v) for k, v in falloff.items()}, zones, cmult, red


def flat_range(points):
    """ 0m 값이 그대로 유지되는 가장 먼 측정 거리 (그 안에서는 감쇠 없음) """
    if not points or points[0][0] != 0:
        return None
    far = 0
    for d, v in points:
        if v != points[0][1]:
            break
        far = d
    return far


def bracket(points, dist):
    """ 측정 지점 사이 거리 → (먼 지점 값, 가까운 지점 값). 측정 범위 밖이면 None """
    for (d1, v1), (d2, v2) in zip(points, points[1:]):
        if d1 <= dist <= d2:
            return min(v1, v2), max(v1, v2)
    return None


class ArmorTracker:
    """ 경기 하나에서 계정별 조끼·헬멧 상태를 시간순으로 추적한다.
    - 장착(LogItemEquip): 그 레벨로 / 해제(LogItemUnequip): 같은 아이템일 때만 없앰
    - 파괴(LogArmorDestroy): armor.csv에 "broken" 줄이 있는 방어구(조끼)는 장착 해제 기록이 나오기 전까지 "broken" 상태로 남는다
      (10/21 실측: 부서진 조끼를 입은 채 맞으면 파괴 기록이 반복되고 몸통 피해는 0.8배, 64/64. 작성자 확인)
      그 줄이 없는 방어구(헬멧)는 파괴되면 없앰 (부서진 채로 맞은 기록 없음)
    - 파괴 기록은 같은 attackId의 피격보다 먼저 남으므로, 그 공격 직전 상태를 따로 기억한다
    """

    def __init__(self, red):
        self.armor = defaultdict(dict)   # 계정 → {slot: (itemId, 레벨 또는 "broken")}
        self.before = {}                 # (계정, attackId, slot) → 파괴 직전 레벨
        self.keeps_broken = {slot for slot, lv in red if lv == "broken"}

    def handle(self, e):
        """ 방어구 이벤트면 상태를 바꾸고 (slot, 계정)을 돌려준다. 아니면 None """
        if e["_T"] not in ("LogItemEquip", "LogItemUnequip", "LogArmorDestroy"):
            return None
        slot = SLOT.get(e["item"].get("subCategory"))
        if not slot:
            return None
        who = (e.get("character") or e.get("victim") or {}).get("accountId")
        lv = re.search(r"_Lv(\d)_", e["item"]["itemId"])
        cur = self.armor[who].get(slot)
        if e["_T"] == "LogItemEquip" and lv:
            self.armor[who][slot] = (e["item"]["itemId"], int(lv.group(1)))
        elif e["_T"] == "LogItemUnequip" and cur and cur[0] == e["item"]["itemId"]:
            self.armor[who].pop(slot)  # 갈아입을 때 새 장비가 먼저 기록돼도 지워지지 않게
        elif e["_T"] == "LogArmorDestroy" and cur:
            self.before[(who, e["attackId"], slot)] = cur[1]
            if slot in self.keeps_broken:
                self.armor[who][slot] = (cur[0], "broken")
            else:
                self.armor[who].pop(slot)
        return slot, who

    def level(self, who, attack_id):
        """ 이 공격을 맞을 때의 방어구 레벨 {vest, helmet} """
        return {s: self.before.get((who, attack_id, s), (self.armor[who].get(s) or (None, 0))[1])
                for s in ("vest", "helmet")}

    def item(self, who, slot):
        return (self.armor[who].get(slot) or ("없음",))[0]


def candidates(base, weapon, zones, cmult, red):
    """ 13개 부위 × 방어구 레벨 조합별 예상 피해량 """
    out = []
    for z in zones:
        m = cmult.get((weapon, z["zone"]))
        if m is None:
            continue
        slot = z["armor_slot"]
        levels = [0, 1, 2, 3] if slot in ("vest", "helmet") else [0]
        if (slot, "broken") in red:
            levels.append("broken")
        for lv in levels:
            out.append((z["zone"], slot, lv, base * float(z["hit_area"]) * m * (1 - red.get((slot, lv), 0))))
    return out


def dist_m(a, b):
    la, lb = a["location"], b["location"]
    return math.dist((la["x"], la["y"], la["z"]), (lb["x"], lb["y"], lb["z"])) / 100  # cm → m


def main():
    by_api, falloff, zones, cmult, red = load_model()
    # 설정한 경기 유형(matchType)만 사용 — 이벤트 경기는 규칙이 다를 수 있음
    allowed = next(r["value"] for r in read_csv("settings.csv") if r["key"] == "verify_match_types").split("|")
    # 내 경기(data/raw/) + 공식 무작위 경기(data/raw/samples/, fetch_samples.py). 같은 경기는 한 번만
    files, skipped, seen = [], Counter(), set()
    paths = sorted(glob.glob(str(RAW_DIR / "telemetry_*.json"))) + sorted(glob.glob(str(RAW_DIR / "samples" / "telemetry_*.json")))
    for f in paths:
        mid = Path(f).stem.removeprefix("telemetry_")
        if mid in seen:
            continue
        seen.add(mid)
        mtype = json.load(open(Path(f).parent / f"match_{mid}.json", encoding="utf-8"))["data"]["attributes"].get("matchType")
        if mtype in allowed:
            files.append(f)
        else:
            skipped[mtype] += 1

    stats = defaultdict(Counter)      # 무기 → 결과별 개수
    zone_map = defaultdict(Counter)   # 텔레메트리 부위 → 맞은 세부 부위 묶음
    destroy_hit = Counter()           # 조끼를 부순 그 발이 어느 레벨로 맞았나
    far_check = defaultdict(Counter)  # 감쇠 구간 범위 확인
    dur_check = Counter()             # 조끼가 이미 맞은 횟수별 일치 (내구도 영향 확인용)
    level_check = Counter()           # (방어구, 레벨) → 그 레벨로 일치한 발수
    class_check = Counter()           # (분류, 부위 묶음) → 일치한 발수
    nomatch_examples = []
    nonspec = Counter()               # 부위 지정 없는 피격(NonSpecific): 기본 피해량 ×1.0 그대로인지

    for f in files:
        tel = json.load(open(f, encoding="utf-8"))
        tel.sort(key=lambda e: e["_D"])  # 기록 순서가 완전한 시간순이 아님 (정렬은 안정 정렬)
        tracker = ArmorTracker(red)      # 계정별 조끼·헬멧 상태
        hits_on_vest = Counter()         # (계정, 조끼 itemId) → 맞은 횟수

        for e in tel:
            t = e["_T"]
            if tracker.handle(e):
                continue

            if t != "LogPlayerTakeDamage" or e.get("damageTypeCategory") != "Damage_Gun":
                continue
            w = by_api.get(e.get("damageCauserName"))
            v, a = e.get("victim") or {}, e.get("attacker") or {}
            if not w or not v or not a.get("location") or e["damage"] <= 0:
                continue
            if e.get("isThroughPenetrableWall") or v.get("isDBNO"):
                continue
            if v["health"] - e["damage"] < CLIP_EPS:
                continue  # 남은 체력만큼만 들어간 발 (실제 위력보다 작음)

            who = v.get("accountId")
            name = w["weapon"]
            level = tracker.level(who, e["attackId"])
            pts = falloff.get(name, [])
            d = dist_m(a, v)
            fr = flat_range(pts)

            if fr is None:
                continue
            # 부위 지정 없는 피격(NonSpecific)은 부위 비교에서 뺀다
            # 10/20 확인: 감쇠 없는 거리 477발 모두 기본 피해량 ×1.0 (부위·분류 배율 미적용. 방어구 적용 여부·발생 원인은 모름)
            if e.get("damageReason") == "NonSpecific":
                if d <= fr:
                    nonspec["×1.0 일치" if abs(e["damage"] - pts[0][1]) <= TOL else "다른 값"] += 1
                continue
            if d > fr:
                # 감쇠 구간: 측정 지점 사이 범위 안인지만 확인
                br = bracket(pts, d)
                if br is None:
                    far_check[name]["측정 범위 밖"] += 1
                    continue
                lo = candidates(br[0], name, zones, cmult, red)
                hi = candidates(br[1], name, zones, cmult, red)
                ok = any(l[3] - TOL <= e["damage"] <= h[3] + TOL and l[2] == level.get(l[1], 0)
                         for l, h in zip(lo, hi))
                far_check[name]["범위 안" if ok else "범위 밖"] += 1
                continue

            # 감쇠 없는 거리: 정확 비교
            base = pts[0][1]
            matches = [c for c in candidates(base, name, zones, cmult, red) if abs(c[3] - e["damage"]) <= TOL]
            tracked = [c for c in matches if c[2] == level.get(c[1], 0)]
            reason = e.get("damageReason")
            if tracked:
                stats[name]["일치"] += 1
                zone_map[reason][" / ".join(sorted({c[0] for c in tracked}))] += 1
                # 어느 방어구 레벨·분류 배율이 확인됐는지 (부위 묶음이 하나로 정해지는 발만)
                groups = {(c[1], c[2]) for c in tracked}
                if len(groups) == 1:
                    slot, lv = groups.pop()
                    level_check[(slot, lv)] += 1
                    class_check[(w["class"], GROUP_KO[slot])] += 1
                if any(c[1] == "vest" for c in tracked) and level["vest"]:
                    key = (who, tracker.item(who, "vest"))
                    dur_check[min(hits_on_vest[key], 5)] += 1
            elif matches:
                stats[name]["레벨 다름"] += 1
            else:
                stats[name]["불일치"] += 1
                if len(nomatch_examples) < 15:
                    nomatch_examples.append((name, reason, round(e["damage"], 2), level, round(d)))
            # 조끼 파괴 기록이 함께 남은 발: 처음 부서지는 발 / 이미 부서진 채로 맞은 발
            if (who, e["attackId"], "vest") in tracker.before:
                pre = tracker.before[(who, e["attackId"], "vest")]
                kind = "부서진 채로 맞은 발" if pre == "broken" else "처음 부서지는 발"
                ok = any(c[1] == "vest" and c[2] == pre for c in matches)
                destroy_hit[f"{kind}: {'직전 상태로 일치' if ok else '어느 쪽도 아님'}"] += 1
            if reason in ("TorsoShot", "PelvisShot") and level["vest"]:
                hits_on_vest[(who, tracker.item(who, "vest"))] += 1

    # ── 저장 ─────────────────────────────────────────────
    rows = []
    # 감쇠 구간 표본만 있는 무기(감쇠가 짧은 거리부터 시작하는 SMG 등)도 표에 넣는다
    for name in FOCUS + sorted(n for n in set(stats) | set(far_check) if n not in FOCUS):
        s, fc = stats.get(name, Counter()), far_check.get(name, Counter())
        n = sum(s.values())
        if n == 0 and not fc:
            continue
        rows.append({
            "weapon": name, "near_n": n, "match": s["일치"], "level_diff": s["레벨 다름"], "no_match": s["불일치"],
            "match_rate": f"{s['일치'] / n:.3f}" if n else "",
            "far_n": fc["범위 안"] + fc["범위 밖"], "far_in_range": fc["범위 안"], "far_out_range": fc["범위 밖"],
        })
    with open(DATA / "verify_damage_summary.csv", "w", encoding="utf-8", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        wr.writeheader()
        wr.writerows(rows)
    with open(DATA / "verify_zone_map.csv", "w", encoding="utf-8", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=["damage_reason", "matched_zones", "count"])
        wr.writeheader()
        for reason, c in sorted(zone_map.items()):
            for zs, k in c.most_common():
                wr.writerow({"damage_reason": reason, "matched_zones": zs, "count": k})

    # ── 화면 출력 ─────────────────────────────────────────
    print(f"경기 {len(files)}개 ({'·'.join(allowed)})" + (f" · 제외 {dict(skipped)}" if skipped else "")
          + " · 감쇠 없는 거리의 피격만 정확 비교\n")
    print(f"{'무기':<14}{'표본':>5}{'일치':>6}{'레벨다름':>8}{'불일치':>6}{'일치율':>8} | {'감쇠구간':>6}{'범위안':>6}")
    for r in rows:
        rate = f"{float(r['match_rate']) * 100:.0f}%" if r["match_rate"] else "-"
        print(f"{r['weapon']:<14}{r['near_n']:>5}{r['match']:>6}{r['level_diff']:>8}{r['no_match']:>6}{rate:>8} | {r['far_n']:>6}{r['far_in_range']:>6}")
    tot = Counter()
    for s in stats.values():
        tot.update(s)
    n = sum(tot.values())
    print(f"\n전체 {n}발: 일치 {tot['일치']} ({tot['일치'] / n:.1%}) · 레벨 다름 {tot['레벨 다름']} · 불일치 {tot['불일치']}")

    print("\n텔레메트리 부위 기록 → 실측으로 맞은 세부 부위")
    for reason, c in sorted(zone_map.items()):
        print(f"  {reason:<12}", ", ".join(f"{zs} {k}" for zs, k in c.most_common()))
    print("\n방어구 레벨별 일치 발수:", ", ".join(f"{s} {lv}{'' if lv == 'broken' else '레벨'} {k}"
                                         for (s, lv), k in sorted(level_check.items(), key=lambda kv: (kv[0][0], str(kv[0][1])))))
    print("분류·부위 묶음별 일치 발수:", ", ".join(f"{c} {g} {k}" for (c, g), k in sorted(class_check.items())))
    print("\n부위 지정 없는 피격(NonSpecific, 감쇠 없는 거리) — 기본 피해량 ×1.0인지:", dict(nonspec))
    print("조끼 파괴 기록이 함께 남은 발:", dict(sorted(destroy_hit.items())))
    print("조끼가 이미 맞은 횟수별 일치 발수 (5 = 5회 이상):", dict(sorted(dur_check.items())))
    if nomatch_examples:
        print("\n불일치 예시 (무기, 부위 기록, 피해량, 추적한 방어구, 거리m):")
        for x in nomatch_examples:
            print("  ", x)


if __name__ == "__main__":
    main()
