"""
공식 무작위 경기(samples) 받기 — 검증 표본 보강용 (Day 3, 작성자 결정 10/20)

흐름: samples(공식 API가 고른 하루치 무작위 경기 ID) → 경기 정보 → 일반 경기만 → 텔레메트리
저장: data/raw/samples/ (git 제외)
  - 검증에 필요한 이벤트만 남김: 피격, 장착·해제, 조끼 파괴
  - 개인정보 최소화: 닉네임(name) 삭제, 계정 ID는 경기 안에서만 쓰는 임의 번호(p1, p2 …)로 바꿈
  - 경기 정보는 유형·모드·맵·시각만 남김 (참가자 목록 저장 안 함)

요청 제한: samples·players는 분당 10회 제한에 포함, matches·텔레메트리는 제외 (공식 문서 rate-limits)
다시 실행하면 이미 받은 경기와 제외한 경기는 건너뛴다.

사용법: .venv/bin/python scripts/fetch_samples.py --count 100
"""

import argparse
import csv
import gzip
import json
from pathlib import Path

from fetch_my_match import API_BASE, api_get, load_settings

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "samples"
KEEP = {"LogPlayerTakeDamage", "LogItemEquip", "LogItemUnequip", "LogArmorDestroy"}
# 인물 정보(attacker·victim·character)에서 검증에 쓰는 항목만 남김
CHAR_KEYS = {"accountId", "health", "location", "isDBNO", "isInVehicle", "isInBlueZone", "isInRedZone", "inSpecialZone", "type"}
CHAR_FIELDS = ("attacker", "victim", "character")


def allowed_types():
    """ data/settings.csv 의 verify_match_types (검증 스크립트와 같은 기준) """
    with open(ROOT / "data" / "settings.csv", encoding="utf-8-sig") as f:
        row = next(r for r in csv.DictReader(f) if r["key"] == "verify_match_types")
    return row["value"].split("|")


def anonymize(obj, alias):
    """ 모든 하위 항목에서 name 삭제, accountId → 경기 안 임의 번호 """
    if isinstance(obj, dict):
        obj.pop("name", None)
        if obj.get("accountId"):
            obj["accountId"] = alias.setdefault(obj["accountId"], f"p{len(alias) + 1}")
        for v in obj.values():
            anonymize(v, alias)
    elif isinstance(obj, list):
        for v in obj:
            anonymize(v, alias)


def main():
    parser = argparse.ArgumentParser(description="공식 무작위 경기 받기 (검증용)")
    parser.add_argument("--count", type=int, default=100, help="받을 일반 경기 수 (이미 받은 것 포함)")
    args = parser.parse_args()

    key, shard = load_settings()
    OUT.mkdir(parents=True, exist_ok=True)
    types = allowed_types()
    skip_path = OUT / "skipped.json"  # 유형이 달라 제외한 경기 (다시 조회하지 않게)
    skipped = set(json.loads(skip_path.read_text())) if skip_path.exists() else set()

    sample = api_get(f"{API_BASE}/shards/{shard}/samples", key).json()["data"]
    ids = [m["id"] for m in sample["relationships"]["matches"]["data"]]
    have = {p.stem.removeprefix("telemetry_") for p in OUT.glob("telemetry_*.json")}
    print(f"샘플 {sample['attributes'].get('createdAt', '')[:10]} · 경기 ID {len(ids)}개 · 이미 받음 {len(have)}개 · 목표 {args.count}개")

    for mid in ids:
        if len(have) >= args.count:
            break
        if mid in have or mid in skipped:
            continue
        try:
            match = api_get(f"{API_BASE}/shards/{shard}/matches/{mid}", key)
            if match is None:
                continue
            match = match.json()
            a = match["data"]["attributes"]
            if a.get("matchType") not in types:
                skipped.add(mid)
                skip_path.write_text(json.dumps(sorted(skipped)))
                continue
            url = next(i for i in match["included"] if i["type"] == "asset")["attributes"]["URL"]
            res = api_get(url)
            if res is None:
                continue
            body = res.content
            if body[:2] == b"\x1f\x8b":
                body = gzip.decompress(body)
        except SystemExit as e:  # api_get이 오류로 멈춰도 이 경기만 건너뛰고 계속
            print(f"  건너뜀: {e}")
            continue

        # 피격은 총기 피해만 (자기장·낙하 등 제외)
        events = [e for e in json.loads(body) if e.get("_T") in KEEP
                  and (e["_T"] != "LogPlayerTakeDamage" or e.get("damageTypeCategory") == "Damage_Gun")]
        for e in events:
            e.pop("common", None)
            for f in CHAR_FIELDS:
                if isinstance(e.get(f), dict):
                    e[f] = {k: v for k, v in e[f].items() if k in CHAR_KEYS}
        anonymize(events, {})
        info = {"data": {"attributes": {k: a.get(k) for k in ("matchType", "gameMode", "mapName", "createdAt")}}}
        (OUT / f"match_{mid}.json").write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
        tel_path = OUT / f"telemetry_{mid}.json"
        tel_path.write_text(json.dumps(events, ensure_ascii=False), encoding="utf-8")
        have.add(mid)
        print(f"  [{len(have)}/{args.count}] {a.get('mapName')} / {a.get('gameMode')} · {tel_path.stat().st_size / 1e6:.1f} MB", flush=True)

    print(f"\n완료: 일반 경기 {len(have)}개 · 제외 {len(skipped)}개 · 폴더 {sum(p.stat().st_size for p in OUT.iterdir()) / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
