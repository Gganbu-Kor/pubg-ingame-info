"""
총 분류별 "실제로 쓰이는 거리" 기준값 (10/23, 작성자 결정: 방법 B)
  → 출시 후 지표 "신규 유저의 명중이 이 범위 안에 드는 비율이 전체 유저 수준에 가까워지는가"의 출시 전 기준값

방법:
  - 데이터: data/raw/samples/ 무작위 일반 경기 100개의 총기 피격 기록 (settings.csv의 verify_match_types)
  - 거리: 공격자와 맞은 사람의 위치 사이 거리 (cm → m, verify_damage.py와 같은 계산)
  - 무기 → 분류: weapons.csv의 api_id → class
  - 뺄 것: 봇이 쏜 기록(사람만), 이미 기절한 사람·체력 0 이하를 맞힌 기록, 자기 자신
    · 무작위 경기에는 팀 번호가 없어 팀원 사격은 뺄 수 없음
  - 세는 단위: 교전(같은 공격자가 같은 상대를 맞힌 발 사이가 engagement_gap_sec 이하인 묶음)마다 첫 명중 거리 하나
    · 비교용으로 피격마다 센 값도 함께 냄 (연사가 빠른 총일수록 피격 수가 많아 쏠림)
  - 결과: 분류별 교전 수, 거리 중앙값, 가운데 50% 범위(25~75%), 공식 "쓰는 거리" 글(classes.csv)

한계: 빗나간 총알은 기록에 없어 "쏜 거리"가 아니라 "맞힌 거리". 신규 유저는 구분할 수 없음(계정 나이 없음).

출력: data/weapon_range_baseline.csv, 화면 요약
사용법: .venv/bin/python scripts/weapon_range_baseline.py
"""

import csv
import statistics
from collections import defaultdict
from pathlib import Path

from user_evidence import ST, gun_hits, matches, t
from verify_damage import dist_m, load_model

ROOT = Path(__file__).resolve().parent.parent
GAP = float(ST["engagement_gap_sec"])


def quartiles(xs):
    """ (25%, 중앙값, 75%) — 값이 하나뿐이면 그 값 """
    if len(xs) < 2:
        return (xs[0],) * 3
    q = statistics.quantiles(xs, n=4, method="inclusive")
    return q[0], q[1], q[2]


def main():
    by_api = load_model()[0]
    with open(ROOT / "data" / "classes.csv", encoding="utf-8-sig") as f:
        classes = {r["class"]: r for r in csv.DictReader(f)}

    per_hit = defaultdict(list)      # 분류 → 피격마다 거리
    first_hit = defaultdict(list)    # 분류 → 교전마다 첫 명중 거리
    n_match = 0
    for _, tel in matches(own=False):
        n_match += 1
        last = {}  # (공격자, 맞은 사람) → 그 쌍의 마지막 명중 시각 (교전 묶기)
        for h in gun_hits(tel):
            a, v = h["attacker"], h["victim"]
            w = by_api.get(h.get("damageCauserName"))
            if (not w or a.get("type") != "user" or v.get("isDBNO") or v.get("health", 0) <= 0
                    or not a.get("location") or not v.get("location")):
                continue
            cls, d = w["class"], dist_m(a, v)
            per_hit[cls].append(d)
            key, now = (a["accountId"], v["accountId"]), t(h["_D"])
            if key not in last or (now - last[key]).total_seconds() > GAP:
                first_hit[cls].append(d)   # 새 교전의 첫 명중
            last[key] = now

    rows = []
    for cls in sorted(first_hit, key=lambda c: statistics.median(first_hit[c])):
        q1, med, q3 = quartiles(first_hit[cls])
        hq1, hmed, hq3 = quartiles(per_hit[cls])
        rows.append({
            "class": cls, "name_ko": classes.get(cls, {}).get("name_ko", cls),
            "official_range": classes.get(cls, {}).get("range", ""),
            "engagements": len(first_hit[cls]), "median_m": round(med), "q25_m": round(q1), "q75_m": round(q3),
            "hits": len(per_hit[cls]), "hit_median_m": round(hmed), "hit_q25_m": round(hq1), "hit_q75_m": round(hq3),
            "source": f"무작위 일반 경기 {n_match}개 (data/raw/samples, 10/19) · 사람이 쏜 총기 명중 · 교전마다 첫 명중",
        })
    with open(ROOT / "data" / "weapon_range_baseline.csv", "w", encoding="utf-8", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=list(rows[0]))
        wr.writeheader()
        wr.writerows(rows)

    print(f"무작위 일반 경기 {n_match}개 · 교전마다 첫 명중 거리 (m)")
    print(f"{'분류':<6}{'공식 쓰는 거리':<14}{'교전 수':>8}{'중앙값':>8}{'가운데 50%':>14}   | 피격마다: 수, 중앙값, 가운데 50%")
    for r in rows:
        print(f"{r['name_ko']:<6}{r['official_range']:<14}{r['engagements']:>8}{r['median_m']:>8}"
              f"{r['q25_m']:>7}~{r['q75_m']:<6}   | {r['hits']:>6} {r['hit_median_m']:>5} {r['hit_q25_m']:>5}~{r['hit_q75_m']}")


if __name__ == "__main__":
    main()
