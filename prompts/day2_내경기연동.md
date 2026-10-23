# Day 2 (10/19) — 내 경기 연동

CLAUDE.md를 다시 읽어줘. 오늘은 공식 PUBG API로 내 최근 경기를 불러올 거야.

1단계 (파이썬, scripts/fetch_my_match.py)
- .env에서 PUBG_API_KEY와 PUBG_SHARD를 읽을 것 (키를 출력하지 말 것)
- 닉네임 → 플레이어 조회 → 가장 최근 경기 → 텔레메트리 파일 다운로드 → data/raw/에 저장
- 요청 제한(429)이면 기다렸다가 재시도
- 공식 문서(documentation.pubg.com)에서 필요한 엔드포인트와 이벤트 이름을 확인하고, 확인한 문서 주소를 알려줘

2단계 (분석)
- 내가 피격자인 LogPlayerTakeDamage 이벤트를 모아서: 공격자 무기(damageCauserName), 부위(damageReason), 피해량, 시각
- 내가 기절/사망한 이벤트 직전에 맞은 공격을 묶어서 "나를 쓰러뜨린 공격" 요약
- 결과를 data/my_match_summary.json으로 저장 (닉네임 외 다른 플레이어의 계정 ID는 저장하지 말 것)
- damageCauserName은 api-assets의 사전으로 사람이 읽는 이름으로 바꿀 것

3단계 (화면)
- src/ 화면에 "내 최근 경기" 탭 추가: my_match_summary.json을 읽어
  "○○ 총에 몸통 ○발, 머리 ○발을 맞고 쓰러졌습니다" + 그 총의 몇 발 컷 정보 연결

필드 의미가 불확실하면 추측하지 말고 실제 데이터 샘플을 보여주며 물어봐.
