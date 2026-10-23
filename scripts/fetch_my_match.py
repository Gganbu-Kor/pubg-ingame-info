"""
내 최근 경기 텔레메트리 받아오기 (Day 2 - 1단계)

흐름: 닉네임 → 플레이어 조회 → 최근 경기 ID → 경기 정보 → 텔레메트리 파일 → data/raw/ 에 저장

사용법 (프로젝트 폴더에서):
    .venv/bin/python scripts/fetch_my_match.py 닉네임
    .venv/bin/python scripts/fetch_my_match.py 닉네임 --index 1   # 두 번째로 최근 경기

참고한 공식 문서:
    요청 방법   https://documentation.pubg.com/en/making-requests.html
    요청 제한   https://documentation.pubg.com/en/rate-limits.html
    텔레메트리  https://documentation.pubg.com/en/telemetry.html
"""

import argparse
import gzip
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

# 프로젝트 폴더 기준 경로
ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"

API_BASE = "https://api.pubg.com"
MAX_RETRY = 3  # 요청 제한(429)일 때 다시 시도할 횟수
KST = timezone(timedelta(hours=9))


def load_settings():
    """ .env 에서 API 키와 샤드(플랫폼)를 읽는다. 키 값은 절대 출력하지 않는다. """
    load_dotenv(ROOT / ".env")
    key = os.getenv("PUBG_API_KEY", "").strip()
    shard = os.getenv("PUBG_SHARD", "steam").strip()
    if not key or "여기에" in key:
        sys.exit("오류: .env 파일에 PUBG_API_KEY가 없습니다. .env.example을 참고해 키를 넣어 주세요.")
    return key, shard


def api_get(url, key=None, params=None):
    """
    공식 API에 GET 요청. 429(요청 제한)면 리셋 시각까지 기다렸다가 다시 시도한다.
    key가 None이면 인증 헤더를 붙이지 않는다 (텔레메트리 파일은 키 없이 받는 주소).
    """
    headers = {"Accept": "application/vnd.api+json", "Accept-Encoding": "gzip"}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    for attempt in range(1, MAX_RETRY + 1):
        res = requests.get(url, headers=headers, params=params, timeout=60)

        if res.status_code == 429:
            # X-RateLimit-Reset: 제한이 풀리는 시각(UNIX 시간). 없으면 60초 대기
            reset = res.headers.get("X-RateLimit-Reset")
            wait = max(1, int(reset) - int(time.time())) if reset and reset.isdigit() else 60
            print(f"  요청 제한(429) — {wait}초 기다린 뒤 다시 시도합니다 ({attempt}/{MAX_RETRY})")
            time.sleep(wait)
            continue

        # 오류 메시지에는 키가 들어가지 않도록 상태 코드와 설명만 보여준다
        if res.status_code == 401:
            sys.exit("오류(401): API 키가 올바르지 않습니다. .env의 PUBG_API_KEY를 확인해 주세요.")
        if res.status_code == 404:
            return None
        if not res.ok:
            sys.exit(f"오류({res.status_code}): 요청에 실패했습니다.")
        return res

    sys.exit("오류: 요청 제한이 계속되어 중단합니다. 1분 뒤 다시 실행해 주세요.")


def find_player(key, shard, name):
    """ 닉네임 → 플레이어 정보 (닉네임은 대소문자를 구분함) """
    res = api_get(f"{API_BASE}/shards/{shard}/players", key, params={"filter[playerNames]": name})
    if res is None:
        sys.exit(f"오류: '{name}' 플레이어를 찾지 못했습니다. 대소문자까지 정확한지, 샤드({shard})가 맞는지 확인해 주세요.")
    return res.json()["data"][0]


