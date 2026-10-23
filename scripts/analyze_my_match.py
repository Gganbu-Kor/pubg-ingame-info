"""
나를 쓰러뜨린 공격 분석 (Day 2 - 2단계)

입력: data/raw/latest.json 이 가리키는 경기의 텔레메트리 (fetch_my_match.py 로 받은 것)
출력: data/my_match_summary.json

"쓰러뜨린 공격"을 묶는 방법 (작성자 결정 10/19):
  - 쓰러진 순간(기절 또는 기절 없는 사망)부터 거꾸로 보면서,
    맞은 공격 사이 공백이 engagement_gap_sec(data/settings.csv)보다 길면 거기서 끊는다
  - 교전을 시작할 때의 체력을 함께 기록한다 (체력이 100이 아니면 몇 발 컷보다 적게 맞고 쓰러질 수 있음)
  - 상대 계정 ID·닉네임은 저장하지 않는다. 같은 쓰러짐 안에서 "상대1, 상대2"로만 구분

필드 의미 (10/19 실제 데이터로 확인):
  - victim.health: 이 공격을 맞기 "전" 체력
  - damage: 방어구 적용 후 체력에 들어간 피해. 남은 체력에 맞춰 잘림 → 마지막 발은 실제 위력보다 작을 수 있음

발마다 추가 (10/21, verify_damage.py와 같은 방법·같은 data/ 수치):
  - 거리(m), 그 순간 내 조끼·헬멧 상태(부서진 조끼 포함)
  - 추정 세부 부위: 텔레메트리 부위 기록(예: TorsoShot)에 속한 세부 부위(hit_zones.csv의 damage_reason) 중
    계산값이 실제 피해량과 맞는 것. 감쇠 없는 거리는 정확 비교, 그보다 멀면 측정 지점 사이 범위로 비교
  - 체력에 잘린 발은 실제 위력을 알 수 없어 추정하지 않음

내가 공격하던 적 (10/21, 10/23 작성자 결정으로 확장):
  - 총뿐 아니라 수류탄·화염병·블루존 수류탄 등 내가 적에게 준 모든 피해를 넣는다 (부위가 없으면 화면에서 피해 합계로만)
  - 수류탄처럼 같은 순간(same_moment_sec)에 여러 적을 맞혔으면, 그 교전에서 피해를 가장 많이 준 적 → 나를 쓰러뜨린 적 순으로 대표를 고른다
  - 같은 교전에서 피해를 준 다른 적은 my_other_targets 로 저장 (매치 리포트에 모두 표시)

사용법: .venv/bin/python scripts/analyze_my_match.py
       .venv/bin/python scripts/analyze_my_match.py --match 452e8a1e --out data/concept_example_452e8a1e.json
         (받아 둔 다른 내 경기를 골라 다른 파일로 저장 — 컨셉 화면 예시용. 경기 ID는 앞부분만 써도 됨)
"""

import csv
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from verify_damage import (CLIP_EPS, TOL, ArmorTracker, bracket, candidates, dist_m, flat_range,
                           load_model)

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_PATH = ROOT / "data" / "my_match_summary.json"
KST = timezone(timedelta(hours=9))

# PUBG 공식 api-assets 사전 (사람이 읽는 이름). 한 번 받으면 data/raw/ 에 보관
ASSETS = "https://raw.githubusercontent.com/pubg/api-assets/master/dictionaries/"
DICTS = {
    "damageCauserName": "telemetry/damageCauserName.json",
    "mapName": "telemetry/mapName.json",
    "gameMode": "gameMode.json",
}

# 부위 표시 이름 (damageReason 값 → 화면용 한국어)
PART_KO = {
    "HeadShot": "머리", "TorsoShot": "몸통", "PelvisShot": "골반",
    "ArmShot": "팔", "LegShot": "다리", "NonSpecific": "부위 없음", "None": "부위 없음",
}
# 체력에 잘렸는지 판단할 오차(CLIP_EPS)·계산값 비교 오차(TOL)는 verify_damage.py와 같은 값을 씀


def load_settings():
    """ data/settings.csv → {key: value} """
    with open(ROOT / "data" / "settings.csv", encoding="utf-8-sig") as f:
        return {row["key"]: row["value"] for row in csv.DictReader(f)}


