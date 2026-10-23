"""
pubgstatistics.com 무기 수치 가져오기 (Day 3 - 1단계)

pubgstatistics.com: 공식 PUBG API의 실제 피격 기록으로 피해량을 계산해 공개하는 비공식 사이트 (43.2 기준)
작성자 결정 10/20: 기본 피해량·부위 배율·거리별 피해량·방어구 감소율을 이 사이트 값으로 사용 (출처 표시)
이용약관 확인 10/20: 비상업 목적, 서버에 부담을 주지 않는 수집, 숫자 값만 사용 (표 디자인·문구는 복사하지 않음)

입력: data/weapons.csv 의 pgs_name 열 (사이트의 무기 이름)
원본 보관: data/raw/pgs/<slug>.md (git 제외). 이미 받은 페이지는 다시 받지 않는다
출력:
  data/hit_zones.csv          부위별 배율(hit area) — 모든 무기 공통
  data/weapon_multipliers.csv 무기별·부위별 분류 배율 (대부분 분류마다 같지만 예외가 있어 무기별로 저장, 10/20)
  data/falloff.csv            무기별 거리별 기본 피해량
  data/weapons.csv            base_damage(0m 값, 샷건은 펠릿 1개 값)·pellets(샷건)·patch·source 갱신
  data/armor.csv              레벨별 감소율 (레벨별 피해량 ÷ 무방어 피해량에서 역산)

사용법: .venv/bin/python scripts/fetch_pgs_weapons.py
"""

import csv
import re
import sys
import time
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW_DIR = DATA / "raw" / "pgs"

SITE = "https://pubgstatistics.com"
DELAY_SEC = 1.5  # 페이지 사이 대기 (서버 부담 방지)
TODAY = date.today().isoformat()
SOURCE = f"pubgstatistics.com (공식 API 실측 기반, 조회 {TODAY})"

# 사이트의 분류 이름 → 우리 분류 코드 (weapons.csv의 class 열)
CLASS_CODE = {"AR": "AR", "LMG": "LMG", "SMG": "SMG", "DMR": "DMR", "SR": "SR", "SHOTGUN": "SG", "HANDGUN": "HG"}

# 화면 표시용 한국어 부위 이름
ZONE_KO = {
    "Head": "머리", "Neck": "목", "Clavicle": "쇄골", "Chest": "가슴",
    "Upper Stomach": "윗배", "Lower Stomach": "아랫배", "Pelvis": "골반",
    "Upper Arm": "윗팔", "Forearm": "아래팔", "Hand": "손",
    "Thigh": "허벅지", "Calf": "종아리", "Foot": "발",
}

# 방어구 레벨 표기 → 숫자
LEVEL = {"None": 0, "Level 1": 1, "Level 2": 2, "Level 3": 3}

# 레벨별 감소율이 무기마다 이 값 이상 차이 나면 멈추고 알린다 (표시값 반올림 오차 허용)
REDUCTION_TOL = 0.01


def slug(name):
    """ 사이트 규칙: 소문자로 바꾸고 영문·숫자가 아닌 부분은 하이픈으로 """
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def fetch_page(name):
    """ 무기 상세 페이지(마크다운판)를 받는다. 이미 받은 것은 파일에서 읽는다 """
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path = RAW_DIR / f"{slug(name)}.md"
    if path.exists():
        return path.read_text(encoding="utf-8")
    url = f"{SITE}/md/weapons/{slug(name)}"
    res = requests.get(url, headers={"Accept": "text/markdown"}, timeout=30)
    if not res.ok:
        sys.exit(f"오류({res.status_code}): {name} 페이지를 받지 못했습니다 ({url})")
    path.write_text(res.text, encoding="utf-8")
    time.sleep(DELAY_SEC)
    return res.text