def save_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def download_match(key, shard, match_id):
    """ 경기 정보 + 텔레메트리를 받아 data/raw/ 에 저장. (경기 정보, 텔레메트리, 저장 경로) 반환 """
    # 경기 정보 → 텔레메트리 파일 주소 (included 안의 type이 "asset"인 항목)
    match_res = api_get(f"{API_BASE}/shards/{shard}/matches/{match_id}", key)
    if match_res is None:
        sys.exit("오류: 경기 정보를 찾지 못했습니다.")
    match = match_res.json()
    asset = next((i for i in match["included"] if i["type"] == "asset"), None)
    if asset is None:
        sys.exit("오류: 이 경기에는 텔레메트리 파일 주소가 없습니다.")
    telemetry_url = asset["attributes"]["URL"]

    # 텔레메트리 다운로드 (키 없이 받는 주소라 인증 헤더를 붙이지 않음)
    tel_res = api_get(telemetry_url)
    if tel_res is None:
        sys.exit("오류: 텔레메트리 파일을 받지 못했습니다.")
    body = tel_res.content
    if body[:2] == b"\x1f\x8b":  # 압축이 자동으로 풀리지 않은 경우 직접 푼다
        body = gzip.decompress(body)
    telemetry = json.loads(body)

    # 저장: 원본 그대로 data/raw/ 에 (git에 올라가지 않는 폴더)
    tel_path = RAW_DIR / f"telemetry_{match_id}.json"
    save_json(RAW_DIR / f"match_{match_id}.json", match)
    save_json(tel_path, telemetry)
    return match, telemetry, tel_path


def main():
    parser = argparse.ArgumentParser(description="내 최근 경기 텔레메트리 받아오기")
    parser.add_argument("name", help="PUBG 닉네임 (대소문자 구분)")
    parser.add_argument("--index", type=int, default=0, help="0 = 가장 최근 경기, 1 = 그 전 경기 ...")
    parser.add_argument("--count", type=int, default=0,
                        help="검증용: 최근 경기 n개를 한꺼번에 받기 (이미 받은 경기는 건너뜀, latest.json은 바꾸지 않음)")
    args = parser.parse_args()

    key, shard = load_settings()
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    # 1) 플레이어 조회 → 최근 경기 ID 목록 (공식 API는 최근 14일 경기만 제공)
    print(f"1/3 플레이어 조회: {args.name}")
    player = find_player(key, shard, args.name)
    match_ids = [m["id"] for m in player["relationships"]["matches"]["data"]]
    if not match_ids:
        sys.exit("최근 14일 안의 경기 기록이 없습니다.")

    # 검증용 여러 경기 받기
    if args.count:
        targets = match_ids[:args.count]
        print(f"    최근 경기 {len(match_ids)}개 중 앞의 {len(targets)}개 확인")
        for i, mid in enumerate(targets, 1):
            if (RAW_DIR / f"telemetry_{mid}.json").exists():
                print(f"  [{i}/{len(targets)}] 이미 있음 — 건너뜀")
                continue
            match, telemetry, tel_path = download_match(key, shard, mid)
            a = match["data"]["attributes"]
            print(f"  [{i}/{len(targets)}] {a.get('mapName')} / {a.get('gameMode')} · 이벤트 {len(telemetry):,}개 "
                  f"({tel_path.stat().st_size / 1_000_000:.1f} MB)")
        return

    if args.index >= len(match_ids):
        sys.exit(f"경기는 {len(match_ids)}개뿐입니다. --index는 0~{len(match_ids) - 1} 사이로 넣어 주세요.")
    match_id = match_ids[args.index]
    print(f"    최근 경기 {len(match_ids)}개 중 {args.index + 1}번째 선택")

    # 2) 경기 정보 조회 3) 텔레메트리 다운로드
    print("2/3 경기 정보 조회 · 3/3 텔레메트리 다운로드 (수십 MB일 수 있어 시간이 걸립니다)")
    match, telemetry, tel_path = download_match(key, shard, match_id)
    attrs = match["data"]["attributes"]
    # 2단계 분석 스크립트가 어떤 경기를 볼지 알 수 있게 마지막 실행 정보를 남긴다
    save_json(RAW_DIR / "latest.json", {"name": args.name, "account_id": player["id"], "match_id": match_id})

    # 결과 요약 (다른 플레이어 정보는 출력하지 않음)
    created = datetime.fromisoformat(attrs["createdAt"].replace("Z", "+00:00")).astimezone(KST)
    print("\n완료")
    print(f"  경기 시작   {created:%Y-%m-%d %H:%M} (한국 시간)")
    print(f"  맵 / 모드   {attrs.get('mapName')} / {attrs.get('gameMode')}")
    print(f"  이벤트 수   {len(telemetry):,}개")
    print(f"  저장 위치   {tel_path.relative_to(ROOT)} ({tel_path.stat().st_size / 1_000_000:.1f} MB)")


if __name__ == "__main__":
    main()
