"""
유저 근거: 공식 데이터로 본 실제 상황 (10/22)

질문. 쏘던 적을 쓰러뜨리지 못하고 내가 먼저 쓰러지는 상황은 얼마나 흔한가
  - 사람이 총에 쓰러진 순간마다, 직전 20초(engagement_gap_sec) 안에 적을 맞히고 있었는지
  - 그랬다면 마지막으로 맞힌 적에게 준 피해, 내 마지막 발 직후 그 적의 체력

데이터: data/raw/samples/ (공식 무작위 일반 경기 100개, 총기 피격·장착·해제·조끼 파괴 기록만)
        + data/raw/ 의 작성자 일반 경기 13개 (기준 대조용, 기절·사망 기록 포함)

정의 (작성자 경기의 전체 기록으로 대조해 정함, 기준값은 data/settings.csv):
  - 쓰러진 순간 = 기절 상태가 아닌 사람이 총에 맞아 체력이 0이 되는 피격
    · 무작위 경기에는 기절 기록이 없어서 이렇게 정의. 작성자 경기에서 실제 기절·사망 기록과 1,309/1,309 일치
  - 사람만 셈 (type == "user"). 봇(user_ai)은 제외
  - 적을 맞힌 발 = 기절하지 않고 체력이 남아 있던 상대에게 맞힌 총기 피격
    · 무작위 경기는 팀 번호가 없어 팀원 사격을 구분 못 함 → 작성자 경기로 팀원 사격 비율을 함께 측정
  - 상대 체력은 "내 마지막 발 직후" 값 (그 뒤 회복·다른 사람의 피해는 반영 안 함)
  - 내 두 발 사이 상대 체력이 target_reset_heal_hp 이상 오르면(회복) 그 뒤 발만 셈 (analyze_my_match.py와 같은 규칙)

출력: data/user_evidence.json, 화면 요약
사용법: .venv/bin/python scripts/user_evidence.py
"""

import csv
import glob
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
CLIP_EPS = 0.01