def section(text, title):
    """ '## 제목' 부터 다음 '## ' 전까지 """
    m = re.search(rf"^## {re.escape(title)}\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
    return m.group(1) if m else ""


def parse_table(block):
    """ 마크다운 표 → [{열 이름: 값}] """
    lines = [l.strip() for l in block.splitlines() if l.strip().startswith("|")]
    if len(lines) < 3:
        return []
    cells = lambda l: [c.strip() for c in l.strip("|").split("|")]
    head = cells(lines[0])
    return [dict(zip(head, cells(l))) for l in lines[2:]]


def num(s):
    """ '52.8' → 52.8, 'n/a' 등 숫자가 아니면 None """
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None


def parse_weapon(text):
    """ 상세 페이지에서 분류, 패치, 거리별 피해량, 부위 배율, 방어구 표, 방어구 적용 부위를 뽑는다 """
    m = re.search(r"is a (\w+) in PUBG", text)
    patch = re.search(r"Data version: PUBG \*\*([\d.]+)\*\*", text)
    # 샷건: "Base damage: **26** per pellet, 9 pellets per shot" → 한 발에 나가는 펠릿 수
    pellets = re.search(r"(\d+) pellets per shot", text)
    falloff = [(int(r["Distance"].rstrip("m")), num(r["Base damage"]))
               for r in parse_table(section(text, "Damage by distance"))]
    mult_rows = parse_table(section(text, "Damage multipliers"))
    # 분류 배율 열 이름은 "AR class x"처럼 분류마다 다르다
    class_col = next((k for k in (mult_rows[0] if mult_rows else {}) if k.endswith("class x")), None)
    zones = [(r["Body part"], num(r["Hit area x"]), num(r[class_col])) for r in mult_rows] if class_col else []
    armour_sec = section(text, "Armour")
    armour = parse_table(armour_sec)
    # "Helmets cover the head and neck. Vests cover the clavicle, chest, stomach and pelvis."
    cover = {}
    for item, words in re.findall(r"(Helmets|Vests) cover the ([^.]+)\.", armour_sec):
        cover["helmet" if item == "Helmets" else "vest"] = [w.strip() for w in re.split(r",| and ", words) if w.strip()]
    return {
        "class": m.group(1) if m else None,
        "pellets": int(pellets.group(1)) if pellets else None,
        "patch": patch.group(1) if patch else None,
        "falloff": falloff, "zones": zones, "armour": armour, "cover": cover,
    }


def armor_slot(zone, cover):
    """ 부위 이름이 어느 방어구 설명에 들어 있는지 (예: 'stomach' → Upper/Lower Stomach) """
    for slot, words in cover.items():
        if any(w in zone.lower() for w in words):
            return slot
    return "none"


def write_csv(path, fields, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def main():
    weapons_path = DATA / "weapons.csv"
    weapons = list(csv.DictReader(open(weapons_path, encoding="utf-8-sig")))
    names = sorted({w["pgs_name"] for w in weapons if w.get("pgs_name")})
    print(f"무기 {len(names)}개 페이지 확인 (처음이면 약 {len(names) * DELAY_SEC:.0f}초)")

    parsed = {}
    for n in names:
        parsed[n] = parse_weapon(fetch_page(n))

    problems = []
    hit_area, cover = {}, {}
    weapon_mult = {}  # 사이트 무기 이름 → {부위: 분류 배율}
    class_vals = {}   # (우리 분류, 부위) → {사이트 무기 이름: 배율} (같은 분류 안의 예외를 알리는 용도)
    reductions = {}   # (helmet/vest, 레벨) → [감소율...]
    zone_order = []

    for n, p in parsed.items():
        if not p["zones"]:
            continue  # 사이트에 측정값이 없는 무기 (마지막에 "기존 값 유지"로 알림)
        code = CLASS_CODE.get(p["class"])
        if code is None:
            problems.append(f"{n}: 모르는 분류 {p['class']}")
            continue
        cover = cover or p["cover"]
        for zone, area, cm in p["zones"]:
            if zone not in zone_order:
                zone_order.append(zone)
            # 부위 배율은 "모든 무기 공통"이라고 사이트에 적혀 있음 → 실제로 같은지 확인
            if hit_area.setdefault(zone, area) != area:
                problems.append(f"{n}: {zone} 부위 배율 {area} (다른 무기 {hit_area[zone]})")
            weapon_mult.setdefault(n, {})[zone] = cm
            class_vals.setdefault((code, zone), {})[n] = cm
        # 방어구: 레벨별 피해량 ÷ 무방어 피해량
        base = next((r for r in p["armour"] if r["Armour level"] == "None"), None)
        for r in p["armour"]:
            lv = LEVEL.get(r["Armour level"])
            if not lv or base is None:
                continue
            for slot, col in (("helmet", "Head damage"), ("vest", "Chest damage")):
                b, d = num(base[col]), num(r[col])
                if b and d is not None:
                    reductions.setdefault((slot, lv), []).append(1 - d / b)

    # 감소율이 무기마다 일정한지 확인
    armor_rows = []
    for (slot, lv), vals in sorted(reductions.items()):
        lo, hi = min(vals), max(vals)
        if hi - lo > REDUCTION_TOL:
            problems.append(f"{slot} {lv}레벨 감소율이 무기마다 다름: {lo:.3f}~{hi:.3f}")
        armor_rows.append({"item": slot, "level": lv, "damage_reduction": f"{sum(vals) / len(vals):.2f}",
                           "source": f"{SOURCE} — 무기 {len(vals)}종 레벨별 피해량에서 역산", "verified": "N"})

    if problems:
        print("\n확인 필요 — 파일을 쓰지 않고 멈춥니다:")
        for x in problems:
            print("  -", x)
        sys.exit(1)

    # ── 저장 ─────────────────────────────────────────────
    # damage_reason(텔레메트리 부위 기록)은 사이트가 아니라 실측으로 정한 열이라 기존 값을 유지 (docs/03 3번 표, 10/21)
    old_zone = {r["zone"]: r for r in csv.DictReader(open(DATA / "hit_zones.csv", encoding="utf-8-sig"))} \
        if (DATA / "hit_zones.csv").exists() else {}
    write_csv(DATA / "hit_zones.csv", ["zone", "zone_ko", "hit_area", "armor_slot", "damage_reason", "source"], [
        {"zone": z, "zone_ko": ZONE_KO.get(z, z), "hit_area": hit_area[z], "armor_slot": armor_slot(z, cover),
         "damage_reason": old_zone.get(z, {}).get("damage_reason", ""), "source": SOURCE} for z in zone_order])

    mult_rows = []
    for w in weapons:  # 우리 무기 이름 기준 (MG3처럼 한 페이지가 두 줄이면 두 줄 모두)
        for z, m in weapon_mult.get(w.get("pgs_name"), {}).items():
            mult_rows.append({"weapon": w["weapon"], "class": w["class"], "zone": z, "class_mult": m, "source": SOURCE})
    write_csv(DATA / "weapon_multipliers.csv", ["weapon", "class", "zone", "class_mult", "source"], mult_rows)

    fall_rows = []
    for w in weapons:
        p = parsed.get(w.get("pgs_name"))
        for dist, dmg in (p["falloff"] if p else []):
            fall_rows.append({"weapon": w["weapon"], "distance_m": dist,
                              "base_damage": "" if dmg is None else dmg, "source": SOURCE})
    write_csv(DATA / "falloff.csv", ["weapon", "distance_m", "base_damage", "source"], fall_rows)

    # weapons.csv: 0m 기본 피해량·패치·출처 갱신 (바뀐 무기는 화면에 표시)
    changed = []
    for w in weapons:
        p = parsed.get(w.get("pgs_name"))
        zero = next((d for dist, d in (p["falloff"] if p else []) if dist == 0), None)
        if zero is None:
            continue  # 사이트에 측정값이 없는 무기는 기존 값 유지
        same = num(w["base_damage"]) == zero
        if not same:
            changed.append(f"{w['weapon']}: {w['base_damage']} → {zero:g}")
        # 기존 출처는 지우지 않는다: 값이 같으면 "일치"로 함께 남김 (다시 실행해도 중복되지 않게)
        prev = w["source"]
        if prev.startswith("pubgstatistics.com"):
            note = prev.split(" · ", 1)[1] if " · " in prev else ""
        else:
            note = f"{prev} 42.3 값과 일치" if same else ""
        w["source"] = SOURCE + (f" · {note}" if note else "")
        w["base_damage"] = f"{zero:g}"
        if p["pellets"]:
            w["pellets"] = p["pellets"]  # 샷건만. 다른 무기는 비워 두고 1개로 계산
        w["patch"] = p["patch"] or w["patch"]
    write_csv(weapons_path, list(weapons[0].keys()), weapons)

    # 값이 그대로인 줄은 텔레메트리 검증 표시(verified·source)를 유지한다
    old_armor = {(r["item"], r["level"]): r for r in csv.DictReader(open(DATA / "armor.csv", encoding="utf-8-sig"))}
    for r in armor_rows:
        old = old_armor.get((r["item"], str(r["level"])))
        if old and old["damage_reduction"] == r["damage_reduction"]:
            r["verified"], r["source"] = old["verified"], old["source"]
    # 사이트에서 오지 않은 줄(예: 부서진 조끼 — 텔레메트리 실측 10/21)은 그대로 남긴다
    made = {(s, "0") for s in ("vest", "helmet")} | {(r["item"], str(r["level"])) for r in armor_rows}
    extra = [r for k, r in old_armor.items() if k not in made]
    write_csv(DATA / "armor.csv", ["item", "level", "damage_reduction", "source", "verified"],
              [{"item": s, "level": 0, "damage_reduction": "0.00", "source": "기준값", "verified": "Y"}
               for s in ("vest", "helmet")] + armor_rows + extra)

    print("\n완료")
    print(f"  부위 {len(zone_order)}개 · 무기별 배율 {len(weapon_mult)}종 · 거리별 피해량 {len(fall_rows)}줄")
    # 같은 분류인데 배율이 다른 무기: 그 분류에서 가장 많은 값과 다른 것만 알림
    # (예: Dragunov 머리·목 2.8, 다른 DMR 2.35 — 사이트 원문 확인 10/20)
    exceptions = []
    for (code, zone), vals in class_vals.items():
        common = max(set(vals.values()), key=list(vals.values()).count)
        exceptions += [f"{n} {zone} {m} (다른 {code} {common})" for n, m in vals.items() if m != common]
    if exceptions:
        print("  같은 분류 안의 예외 배율 (무기별로 저장함):", ", ".join(sorted(exceptions)))
    print("  기본 피해량이 바뀐 무기:", ", ".join(changed) if changed else "없음")
    print("  방어구 감소율:", ", ".join(f"{r['item']} {r['level']}레벨 {r['damage_reduction']}" for r in armor_rows))
    skipped = [w["weapon"] for w in weapons if not parsed.get(w.get("pgs_name"), {}).get("zones")]
    if skipped:
        print("  측정값 없어 기존 값 유지:", ", ".join(skipped))


if __name__ == "__main__":
    main()