def load_dict(name):
    """ api-assets 사전을 읽는다. 없으면 받아서 data/raw/ 에 저장 """
    path = RAW_DIR / f"dict_{name}.json"
    if not path.exists():
        res = requests.get(ASSETS + DICTS[name], timeout=30)
        res.raise_for_status()
        path.write_text(res.text, encoding="utf-8")
    return json.loads(path.read_text(encoding="utf-8"))


def parse_time(s):
    """ 텔레메트리 시각 문자열(_D) → datetime """
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def guess_zone(e, w, level, model):
    """ 이 발이 맞은 세부 부위 추정 → (부위 이름 목록, 계산값 또는 [최소, 최대], 방법) """
    _, falloff, zones, cmult, red = model
    if e["victim"]["health"] - e["damage"] < CLIP_EPS:
        return [], None, "잘림"
    pts = falloff.get(w["weapon"], [])
    fr = flat_range(pts)
    same = [z for z in zones if z.get("damage_reason") == e.get("damageReason")]
    if fr is None or not same:
        return [], None, "자료 없음"
    d = dist_m(e["attacker"], e["victim"])
    if d <= fr:
        cs = [c for c in candidates(pts[0][1], w["weapon"], same, cmult, red) if c[2] == level.get(c[1], 0)]
        hit = [c for c in cs if abs(c[3] - e["damage"]) <= TOL]
        return [c[0] for c in hit], (round(hit[0][3], 2) if hit else None), "정확" if hit else "불일치"
    br = bracket(pts, d)
    if br is None:
        return [], None, "측정 범위 밖"
    lo = candidates(br[0], w["weapon"], same, cmult, red)
    hi = candidates(br[1], w["weapon"], same, cmult, red)
    hit = [(l, h) for l, h in zip(lo, hi) if l[2] == level.get(l[1], 0) and l[3] - TOL <= e["damage"] <= h[3] + TOL]
    return ([l[0] for l, _ in hit], ([round(hit[0][0][3], 2), round(hit[0][1][3], 2)] if hit else None),
            "범위" if hit else "불일치")


def is_other_player(ch, me):
    """ 다른 플레이어가 한 공격인지 (자기장·낙하 등은 attacker가 없거나 비어 있음) """
    return bool(ch) and bool(ch.get("accountId")) and ch.get("accountId") != me


