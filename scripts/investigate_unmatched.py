"""
불일치 피격 자세히 보기 (Day 4, 10/21)

질문: verify_damage.py에서 계산과 맞지 않은 피격(대부분 계산값의 0.8배)은 정상 피격과 무엇이 다른가?
방법: verify_damage.py와 같은 조건·같은 방어구 추적으로 다시 돌면서,
      불일치 피격과 정상(일치) 피격의 기록된 필드를 나란히 센다. 원인은 추측하지 않는다.

출력: 화면 표 + data/unmatched_hits.csv (계정 ID·닉네임 없음)
사용법: .venv/bin/python scripts/investigate_unmatched.py
"""

import csv
import glob
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_damage import (CLIP_EPS, DATA, RAW_DIR, TOL, ArmorTracker, candidates, dist_m,  # noqa: E402
                           flat_range, load_model, read_csv)

RATIO_TOL = 0.005  # "정확히 0.8배" 판정 오차


def t(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def main():
    by_api, falloff, zones, cmult, red = load_model()
    zko = {z["zone"]: z["zone_ko"] for z in zones}
    allowed = next(r["value"] for r in read_csv("settings.csv") if r["key"] == "verify_match_types").split("|")

    paths = sorted(glob.glob(str(RAW_DIR / "telemetry_*.json"))) + sorted(glob.glob(str(RAW_DIR / "samples" / "telemetry_*.json")))
    rows = []                          # 불일치 피격 한 줄씩
    base_cnt = defaultdict(Counter)    # 정상 피격의 필드별 분포 (비교 기준)
    seen = set()

    for f in paths:
        mid = Path(f).stem.removeprefix("telemetry_")
        if mid in seen:
            continue
        seen.add(mid)
        info = json.load(open(Path(f).parent / f"match_{mid}.json", encoding="utf-8"))["data"]["attributes"]
        if info.get("matchType") not in allowed:
            continue
        tel = json.load(open(f, encoding="utf-8"))
        tel.sort(key=lambda e: e["_D"])
        start = t(tel[0]["_D"])
        tracker = ArmorTracker(red)      # verify_damage.py와 같은 방어구 추적
        ever_vest = defaultdict(bool)    # 이 경기에서 조끼를 입은 적이 있나
        vest_broken = defaultdict(bool)  # 이 경기에서 조끼가 부서진 적이 있나
        last_armor_evt = {}              # 계정 → 마지막 조끼 관련 이벤트 (종류, 시각)
        hit_no = Counter()               # (공격자, 피격자) → 몇 번째 피격인지

        for e in tel:
            typ = e["_T"]
            got = tracker.handle(e)
            if got:
                slot, who = got
                if slot == "vest":
                    ever_vest[who] |= typ == "LogItemEquip"
                    vest_broken[who] |= typ == "LogArmorDestroy"
                    last_armor_evt[who] = (typ.removeprefix("Log"), t(e["_D"]))
                continue

            if typ != "LogPlayerTakeDamage" or e.get("damageTypeCategory") != "Damage_Gun":
                continue
            w = by_api.get(e.get("damageCauserName"))
            v, a = e.get("victim") or {}, e.get("attacker") or {}
            if not w or not v or not a.get("location") or e["damage"] <= 0:
                continue
            if e.get("isThroughPenetrableWall") or v.get("isDBNO") or v["health"] - e["damage"] < CLIP_EPS:
                continue
            if e.get("damageReason") == "NonSpecific":
                continue
            name = w["weapon"]
            pts = falloff.get(name, [])
            fr = flat_range(pts)
            d = dist_m(a, v)
            if fr is None or d > fr:
                continue  # 정확 비교 구간만

            who = v.get("accountId")
            level = tracker.level(who, e["attackId"])
            cands = candidates(pts[0][1], name, zones, cmult, red)
            matches = [c for c in cands if abs(c[3] - e["damage"]) <= TOL]
            tracked = [c for c in matches if c[2] == level.get(c[1], 0)]
            pair = (a.get("accountId"), who)
            hit_no[pair] += 1
            last = last_armor_evt.get(who)

            fields = {
                "분류": w["class"],
                "부위 기록": e.get("damageReason"),
                "맞은 쪽 종류": v.get("type", "?"),
                "쏜 쪽 종류": a.get("type", "?"),
                "추적한 조끼": "부서짐" if level["vest"] == "broken" else f"{level['vest']}레벨",
                "조끼 입은 적 있음": "예" if ever_vest[who] else "아니오",
                "조끼 부서진 적 있음": "예" if vest_broken[who] else "아니오",
                "맞은 쪽 차량": "예" if v.get("isInVehicle") else "아니오",
                "쏜 쪽 차량": "예" if a.get("isInVehicle") else "아니오",
                "모드": info.get("gameMode"),
            }
            if tracked:
                for k, val in fields.items():
                    base_cnt[k][val] += 1
                base_cnt["_n"]["n"] += 1
                continue
            if matches:
                continue  # 레벨 다름은 따로 보지 않음

            # 불일치: 추적한 레벨 기준 계산값 중 "정확히 0.8배"가 되는 부위 찾기
            same_lv = [c for c in cands if c[2] == level.get(c[1], 0)]
            r08 = [c for c in same_lv if abs(e["damage"] / c[3] - 0.8) <= RATIO_TOL]
            near = min(same_lv, key=lambda c: abs(e["damage"] - c[3]))
            rows.append({
                "match": mid[:8], "모드": info.get("gameMode"), "맵": info.get("mapName"),
                "경기 경과(분)": round((t(e["_D"]) - start).total_seconds() / 60, 1),
                "무기": name, "분류": w["class"], "부위 기록": e.get("damageReason"),
                "피해량": round(e["damage"], 2), "맞기 전 체력": round(v["health"], 1), "거리(m)": round(d),
                "0.8배 부위": " / ".join(sorted({zko[c[0]] for c in r08})) or "-",
                "0.8배 기준 계산값": round(r08[0][3], 2) if r08 else "",
                "가장 가까운 계산값": f"{zko[near[0]]} {near[3]:.2f}",
                "같은 상대에게 몇 번째": hit_no[pair],
                "마지막 조끼 이벤트": f"{last[0]} {(t(e['_D']) - last[1]).total_seconds():.0f}초 전" if last else "없음",
                **{k: fields[k] for k in ("맞은 쪽 종류", "쏜 쪽 종류", "추적한 조끼", "조끼 입은 적 있음",
                                          "조끼 부서진 적 있음", "맞은 쪽 차량", "쏜 쪽 차량")},
            })

    # ── 저장 ─────────────────────────────────────────────
    out = DATA / "unmatched_hits.csv"
    if rows:
        with open(out, "w", encoding="utf-8", newline="") as fp:
            wr = csv.DictWriter(fp, fieldnames=list(rows[0].keys()))
            wr.writeheader()
            wr.writerows(rows)

    # ── 화면 출력 ─────────────────────────────────────────
    n08 = sum(r["0.8배 부위"] != "-" for r in rows)
    print(f"불일치 {len(rows)}발 중 추적한 방어구 기준 '정확히 0.8배'(±{RATIO_TOL}): {n08}발\n")

    # 필드별 비교: 불일치 vs 정상
    nb = base_cnt["_n"]["n"]
    for k in ("맞은 쪽 종류", "쏜 쪽 종류", "추적한 조끼", "조끼 입은 적 있음", "조끼 부서진 적 있음",
              "부위 기록", "분류", "맞은 쪽 차량", "쏜 쪽 차량", "모드"):
        cu = Counter(r[k] for r in rows)
        keys = sorted(set(cu) | set(base_cnt[k]), key=lambda x: -cu[x])
        print(f"[{k}]")
        for x in keys:
            print(f"  {str(x):<12} 불일치 {cu[x]:>3}발 ({cu[x] / len(rows):>5.1%})  |  정상 {base_cnt[k][x]:>6}발 ({base_cnt[k][x] / nb:>5.1%})")
    print("\n[같은 상대에게 몇 번째 피격]", sorted(Counter(r["같은 상대에게 몇 번째"] for r in rows).items()))
    print("[경기 수]", len({r["match"] for r in rows}), "경기 · 한 경기 최다", Counter(r["match"] for r in rows).most_common(3))
    print(f"\n저장: {out.relative_to(DATA.parent)} ({len(rows)}줄)")


if __name__ == "__main__":
    main()