def t(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def settings():
    with open(ROOT / "data" / "settings.csv", encoding="utf-8-sig") as f:
        return {r["key"]: r["value"] for r in csv.DictReader(f)}


ST = settings()


def matches(own):
    """ (match_id, 이벤트 목록) — own=True: 작성자 경기(전체 기록), False: 무작위 경기(일부 기록) """
    folder = RAW if own else RAW / "samples"
    for f in sorted(glob.glob(str(folder / "telemetry_*.json"))):
        mid = Path(f).stem.removeprefix("telemetry_")
        info = json.load(open(folder / f"match_{mid}.json", encoding="utf-8"))["data"]["attributes"]
        if info.get("matchType") != ST["verify_match_types"]:
            continue
        tel = json.load(open(f, encoding="utf-8"))
        tel.sort(key=lambda e: e["_D"])
        yield mid, tel


def gun_hits(tel):
    return [e for e in tel if e["_T"] == "LogPlayerTakeDamage" and e.get("damageTypeCategory") == "Damage_Gun"
            and e["damage"] > 0 and (e.get("attacker") or {}).get("accountId") and (e.get("victim") or {}).get("accountId")
            and e["attacker"]["accountId"] != e["victim"]["accountId"]]


def downs_from_hits(hits):
    """ 쓰러진 순간: 기절 상태가 아닌 사람이 총에 맞아 체력이 0이 됨 """
    return [h for h in hits if not h["victim"].get("isDBNO") and h["victim"]["health"] - h["damage"] <= CLIP_EPS]


def last_target(hits, down, gap, reset_hp):
    """ 쓰러진 사람이 직전 gap초 안에 마지막으로 맞힌 적과, 그 적에게 맞힌 발들 (회복 뒤 다시 셈) """
    me, td = down["victim"]["accountId"], t(down["_D"])
    mine = [h for h in hits if h["attacker"]["accountId"] == me and not h["victim"].get("isDBNO")
            and h["victim"]["health"] > 0 and h["_D"] <= down["_D"] and (td - t(h["_D"])).total_seconds() <= gap]
    if not mine:
        return None
    target = mine[-1]["victim"]
    seq = []
    for h in reversed([h for h in mine if h["victim"]["accountId"] == target["accountId"]]):
        if seq and seq[0]["victim"]["health"] - (h["victim"]["health"] - h["damage"]) >= reset_hp:
            break
        seq.insert(0, h)
    return {"damage": sum(h["damage"] for h in seq),
            "health_after": max(0.0, seq[-1]["victim"]["health"] - seq[-1]["damage"]),
            "target_is_bot": target.get("type") != "user",
            "target_downed_me": target["accountId"] == down["attacker"]["accountId"]}


def baseline():
    """ 작성자 경기로 정의 대조: 체력 0 피격 ↔ 실제 기절·사망, 팀원 사격 비율 """
    r = Counter()
    for _, tel in matches(own=True):
        hits = gun_hits(tel)
        r["총기 피격"] += len(hits)
        r["팀원을 맞힌 피격"] += sum(1 for h in hits if h["attacker"].get("teamId") == h["victim"].get("teamId"))
        reals = [(e["victim"]["accountId"], e["_D"]) for e in tel if e["_T"] == "LogPlayerMakeGroggy"
                 and e.get("damageTypeCategory") == "Damage_Gun"]
        reals += [(e["victim"]["accountId"], e["_D"]) for e in tel if e["_T"] == "LogPlayerKillV2"
                  and e.get("dBNOId") in (None, -1) and (e.get("finishDamageInfo") or {}).get("damageTypeCategory") == "Damage_Gun"]
        r["실제 총기 기절·사망"] += len(reals)
        for d in downs_from_hits(hits):
            r["체력 0 피격"] += 1
            if any(v == d["victim"]["accountId"] and abs((t(x) - t(d["_D"])).total_seconds()) <= 1 for v, x in reals):
                r["체력 0 피격 중 실제 기록과 일치"] += 1
    return r


def why_not_dead(gap, reset_hp):
    A, hp_bins = Counter(), Counter()
    for _, tel in matches(own=False):
        hits = gun_hits(tel)
        for d in downs_from_hits(hits):
            if d["victim"].get("type") != "user":
                continue
            A["사람이 총에 쓰러짐"] += 1
            r = last_target(hits, d, gap, reset_hp)
            if not r:
                continue
            A["직전 20초 안에 적을 맞히던 중"] += 1
            if r["target_is_bot"]:
                A["  (그 적이 봇)"] += 1
            if r["health_after"] <= CLIP_EPS:
                A["  내가 그 적을 먼저 쓰러뜨림(맞교환)"] += 1
                continue
            A["  그 적이 살아 있음"] += 1
            if r["target_downed_me"]:
                A["    그 적이 나를 쓰러뜨림"] += 1
            if r["damage"] >= 50:
                A["    그 적에게 50 이상 맞힘"] += 1
            if r["health_after"] <= 25:
                A["    그 적 남은 체력 25 이하"] += 1
            if r["damage"] >= 50 and r["health_after"] <= 25 and r["target_downed_me"]:
                A["    셋 다 (50 이상 맞혔고, 25 이하 남았고, 그 적에게 쓰러짐)"] += 1
            lo = min(int(r["health_after"] // 25) * 25, 75)
            hp_bins[f"{lo}~{lo + 25}"] += 1
    order = ["사람이 총에 쓰러짐", "직전 20초 안에 적을 맞히던 중", "  (그 적이 봇)", "  내가 그 적을 먼저 쓰러뜨림(맞교환)",
             "  그 적이 살아 있음", "    그 적이 나를 쓰러뜨림", "    그 적에게 50 이상 맞힘", "    그 적 남은 체력 25 이하",
             "    셋 다 (50 이상 맞혔고, 25 이하 남았고, 그 적에게 쓰러짐)"]
    return {k: A[k] for k in order}, dict(sorted(hp_bins.items(), key=lambda kv: int(kv[0].split("~")[0])))


def main():
    gap, reset_hp = float(ST["engagement_gap_sec"]), float(ST["target_reset_heal_hp"])
    base = baseline()
    A, hp_bins = why_not_dead(gap, reset_hp)

    out = {"기준_대조_작성자경기": dict(base), "쏘던적_못쓰러뜨림_사람만": A, "그적_남은체력_구간": hp_bins}
    (ROOT / "data" / "user_evidence.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    print("[0] 정의 대조 (작성자 일반 경기 13개)")
    for k, v in base.items():
        print(f"  {k}: {v}")
    n = A["사람이 총에 쓰러짐"]
    print(f"\n[1] 쏘던 적을 못 쓰러뜨리고 먼저 쓰러짐 (무작위 일반 경기 100개, 사람이 총에 쓰러진 {n}회 기준 %)")
    for k, v in list(A.items())[1:]:
        print(f"  {k}: {v} ({v / n:.1%})")
    print("  그 적 남은 체력 구간 (살아 있던 경우):", hp_bins)


if __name__ == "__main__":
    main()