def main():
    import argparse
    ap = argparse.ArgumentParser(description="나를 쓰러뜨린 공격 분석")
    ap.add_argument("--match", help="받아 둔 내 경기 ID(앞부분만 써도 됨). 없으면 latest.json의 경기")
    ap.add_argument("--out", help="저장할 파일 (기본: data/my_match_summary.json)")
    args = ap.parse_args()
    out_path = (ROOT / args.out) if args.out else OUT_PATH

    latest_path = RAW_DIR / "latest.json"
    if not latest_path.exists():
        sys.exit("먼저 fetch_my_match.py 로 경기를 받아 주세요.")
    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    me, match_id = latest["account_id"], latest["match_id"]
    if args.match:
        found = sorted(RAW_DIR.glob(f"telemetry_{args.match}*.json"))
        if len(found) != 1:
            sys.exit(f"경기 ID '{args.match}'로 찾은 파일이 {len(found)}개입니다. data/raw/ 의 경기 ID를 확인해 주세요.")
        match_id = found[0].stem.removeprefix("telemetry_")

    settings = load_settings()
    gap_sec = float(settings["engagement_gap_sec"])
    reset_hp = float(settings["target_reset_heal_hp"])
    same_sec = float(settings["same_moment_sec"])

    match = json.loads((RAW_DIR / f"match_{match_id}.json").read_text(encoding="utf-8"))
    # 10/23 작성자 결정: 좀비 모드 같은 이벤트 경기는 무기·피해 규칙이 달라 분석하지 않음 (settings.csv의 verify_match_types)
    match_type = match["data"]["attributes"].get("matchType")
    if match_type not in [x.strip() for x in settings["verify_match_types"].split(";")]:
        sys.exit(f"일반 경기가 아닌 모드({match_type})라 분석하지 않습니다. "
                 "fetch_my_match.py 닉네임 --index 1 처럼 다른 경기를 받아 주세요.")
    tel = json.loads((RAW_DIR / f"telemetry_{match_id}.json").read_text(encoding="utf-8"))
    causer = load_dict("damageCauserName")
    maps = load_dict("mapName")
    modes = load_dict("gameMode")

    # 내가 맞은 순간의 방어구 상태 (시간순으로 추적, 부서진 조끼 포함)
    model = load_model()
    by_api, falloff, zones = model[0], model[1], model[2]
    zone_ko = {z["zone"]: z["zone_ko"] for z in zones}
    tracker = ArmorTracker(model[4])
    hit_level = {}  # (attackId, 시각, 맞은 사람) → 그 순간 맞은 사람의 {vest, helmet} — 내가 맞은 발·내가 맞힌 발
    for e in sorted(tel, key=lambda e: e["_D"]):
        if tracker.handle(e):
            continue
        if e["_T"] == "LogPlayerTakeDamage":
            vid = (e.get("victim") or {}).get("accountId")
            if vid == me or (e.get("attacker") or {}).get("accountId") == me:
                hit_level[(e["attackId"], e["_D"], vid)] = tracker.level(vid, e["attackId"])

    # 내 팀 번호 (팀원을 맞힌 기록은 "내가 공격하던 적"에서 뺀다)
    my_team = next((ch.get("teamId") for e in tel for ch in (e.get("character"), e.get("victim"), e.get("attacker"))
                    if isinstance(ch, dict) and ch.get("accountId") == me), None)

    def is_me(ch):
        return bool(ch) and ch.get("accountId") == me

    # ── 1. 내가 다른 플레이어에게 맞은 공격 ─────────────────────
    hits = [
        e for e in tel
        if e["_T"] == "LogPlayerTakeDamage" and is_me(e.get("victim"))
        and is_other_player(e.get("attacker"), me) and e["damage"] > 0
    ]

    # ── 1-2. 내가 적에게 준 피해 (팀원 제외) ─────────────────────
    # 10/23 작성자 결정: 총뿐 아니라 수류탄·화염병·블루존 수류탄 등 모든 공격 (부위가 없으면 화면에서 피해 합계로만)
    out_hits = [
        e for e in tel
        if e["_T"] == "LogPlayerTakeDamage" and is_me(e.get("attacker"))
        and is_other_player(e.get("victim"), me) and e["victim"].get("teamId") != my_team
        and e["damage"] > 0
        and not e["victim"].get("isDBNO")   # 이미 기절한 적에게 준 피해는 "공격하던 적"에서 뺌 (작성자 승인 10/21)
        # 이벤트 모드의 NPC(예: npc_zombie)와 맞기 전 체력이 0 이하인 이상 기록은 뺌 (10/21 점검에서 발견)
        and not str(e["victim"].get("type", "")).startswith("npc") and e["victim"].get("health", 0) > 0
    ]

    # ── 2. 쓰러진 순간: 기절, 또는 기절 없이 바로 사망 ────────────
    groggy_ids = set()
    downs = []
    for e in tel:
        if e["_T"] == "LogPlayerMakeGroggy" and is_me(e.get("victim")):
            groggy_ids.add(e.get("dBNOId"))
            downs.append({"type": "기절", "time": e["_D"], "causer": e.get("damageCauserName"),
                          "reason": e.get("damageReason")})
    for e in tel:
        if e["_T"] == "LogPlayerKillV2" and is_me(e.get("victim")):
            if e.get("dBNOId") not in (None, -1) and e.get("dBNOId") in groggy_ids:
                continue  # 기절 후 확인 사살 → 이미 기절 시점으로 분석함
            info = e.get("finishDamageInfo") or {}
            downs.append({"type": "사망", "time": e["_D"], "causer": info.get("damageCauserName"),
                          "reason": info.get("damageReason")})

    # 소생(일어남) 시각: 이 시각 이전 공격은 다음 쓰러짐에 넣지 않는다
    revives = [e["_D"] for e in tel if e["_T"] == "LogPlayerRevive" and is_me(e.get("victim"))]
    downs.sort(key=lambda d: d["time"])

    # ── 3. 쓰러짐마다 공백 기준으로 거슬러 올라가며 공격 묶기 ──────
    results = []
    prev_down = None
    for d in downs:
        # 아래 경계: 직전 쓰러짐 또는 그 뒤의 소생 중 늦은 시각
        bounds = [t for t in revives if t <= d["time"]] + ([prev_down] if prev_down else [])
        lower = max(bounds) if bounds else ""
        prev_down = d["time"]

        before = [h for h in hits if lower < h["_D"] <= d["time"]]
        group = []
        for h in reversed(before):
            if group and (parse_time(group[0]["_D"]) - parse_time(h["_D"])).total_seconds() > gap_sec:
                break
            group.insert(0, h)
        if not group:
            continue  # 다른 플레이어 공격이 아닌 원인(자기장 등)으로 쓰러진 경우

        t0 = parse_time(group[0]["_D"])
        labels = {}  # 상대 계정 ID → "상대1" (ID 자체는 저장하지 않음)
        shots = []
        for i, h in enumerate(group):
            aid = h["attacker"]["accountId"]
            labels.setdefault(aid, f"상대{len(labels) + 1}")
            hp_before = h["victim"]["health"]
            level = hit_level.get((h["attackId"], h["_D"], me), {"vest": 0, "helmet": 0})
            w = by_api.get(h["damageCauserName"])
            zs, expected, method = guess_zone(h, w, level, model) if w and h.get("attacker", {}).get("location") \
                else ([], None, "자료 없음")
            shots.append({
                "t_ms": round((parse_time(h["_D"]) - t0).total_seconds() * 1000),
                "attacker": labels[aid],
                "weapon_id": h["damageCauserName"],
                "weapon": causer.get(h["damageCauserName"], h["damageCauserName"]),
                "category": h["damageTypeCategory"],
                "part": PART_KO.get(h["damageReason"], h["damageReason"]),
                "damage": round(h["damage"], 2),
                "health_before": round(hp_before, 2),
                # 남은 체력만큼만 들어간 발 → 실제 위력보다 작음 (검증에서 제외할 것)
                "clipped": abs(h["damage"] - hp_before) < CLIP_EPS,
                "reason": h["damageReason"],
                "distance_m": round(dist_m(h["attacker"], h["victim"])) if h.get("attacker", {}).get("location") else None,
                "my_vest": level["vest"], "my_helmet": level["helmet"],
                "calc_weapon": w["weapon"] if w else None,   # 계산기(weapons.csv)의 무기 이름
                "zone_keys": zs,                              # 추정 세부 부위 (hit_zones.csv의 zone)
                "zones": [zone_ko[z] for z in zs],
                "expected": expected,                         # 계산값 (범위 비교면 [최소, 최대])
                "zone_method": method,                        # 정확 / 범위 / 잘림 / 불일치 / 자료 없음 / 측정 범위 밖
            })

        # ── 내가 쓰러지기 전 마지막으로 공격하던 적 (작성자 결정 10/21, 10/23 수류탄 등 포함) ──
        #  - 나를 쓰러뜨린 상대와 다를 수 있음 (1번을 쏘다가 2번에게 맞은 경우 → 1번)
        #  - 쓰러지기 전 engagement_gap_sec 안에 내가 적에게 피해를 준 적이 없으면 표시하지 않음 (일방적으로 맞은 경우)
        #  - 적마다: 마지막 공격부터 거슬러 올라가며, 공백이 engagement_gap_sec를 넘거나 회복하면 끊음
        #  - 같은 순간(same_moment_sec)에 여러 적을 맞혔으면(수류탄 등) 피해를 가장 많이 준 적 → 나를 쓰러뜨린 적 순으로 대표
        #  - 대표 말고 같은 교전에서 피해를 준 다른 적은 my_other_targets (매치 리포트에 모두 표시)
        target, others = None, []
        mine = [h for h in out_hits if lower < h["_D"] <= d["time"]]
        killer = group[-1]["attacker"]["accountId"]
        tlabels = dict(labels)   # 내가 공격한 적의 이름표 (labels는 "나를 공격한 상대 수"에 쓰므로 따로 둠)

        def engagement(vid):
            """ 그 적에게 준 피해: 마지막부터 거슬러 올라가며 공백·회복에서 끊음 → (기록 목록, 회복으로 끊었는지) """
            seq, healed = [], False
            for h in reversed([h for h in mine if h["victim"]["accountId"] == vid]):
                if seq and (parse_time(seq[0]["_D"]) - parse_time(h["_D"])).total_seconds() > gap_sec:
                    break
                # 이 공격 뒤에 상대 체력이 reset_hp 이상 올랐으면(회복) 여기서 끊고, 회복 이후만 센다 (작성자 결정 10/21)
                if seq and seq[0]["victim"]["health"] - (h["victim"]["health"] - h["damage"]) >= reset_hp:
                    healed = True
                    break
                seq.insert(0, h)
            return seq, healed

        def describe(vid, seq, healed):
            """ 화면에 쓸 형태로: 공격마다 무기·부위·피해·그때 상대 방어구, 그리고 합계 """
            th = []
            for h in seq:
                lv = hit_level.get((h["attackId"], h["_D"], vid), {"vest": 0, "helmet": 0})
                w = by_api.get(h["damageCauserName"])
                zs, expected, method = guess_zone(h, w, lv, model) if w and h.get("attacker", {}).get("location") \
                    else ([], None, "자료 없음")
                hb = h["victim"]["health"]
                th.append({
                    "t_ms": round((parse_time(h["_D"]) - t0).total_seconds() * 1000),
                    "weapon": causer.get(h["damageCauserName"], h["damageCauserName"]),
                    "category": h["damageTypeCategory"],   # 부위가 없는 피해(수류탄 등)는 화면에서 피해 합계로만 (10/23)
                    "calc_weapon": w["weapon"] if w else None,
                    "part": PART_KO.get(h["damageReason"], h["damageReason"]), "reason": h["damageReason"],
                    "damage": round(h["damage"], 2),
                    "health_before": round(hb, 2), "health_after": round(max(0.0, hb - h["damage"]), 2),
                    "clipped": abs(h["damage"] - hb) < CLIP_EPS,
                    "knocked_before": bool(h["victim"].get("isDBNO")),   # 이미 기절한 상대를 맞힌 발
                    "distance_m": round(dist_m(h["attacker"], h["victim"])) if h["attacker"].get("location") else None,
                    "target_vest": lv["vest"], "target_helmet": lv["helmet"],
                    "zone_keys": zs, "zones": [zone_ko[z] for z in zs], "expected": expected, "zone_method": method,
                })
            last = th[-1]
            weapons_used = [x["calc_weapon"] for x in th if x["calc_weapon"]]
            return {
                "label": tlabels.setdefault(vid, f"상대{len(tlabels) + 1}"),   # 계정 ID는 저장하지 않음
                "is_killer": vid == killer,   # 나를 쓰러뜨린 상대와 같은지
                "hits": th,
                "total_damage": round(sum(x["damage"] for x in th), 2),
                # 작성자 결정 10/21: 회복·다른 사람의 피해까지 넣으면 오히려 파악하기 어려움
                # → "내가 어느 부위에, 얼마나 넣었나"만 (남은 체력·회복은 계산하지 않음)
                "vest": last["target_vest"], "helmet": last["target_helmet"],
                "knocked_by_me": any(x["health_after"] <= 0 for x in th),
                "healed_reset": healed,   # 상대가 회복해서 그 이후만 셌는지
                "calc_weapon": max(set(weapons_used), key=weapons_used.count) if weapons_used else None,
                "distance_m": last["distance_m"],
            }

        if mine and (parse_time(d["time"]) - parse_time(mine[-1]["_D"])).total_seconds() <= gap_sec:
            t_last = parse_time(mine[-1]["_D"])
            # 이 교전에서 피해를 준 적들 (쓰러지기 전 gap_sec 안에 공격한 적, 최근 순)
            victims = []
            for h in reversed(mine):
                vid = h["victim"]["accountId"]
                if vid not in victims and (parse_time(d["time"]) - parse_time(h["_D"])).total_seconds() <= gap_sec:
                    victims.append(vid)
            seqs = {v: engagement(v) for v in victims}
            dmg = {v: sum(h["damage"] for h in seqs[v][0]) for v in victims}
            # 마지막 공격과 같은 순간에 맞은 적들 중: 피해를 가장 많이 준 적 → 나를 쓰러뜨린 적
            same = [v for v in victims
                    if any(abs((parse_time(h["_D"]) - t_last).total_seconds()) <= same_sec for h in seqs[v][0])]
            main_vid = max(same, key=lambda v: (dmg[v], v == killer))
            target = describe(main_vid, *seqs[main_vid])
            others = sorted((describe(v, *seqs[v]) for v in victims if v != main_vid), key=lambda x: -x["total_damage"])

        by_weapon = {}
        for s in shots:
            w = by_weapon.setdefault(s["weapon_id"], {"weapon_id": s["weapon_id"], "weapon": s["weapon"], "parts": {}, "total": 0})
            w["parts"][s["part"]] = w["parts"].get(s["part"], 0) + 1
            w["total"] += 1

        results.append({
            "type": d["type"],
            "time_kst": parse_time(d["time"]).astimezone(KST).strftime("%H:%M:%S"),
            "final_weapon_id": d["causer"],
            "final_weapon": causer.get(d["causer"], d["causer"]),
            "final_part": PART_KO.get(d["reason"], d["reason"]),
            "start_health": shots[0]["health_before"],
            "duration_ms": shots[-1]["t_ms"],  # 첫 발부터 마지막 발까지 걸린 시간
            "attackers": len(labels),
            "by_weapon": sorted(by_weapon.values(), key=lambda w: -w["total"]),
            "shots": shots,
            "my_target": target,  # 내가 마지막으로 공격하던 적 (없으면 null)
            "my_other_targets": others,  # 같은 교전에서 피해를 준 다른 적 (피해 많은 순, 10/23)
        })

    # ── 4. 내 최종 결과 (경기 정보의 내 participant 항목만 읽음) ───
    # winPlace = 최종 순위(1이면 치킨), deathType = 사망 원인("alive"면 끝까지 생존) — 작성자 확인 10/19
    my_stats = next(
        (i["attributes"]["stats"] for i in match["included"]
         if i["type"] == "participant" and i["attributes"]["stats"].get("playerId") == me),
        {})

    # ── 5. 저장 (닉네임 외 다른 플레이어 정보 없음) ─────────────
    attrs = match["data"]["attributes"]
    summary = {
        "name": latest["name"],
        "match": {
            "id": match_id,
            "created_kst": parse_time(attrs["createdAt"]).astimezone(KST).strftime("%Y-%m-%d %H:%M"),
            "map": maps.get(attrs["mapName"], attrs["mapName"]),
            "mode": modes.get(attrs["gameMode"], attrs["gameMode"]),
            "match_type": attrs.get("matchType"),  # official = 일반 경기, event 등은 규칙이 다를 수 있음
        },
        "result": {"win_place": my_stats.get("winPlace"), "death_type": my_stats.get("deathType")},
        "settings": {"engagement_gap_sec": gap_sec},
        "source": "PUBG 공식 API 텔레메트리 · 무기 이름: pubg/api-assets 사전",
        "downs": results,
    }
    out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    # 화면 출력
    m = summary["match"]
    print(f"{summary['name']} · {m['created_kst']} · {m['map']} · {m['mode']} · 최종 {summary['result']['win_place']}위")
    if not results:
        print("이 경기에서 다른 플레이어에게 쓰러진 기록이 없습니다.")
    for r in results:
        parts = ", ".join(
            f"{w['weapon']} " + " ".join(f"{p} {n}발" for p, n in w["parts"].items()) for w in r["by_weapon"])
        print(f"\n[{r['type']}] {r['time_kst']} — {parts}")
        print(f"  교전 시작 체력 {r['start_health']} · 첫 발부터 {r['duration_ms']}ms · 상대 {r['attackers']}명")
        tg = r["my_target"]
        if tg:
            print(f"  내가 마지막으로 공격하던 적: {tg['label']}{' (나를 쓰러뜨린 상대)' if tg['is_killer'] else ''} · "
                  f"{len(tg['hits'])}회 · {tg['total_damage']} 피해 · 조끼 {tg['vest']} 헬멧 {tg['helmet']}")
            for o in r["my_other_targets"]:
                print(f"    같은 교전의 다른 적: {o['label']} · {len(o['hits'])}회 · {o['total_damage']} 피해")
        else:
            print("  내가 마지막으로 공격하던 적: 없음 (쓰러지기 전 피해를 준 적 없음)")
        for s in r["shots"]:
            mark = "  ← 남은 체력만큼 잘림" if s["clipped"] else ""
            print(f"  +{s['t_ms']:>5}ms {s['attacker']} {s['weapon']:<12} {s['part']:<4} {s['damage']:>6} (맞기 전 {s['health_before']}){mark}")
    # 프로젝트 밖 경로(--out)여도 멈추지 않게: 프로젝트 안이면 상대 경로, 아니면 전체 경로로 출력
    shown = out_path.resolve().relative_to(ROOT) if out_path.resolve().is_relative_to(ROOT) else out_path.resolve()
    print(f"\n저장: {shown}")


if __name__ == "__main__":
    main()
