// 인게임 컨셉 화면 3장 — 공식 기능이 된다면 어떻게 보일지 그린 목업.
// 수치는 모두 data/ (calc.js)와 내 경기 분석 결과(data/my_match_summary.json)에서 계산한다.
// 무기 이름·탭 이름 같은 화면 문구와 "예시" 표시가 붙은 자리 채움 글만 여기에 적는다.
import { loadData, loadClasses, parseCSV, baseAt, zoneResult } from "./calc.js";
import { silhouetteSVG } from "./silhouette.js";
import { targetTip, partsWithDamage, partLabel, isShotgunTarget, loadCardRules, isZoneHit, causeName, otherDamage } from "./target_tip.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r2 = n => String(Number(Number(n).toFixed(2)));
const ms = t => (t == null ? "–" : `${Math.round(t)}ms`);
const lvName = lv => (lv === 0 ? "없음" : lv === "broken" ? "부서짐" : `${lv}레벨`);
const tone = n => `s${Math.min(n, 6)}`;
const TAG = `<div class="mock-tag">개인 컨셉 목업 · 공식 아님</div>`;

// 화면에 쓸 무기 (화면 문구 — 수치는 data/에서 읽음)
// ② 무기창 (작성자 제공 실제 화면의 배치를 따름 10/21): [번호, 무기, 탄 수(예시)] — 마우스는 INV_WEAPON에
const INV_SLOTS = [[2, "Mini 14", 30], [1, "AUG", 40], [3, "P18C", 17]];
const INV_WEAPON = "AUG";
const LOBBY_WEAPON = "AUG";                // ③ 로비 총기 정보에서 펼쳐 놓은 무기 (② 툴팁의 "로비 › 총기 정보"에서 이어짐)
const SHOW_VEST = 2;                       // ②·③ 기준 상대 조끼 (실측에서 가장 많이 맞은 레벨: 조끼 2레벨)

let D; // data/ 전체 (loadData 결과)
const weapon = name => D.weapons.find(w => w.weapon === name);
const zone = key => D.zones.find(z => z.zone === key);
const armorOf = (vest, helmet = 0) => ({
  vest: D.vests.find(v => v.level === vest), helmet: D.helmets.find(h => h.level === helmet),
});
const result = (w, zoneKey, vest, helmet = 0, dist = 0) =>
  zoneResult(w, zone(zoneKey), baseAt(w, D.falloff, dist), armorOf(vest, helmet), D.classMult);

// 무기 하나의 부위별 필요 발수 실루엣
function shotsSilhouette(w, vest, helmet, label) {
  const cells = {};
  for (const z of D.zones) {
    const r = result(w, z.zone, vest, helmet);
    if (r) cells[z.zone] = { text: r.shots, tone: tone(r.shots), title: `${z.zone_ko} ${r.shots}발` };
  }
  return silhouetteSVG(D.zones, cells, { label });
}

// 작은 실루엣: 확정 = 진한 색(숫자), 두 부위 중 한 곳·세부 부위 모름 = 연한 색
function smallSilhouette(shots, label, numbers = true) {
  const sure = {}, maybe = {};
  shots.forEach(s => {
    const k = s.zone_keys ?? [];
    if (k.length === 1) sure[k[0]] = (sure[k[0]] ?? 0) + 1;
    else if (k.length) k.forEach(z => (maybe[z] = true));
    else D.zones.filter(z => z.damage_reason === s.reason).forEach(z => (maybe[z.zone] = true));
  });
  const cells = {};
  D.zones.forEach(z => {
    if (sure[z.zone]) cells[z.zone] = { text: numbers ? sure[z.zone] : "", tone: "s2", title: `${z.zone_ko} 맞음` };
    else if (maybe[z.zone]) cells[z.zone] = { text: "", tone: "s5", title: `${z.zone_ko}일 수 있음` };
  });
  return silhouetteSVG(D.zones, cells, { label, emptyText: "", textOnce: true });
}

// ── 카드가 다루는 공격 (10/23 작성자 결정) ─────────────────────────────
// 부위가 기록되는 공격(총·근접 무기·주먹·발차기)만 실루엣·발수로 그린다 (settings.csv의 card_damage_categories).
// 수류탄·화염병·블루존 수류탄 등 부위가 남지 않는 피해는 원인별 피해 합계로만 보여 준다 (이름은 damage_causes.csv).
// 버튼·카드 제목은 부위가 남는 공격 기준 (무엇에 쓰러졌는지는 게임의 사망 문구·데스캠이 이미 알려 줌).
let RULES = { cats: new Set(), causeKo: new Map() };   // init에서 data/ 파일로 채움
function cardShots(d) {
  const shots = d.shots.filter(s => isZoneHit(s, RULES));
  if (!shots.length) return { shots };
  const last = shots[shots.length - 1];
  // 짧은 요약 (작성자 지적 10/23): 마지막 발의 무기 + 다른 무기 종류 수 → 여러 명·여러 총에 맞아도 길이가 일정
  const otherKinds = new Set(shots.map(s => s.weapon)).size - 1;
  const short = `${last.weapon}${otherKinds > 0 ? ` 외 ${otherKinds}종` : ""}`;
  // 마지막 피해까지 부위가 남는 공격이면 "에 쓰러짐", 아니면(예: 총에 맞다가 수류탄에 쓰러짐) "에 맞음"
  const verb = d.shots[d.shots.length - 1] === last ? "에 쓰러짐" : "에 맞음";
  return { shots, short, verb, sec: (last.t_ms - shots[0].t_ms) / 1000 };
}
// 부위 없는 피해 줄: "수류탄 · 60"
const otherList = list => (list.length
  ? `<ul class="f1-parts">${list.map(([n, dmg]) => `<li><strong>${esc(n)}</strong> · ${Math.round(dmg)}</li>`).join("")}</ul>` : "");

// ── ① 경기 종료 후 결과 화면: 데스캠 옆 "쓰러진 공격" 버튼 ─────────────
// 10/22 작성자 결정: 경기 중(먼저 쓰러진 팀원에게) 보여 주면 살아 있는 팀원에게 상대 정보가 전달돼 공정성을 해침
// 10/23 작성자 결정: 내 팀이 모두 쓰러진 뒤 결과 화면의 기존 "데스캠" 버튼 옆에 버튼을 더하고, 누르면 카드가 열림
//   버튼 글자에 핵심 한 줄(무엇에 몇 발)을 넣어 누르지 않아도 보이게. 자세한 기록은 로비 › 전적 › 매치 리포트(①-2)
// 10/23 작성자 결정: "내가 공격하던 적"은 수류탄 등도 포함. 같은 교전에서 피해를 준 다른 적은 "외 N명" 한 줄로
// 10/21 작성자 피드백: 대부분은 가볍게 즐기고 필요한 정보만 본다 → 카드는 "무엇에 · 어디를 · 팁 한 줄"만
// elId: 그릴 칸 / pick: 여러 번 쓰러진 경기에서 보여줄 쓰러짐 고르기 (기본: 첫 번째)
function frame1(summary, elId = "f1", pick = downs => downs[0]) {
  const el = document.getElementById(elId);
  const d = summary?.downs?.length ? pick(summary.downs) : null;
  if (!d) { el.innerHTML = `${TAG}<p style="padding:40px">분석한 경기에 쓰러진 기록이 없습니다.</p>`; return; }

  const c = cardShots(d);
  const t = d.my_target;
  const others = d.my_other_targets ?? [];
  const mineOther = otherDamage(d.shots, RULES);           // 내가 맞은 부위 없는 피해 (수류탄 등)
  const tZone = t ? t.hits.filter(h => isZoneHit(h, RULES)) : [];
  const tOther = t ? otherDamage(t.hits, RULES) : [];      // 내가 준 부위 없는 피해
  // 버튼이 생기는 조건 (10/23): 부위가 남는 공격에 1발 이상 맞았거나, 내가 공격하던 적이 있을 때
  const hasCard = c.shots.length > 0 || !!t;
  const tipB = t ? targetTip(t, D) : "";

  const bi = c.shots.findIndex(s => s.my_vest === "broken");
  const broken = D.vests.find(v => v.level === "broken");
  // TIP 한 줄: 내가 공격하던 적의 방어구가 내 피해를 얼마나 줄였나 우선, 없으면 내 조끼가 부서진 경우 (작성자 결정 10/21)
  const tip = tipB || (bi > 0 && broken
    ? `조끼가 ${bi}번째 발에 부서졌어요. 부서진 조끼도 ${Math.round(broken.damage_reduction * 100)}% 막아 줘요.` : "");
  // 목록은 위에서 3줄까지만, 나머지는 "외 n발" (작성자 피드백: 핵심만)
  // 내가 맞은 부위: "머리 1발 · 56" — 상대 칸과 같은 형식 (작성자 제안 10/23). 마지막 발은 남은 체력만큼만 기록됨
  const mineList = () => {
    const list = partsWithDamage(c.shots, D.zones);
    const top = list.slice(0, 3), rest = list.slice(3).reduce((a, [, n]) => a + n, 0);
    return `<ul class="f1-parts">${top.map(([p, n, dmg]) => `<li><strong>${esc(p)}</strong> ${n}발 · ${Math.round(dmg)}</li>`).join("")}${rest ? `<li class="muted">외 ${rest}발</li>` : ""}</ul>`;
  };
  // 내가 맞힌 부위: "가슴 2발 · 63" (샷건은 숫자 없이 부위만)
  const targetList = () => {
    const list = partsWithDamage(tZone, D.zones);
    if (sgTarget) return `<ul class="f1-parts">${list.slice(0, 3).map(([p]) => `<li><strong>${esc(p)}</strong></li>`).join("")}</ul>`;
    const top = list.slice(0, 3), rest = list.slice(3).reduce((s, [, n]) => s + n, 0);
    return `<ul class="f1-parts">${top.map(([p, n, dmg]) => `<li><strong>${esc(p)}</strong> ${n}발 · ${Math.round(dmg)}</li>`).join("")}${rest ? `<li class="muted">외 ${rest}발</li>` : ""}</ul>`;
  };
  const sgTarget = t && isShotgunTarget(t, D);
  // 적에게 준 피해 합계 줄: 부위 없는 피해가 섞이면 "합계", 아니면 지금처럼 "총 N발 · 피해"
  const targetTotal = () => (tOther.length ? `합계 <strong>${Math.round(t.total_damage)}</strong> 피해`
    : sgTarget ? "샷건 · 맞힌 부위만 표시" : `총 <strong>${tZone.length}발 · ${Math.round(t.total_damage)}</strong> 피해`);

  // 버튼 글자: 부위가 남는 공격만 셈 (없으면 공격하던 적 정보만)
  const label = c.shots.length ? `쓰러진 공격 · ${c.short} · ${c.shots.length}발` : "쓰러진 공격 · 내가 공격하던 적";
  const resultArea = `<div class="f1-result">기존 결과 화면 자리<br><span>순위 · 처치 · 피해량 등 (그리지 않음)</span>
      <div class="f1-btns">
        <span class="f1-btn">데스캠 <span class="muted">(기존)</span></span>
        ${hasCard ? `<span class="f1-btn new"><span class="pill road">추가</span> ${esc(label)}</span>` : ""}
      </div>
    </div>`;
  const note = `<div class="scene-note">배경은 결과 화면 자리(실제 게임 이미지 아님) · 작성자 실제 경기(${esc(summary.match.created_kst)}) 공식 API 기록 · ${hasCard ? "내 팀이 모두 쓰러진 뒤, 데스캠 옆 버튼을 누르면 열림" : "버튼이 생기지 않는 경우"}</div>`;
  if (!hasCard) {
    el.innerHTML = `${TAG}
    <div class="f1-spec">경기 종료 · 내 팀 결과 화면</div>
    ${resultArea}
    <div class="f1-none muted">이 쓰러짐은 부위가 남는 공격이 없고 공격하던 적도 없어 버튼이 생기지 않습니다.<br>무엇에 쓰러졌는지는 사망 문구·데스캠이 알려 줍니다.</div>
    ${note}`;
    return;
  }
  const meCol = c.shots.length > 0 || mineOther.length > 0;
  const cols = (meCol ? 1 : 0) + (t ? 1 : 0);
  el.innerHTML = `${TAG}
    <div class="f1-spec">경기 종료 · 내 팀 결과 화면</div>
    ${resultArea}
    <div class="panel f1-card">
      <div class="f1-open muted">"쓰러진 공격" 버튼을 눌러 연 카드</div>
      <div class="f1-head">
        ${c.shots.length ? `<div class="f1-weapon">${esc(c.short)}<span>${c.verb}</span></div>
        <div class="f1-meta">${c.shots.length}발 · ${c.sec.toFixed(1)}초</div>` : `<div class="f1-weapon">내가 공격하던 적</div>`}
      </div>
      <div class="f1-two${cols === 1 ? " one" : ""}">
        ${meCol ? `<div class="f1-side-col">
          <div class="f1-cap">나</div>
          ${c.shots.length ? smallSilhouette(c.shots, "내가 맞은 부위") : ""}
          ${c.shots.length ? mineList() : ""}
          ${otherList(mineOther)}
        </div>` : ""}
        ${t ? `<div class="f1-side-col">
          <div class="f1-cap">${esc(t.label)} <span class="muted">· ${t.is_killer ? "내가 공격하던 적 = 나를 쓰러뜨림" : "내가 공격하던 적"}</span></div>
          ${tZone.length ? smallSilhouette(tZone, `${t.label}에게 맞힌 부위`, !sgTarget) : ""}
          ${tZone.length ? targetList() : ""}
          ${otherList(tOther)}
          <div class="f1-hp">${targetTotal()}${t.knocked_by_me ? " · 기절시킴" : ""}${t.healed_reset ? '<div class="muted" style="font-size:12px">상대가 회복해서 다시 셈</div>' : ""}</div>
        </div>` : ""}
      </div>
      ${others.length ? `<div class="f1-others muted">외 ${others.length}명에게도 피해 · 합계 ${Math.round(others.reduce((a, o) => a + o.total_damage, 0))}</div>` : ""}
      ${tip ? `<div class="f1-tip"><span class="pill warn">TIP</span> ${esc(tip)}</div>` : ""}
      <div class="f1-foot muted">자세한 기록: 로비 › 전적 › 매치 리포트</div>
    </div>
    ${note}`;
}

// ── ①-2 로비 › 전적 › 매치 리포트: "쓰러진 공격" 항목 ──────────────────
// 결과 화면 카드(①)는 "무엇에·어디를·팁 한 줄"만. 발마다 자세한 기록은 경기가 끝난 뒤 로비 전적에서 (10/21, 10/23 작성자 결정으로 결과 화면에서 이동)
// 10/23: 부위 없는 피해도 원인 이름과 함께 넣고, 같은 교전에서 피해를 준 적은 모두 보여 준다
function frame1c(summary) {
  const el = document.getElementById("f1c");
  const d = summary?.downs?.find(x => x.my_target) ?? summary?.downs?.[0];
  if (!d) { el.innerHTML = `${TAG}<p style="padding:40px">분석한 경기에 쓰러진 기록이 없습니다.</p>`; return; }
  // 0초 = 내가 처음 맞은 순간. 그 전에 내가 먼저 공격한 시각은 음수 대신 "맞기 N초 전" (작성자 결정 10/23)
  const sec = ms => (ms < 0 ? `맞기 ${(-ms / 1000).toFixed(2)}초 전` : `+${(ms / 1000).toFixed(2)}초`);

  const c = cardShots(d);
  // 왼쪽: 내가 맞은 순서 (다른 플레이어에게 받은 모든 피해)
  const mine = d.shots.map((s, i) => `
    <tr class="${s.my_vest === "broken" ? "hl" : ""}">
      <td class="num">${i + 1}</td><td class="num">${sec(s.t_ms)}</td><td>${esc(s.attacker)}</td>
      <td>${esc(causeName(s, RULES))}</td>
      <td>${isZoneHit(s, RULES) ? esc(partLabel(s, D.zones)) : '<span class="muted">부위 없음</span>'}</td>
      <td class="num">${r2(s.damage)}${s.clipped ? ' <span class="muted">(남은 체력)</span>' : ""}</td>
      <td>${esc(lvName(s.my_vest))}</td>
    </tr>`).join("");

  // 오른쪽: 내가 공격하던 적 + 같은 교전에서 피해를 준 다른 적 (시간순, 샷건은 숫자 없이 부위만)
  const t = d.my_target;
  const targets = t ? [t, ...(d.my_other_targets ?? [])] : [];
  const many = targets.length > 1;
  const sg = t && (weapon(t.calc_weapon)?.pellets ?? 1) > 1;
  const rows = targets.flatMap(x => x.hits.map(h => ({ ...h, who: x.label }))).sort((a, b) => a.t_ms - b.t_ms);
  const theirs = rows.map((h, i) => `
    <tr>
      <td class="num">${i + 1}</td><td class="num">${sec(h.t_ms)}</td>${many ? `<td>${esc(h.who)}</td>` : ""}<td>${esc(causeName(h, RULES))}</td>
      <td>${isZoneHit(h, RULES) ? esc(partLabel(h, D.zones)) : '<span class="muted">부위 없음</span>'}</td>
      <td class="num">${sg && isZoneHit(h, RULES) ? "–" : r2(h.damage)}</td>
      <td>${esc(lvName(h.target_vest))} · ${esc(lvName(h.target_helmet))}</td>
    </tr>`).join("");
  const tZoneN = t ? t.hits.filter(h => isZoneHit(h, RULES)).length : 0;
  const allZone = t && tZoneN === t.hits.length;
  const theirTitle = !t ? "" : many
    ? `내가 공격한 적 <span class="muted">· 이 교전 ${targets.length}명 (${esc(t.label)} = 내가 공격하던 적${t.is_killer ? " = 나를 쓰러뜨림" : ""})</span>`
    : `${esc(t.label)}에게 ${allZone ? "맞힌 발" : "준 피해"} <span class="muted">· ${t.is_killer ? "내가 공격하던 적 = 나를 쓰러뜨림" : "내가 공격하던 적"}</span>`;
  const theirNote = !t ? "" : many
    ? `${targets.map(x => `${esc(x.label)} ${r2(x.total_damage)}`).join(" · ")} 피해`
    : allZone ? (sg ? "샷건: 맞힌 부위만 표시" : `총 ${t.hits.length}발 · ${r2(t.total_damage)} 피해`) : `합계 ${r2(t.total_damage)} 피해`;

  // 아래 한 줄: 계산 비교 (첫 발 때 내 방어구, 첫 발 거리 이하에서 가장 가까운 측정 지점)
  const first = c.shots.find(s => s.calc_weapon);
  const w = first ? weapon(first.calc_weapon) : null;
  let calc = "";
  if (w) {
    const dists = D.falloff.get(w.weapon)?.map(p => p.distance) ?? [0];
    const dist = dists.filter(x => x <= (first.distance_m ?? 0)).pop() ?? dists[0];
    const r = result(w, "Chest", first.my_vest, first.my_helmet, dist);
    // 실제 거리가 감쇠 없는 구간(앞뒤 측정 지점 값이 같음)이면 그 거리 그대로, 아니면 어느 측정 지점 값인지 밝힘
    const pts = D.falloff.get(w.weapon) ?? [];
    const next = pts.find(p => p.distance > dist);
    const exact = !next || next.base === pts.find(p => p.distance === dist)?.base;
    const distText = exact ? `${first.distance_m}m` : `${first.distance_m}m (측정 지점 ${dist}m 값)`;
    if (r) calc = `계산: ${esc(w.weapon)} · 내 조끼 ${esc(lvName(first.my_vest))} · ${distText} → 가슴만 맞으면 <strong>${r.shots}발 · ${ms(r.ttk)}</strong>
      &nbsp;|&nbsp; 실제: <strong>${c.shots.length}발 · ${c.sec.toFixed(2)}초</strong> <span class="muted">(빗나간 발·발 사이 간격 포함)</span>`;
  }

  el.innerHTML = `${TAG}
    <div class="f1c-crumb">로비 › 전적 › 매치 히스토리 › <strong>매치 리포트</strong></div>
    <div class="f1c-old">기존 매치 리포트 자리 · 순위 · 처치 · 피해량 · 이동 경로 등 (그리지 않음)</div>
    <div class="panel f1c-panel">
      <div class="f1c-head">
        <div><span class="pill road">추가</span> <strong>쓰러진 공격</strong> <span class="muted">· 발마다 부위·피해·그때의 방어구</span></div>
        <div class="muted">${c.shots.length ? `${esc(c.short)}${c.verb} · ${c.shots.length}발 · ${c.sec.toFixed(2)}초` : "부위가 남는 공격 없음"}</div>
      </div>
      <div class="f1c-cols${t ? "" : " one"}">
        <div>
          <h3>내가 맞은 순서</h3>
          <div class="table-wrap"><table>
            <thead><tr><th class="num">#</th><th class="num">시간</th><th>상대</th><th>무기</th><th>부위</th><th class="num">피해</th><th>내 조끼</th></tr></thead>
            <tbody>${mine}</tbody>
          </table></div>
          ${d.shots.some(s => s.my_vest === "broken") ? `<p class="muted f1c-note">색칠된 줄: 내 조끼가 부서진 뒤 맞은 발 (부서진 조끼도 ${Math.round((D.vests.find(v => v.level === "broken")?.damage_reduction ?? 0) * 100)}% 막아 줌)</p>` : ""}
        </div>
        ${t ? `<div>
          <h3>${theirTitle}</h3>
          <div class="table-wrap"><table>
            <thead><tr><th class="num">#</th><th class="num">시간</th>${many ? "<th>상대</th>" : ""}<th>무기</th><th>부위</th><th class="num">피해</th><th>상대 조끼·헬멧</th></tr></thead>
            <tbody>${theirs}</tbody>
          </table></div>
          <p class="muted f1c-note">${theirNote}${t.healed_reset ? " · 상대가 회복해서 그 이후 발만 셈" : ""}</p>
        </div>` : ""}
      </div>
      ${calc ? `<div class="f1c-calc">${calc}</div>` : ""}
    </div>
    <div class="scene-note">배경은 로비 전적 화면 자리(실제 게임 이미지 아님) · 작성자 실제 경기(${esc(summary.match.created_kst)}) 공식 API 기록 · 시간은 내가 처음 맞은 순간 기준</div>`;
}

// ── ② 인벤토리 + 마우스 올림 ──────────────────────────────
// 10/21 작성자 피드백: 발수 표까지는 과함 → 자세한 수치는 로비 › 총기 정보에서.
// 실제 게임 툴팁에는 이미 분류·탄·사격 모드·소개 문구·능력치 막대가 있음 (작성자 제공 화면 10/21)
// → 새 툴팁이 아니라 기존 툴팁에 "용도" 한 줄만 추가. 기존 부분은 회색 칸으로 단순화 (공식 아이콘·이미지·막대 길이는 그리지 않음)
// 작성자 결정 10/21: "용도" 문구는 공식 사이트 분류 소개 문구 원문(classes.csv official_desc) + 쓰는 거리. 공식 문구가 없는 LMG만 작성자 문구
function frame2(classes) {
  const el = document.getElementById("f2");
  const cls = c => classes.find(x => x.class === c);
  const w = weapon(INV_WEAPON);
  const c = cls(w.class);
  const slots = INV_SLOTS.map(([no, name, ammo]) => [no, weapon(name), ammo]).filter(([, x]) => x);
  // 무기 칸: 번호 · 이름 · 탄 수/탄 종류 · 무기 이미지 자리 · 부착물 칸 (그림·스킨·아이콘은 그리지 않음)
  const row = ([no, x, ammo]) => `
    <div class="wslot${x.weapon === w.weapon ? " hover" : ""}">
      <div class="wslot-top">
        <span class="wno">${no}</span><strong class="wname">${esc(x.weapon)}</strong>
        <span class="wammo"><b>${ammo}</b><br><span class="muted">${esc(x.ammo)}</span></span>
      </div>
      <div class="wimg">무기 이미지 자리</div>
      <div class="watt">${'<i></i>'.repeat(3)}</div>
    </div>`;

  el.innerHTML = `${TAG}
    <div class="f2-weapons">
      ${slots.map(row).join("")}
      <div class="wslot wthrow"><div class="wslot-top"><span class="wno">5</span><strong class="wname">수류탄</strong></div><div class="wimg small">투척 무기 자리</div></div>
      <div class="f2-setup">
        <div class="k">지금 세팅</div>
        ${slots.map(([no, x]) => `<div><span class="muted">${no}</span> <strong>${esc(x.weapon)}</strong> · ${esc(x.class)} <span class="muted">${esc(cls(x.class)?.range ?? "")}</span></div>`).join("")}
      </div>
    </div>
    <svg class="cursor" style="left:330px;top:228px" viewBox="0 0 22 22" aria-hidden="true">
      <path d="M3 2 L3 18 L7.5 13.5 L10.5 20 L13 19 L10 12.5 L16 12.5 Z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>
    </svg>
    <div class="panel f2-tip">
      <div class="f2-old">
        <div class="head"><h3 style="font-size:20px">${esc(w.weapon)}</h3><span class="muted">${esc(w.ammo)}</span></div>
        <div class="muted" style="font-size:13px">${esc(c?.name_ko ?? "")}(${esc(w.class)})</div>
        <div class="f2-ph" style="height:64px">무기 이미지 자리</div>
        <div class="muted" style="font-size:13px">사격 모드 · 소개 문구 (기존)</div>
      </div>
      ${c ? `
      <div class="f2-new">
        <div class="f2-new-head"><span class="pill road">추가</span> <strong>용도</strong> <span class="f2-range">${esc(c.range)}</span></div>
        <p class="f2-role">${esc(c.official_desc || c.role)}</p>
        ${c.official_desc ? "" : '<p class="f2-tipline">(공식 문구 없음 · 작성자 정리)</p>'}
        <p class="muted f2-more">자세한 발수·TTK: 로비 › 총기 정보</p>
      </div>` : ""}
      <div class="f2-old">
        ${["1발 당 피해량", "초당 피해량", "발사 속도", "포구 속도", "안정성", "유효 사거리"].map(x =>
          `<div class="f2-bar"><span>${x}</span><i></i></div>`).join("")}
        <div class="muted" style="font-size:11px;margin-top:2px">능력치 막대 (기존 · 길이는 그리지 않음)</div>
      </div>
    </div>
    <div class="scene-note">무기창 배치는 실제 게임 화면을 단순화(그림·스킨·아이콘 없음, 탄 수는 예시) · 툴팁의 회색 부분 = 기존, 강조된 "용도"만 새로 추가</div>`;
}

// ── ③ 로비 › 총기 정보 ─────────────────────────────────
// 10/21 작성자 결정: 이미 만든 총기 가이드(분류 → 무기 → 상세)를 그대로 옮긴다.
// 게임 안에서는 페이지를 넘나들 수 없으므로 상세 칸에 계산기 실루엣(부위별 필요 발수)을 바로 붙임
function frame3(verify, classes) {
  const el = document.getElementById("f3");
  const pickClass = weapon(LOBBY_WEAPON)?.class ?? "AR";
  const w = weapon(LOBBY_WEAPON);
  const c = classes.find(x => x.class === pickClass);
  // 분류 안 무기 (가이드와 같이 guide_group으로 묶음: MG3 두 줄 → 하나)
  const inClass = [...new Map(D.weapons.filter(x => x.class === pickClass && x.auto_fire)
    .map(x => [x.guide_group || x.weapon, x])).values()]
    .sort((a, b) => (a.guide_group || a.weapon).localeCompare(b.guide_group || b.weapon, "ko"));
  const cr = result(w, "Chest", SHOW_VEST), hr = result(w, "Head", SHOW_VEST, SHOW_VEST), tr = result(w, "Thigh", SHOW_VEST);
  const vText = verify ? `실제 경기 기록 ${verify.n.toLocaleString()}발 중 ${verify.rate}% 일치하는 계산` : "";

  el.innerHTML = `${TAG}
    <div class="f3-bar">
      <span class="crumb">로비 <span class="muted">›</span></span>
      <span class="tab on">총기 정보</span><span class="tab">콘텐츠 <span class="pill road">로드맵</span></span>
    </div>
    <div class="f3-guide">
      <div class="panel f3-col">
        <div class="f3-step"><span class="stepno">1</span> 분류</div>
        ${classes.map(x => `<div class="f3-cls${x.class === pickClass ? " on" : ""}"><strong>${esc(x.name_ko)}</strong> <span class="muted">${esc(x.class)}</span><div class="f3-range">${esc(x.range)}</div></div>`).join("")}
      </div>
      <div class="panel f3-col">
        <div class="f3-step"><span class="stepno">2</span> ${esc(c?.name_ko ?? pickClass)} 무기</div>
        ${inClass.map(x => `<div class="f3-wpn${x.weapon === w.weapon ? " on" : ""}"><strong>${esc(x.guide_group || x.weapon)}</strong><span class="muted">${esc(x.ammo)}</span></div>`).join("")}
      </div>
      <div class="panel f3-detail">
        <div class="f3-step"><span class="stepno">3</span> 상세</div>
        <div class="f3-dhead"><h3>${esc(w.weapon)}</h3><span class="muted">${esc(c?.name_ko ?? "")}(${esc(w.class)}) · ${esc(w.ammo)}${w.rpm ? ` · ${w.rpm}RPM` : ""}</span>
          <span class="pill ${w.verified === "Y" ? "road" : "warn"}">${w.verified === "Y" ? "실측 검증됨" : "미검증"}</span></div>
        ${c ? `<p class="f3-role"><span class="f3-range">${esc(c.range)}</span> · ${esc(c.role)}</p>` : ""}
        <div class="f3-sel">
          <div class="f3-armor"><span class="f3-lbl">상대 조끼</span>${D.vests.map(v => `<span class="seg${v.level === SHOW_VEST ? " on" : ""}">${esc(lvName(v.level))}</span>`).join("")}</div>
          <div class="f3-armor"><span class="f3-lbl">상대 헬멧</span>${D.helmets.map(h => `<span class="seg${h.level === SHOW_VEST ? " on" : ""}">${esc(lvName(h.level))}</span>`).join("")}</div>
          <div class="f3-armor"><span class="f3-lbl">거리</span>${(D.falloff.get(w.weapon) ?? []).map(p => `<span class="seg${p.distance === 0 ? " on" : ""}">${p.distance}m</span>`).join("")}</div>
        </div>
        <div class="f3-body">
          ${shotsSilhouette(w, SHOW_VEST, SHOW_VEST, `${w.weapon} 부위별 필요 발수`)}
          <div class="kv">
            <div class="muted" style="font-size:12px">숫자 = 필요 발수 · 체력 100</div>
            가슴 <strong>${cr.shots}발</strong> · ${ms(cr.ttk)}<br>
            머리 <strong>${hr.shots}발</strong> · ${ms(hr.ttk)}<br>
            허벅지 <strong>${tr.shots}발</strong> · ${ms(tr.ttk)}
            <div style="margin-top:12px"><span class="btn">다른 무기와 비교 →</span></div>
          </div>
        </div>
        <p class="muted" style="font-size:12px;margin:8px 0 0">프로토타입(총기 가이드 + TTK 계산기)과 같은 데이터 · ${esc(vText)}</p>
      </div>
    </div>
    <div class="scene-note">로비 메뉴 안의 새 화면 (예시 배치) · 총기 가이드의 분류 → 무기 → 상세 구조 그대로 · 콘텐츠는 로드맵 · 스킨 검색은 커스터마이즈에</div>`;
}

// ── ③-2 로비 › 콘텐츠 › 설정 공유 (확장 로드맵) ──────────────────
// 10/21 작성자 제안: 게임에 이미 있는 "환경 설정 코드 입력"에, 동의받은 프로·스트리머·랭커의 설정을 찾아 바로 적용하는 길을 더함
// 실제 인물·실제 코드를 지어내지 않도록 이름·수치·코드는 모두 가상의 예시
const SHARE_CARDS = [
  ["프로선수 A", "프로", "팀 예시", 1820, "cross"], ["스트리머 B", "스트리머", "", 1540, "dot"],
  ["랭커 C", "경쟁전 랭커", "", 1210, "circle"], ["프로선수 D", "프로", "팀 예시", 980, "dot"],
  ["스트리머 E", "스트리머", "", 870, "cross"], ["랭커 F", "경쟁전 랭커", "", 760, "cross"],
  ["프로선수 G", "프로", "팀 예시", 640, "circle"], ["스트리머 H", "스트리머", "", 520, "dot"],
];
function frame3b() {
  const el = document.getElementById("f3b");
  // 단순한 조준점 그림 (공식 조준점 이미지 아님)
  const xh = k => `<svg viewBox="-20 -20 40 40" width="40" height="40">${
    k === "dot" ? '<circle r="2.5" fill="#fff"/>'
    : k === "circle" ? '<circle r="7" fill="none" stroke="#fff" stroke-width="1.6"/><circle r="1.4" fill="#fff"/>'
    : '<path d="M-10 0h6M4 0h6M0 -10v6M0 4v6" stroke="#7fe0a0" stroke-width="2"/>'}</svg>`;
  const card = ([name, kind, team, n, k], i) => `
    <div class="f5-card${i === 0 ? " on" : ""}">
      <div class="f5-prev">${xh(k)}<span class="f5-n">적용 ${n.toLocaleString()}</span></div>
      <div class="f5-name">${esc(name)}</div>
      <div class="f5-meta"><span class="pill ${kind === "프로" ? "road" : "warn"}">${esc(kind)}</span> <span class="f5-ok">✓ 본인 동의</span></div>
      <span class="f5-apply">적용</span>
    </div>`;
  const row = (k, v) => `<div class="f5-row"><span class="muted">${k}</span><strong>${v}</strong></div>`;
  el.innerHTML = `${TAG}
    <div class="f3-bar">
      <span class="crumb">로비 <span class="muted">›</span></span>
      <span class="tab">총기 정보</span><span class="tab on">콘텐츠</span>
    </div>
    <div class="f5-filter">
      <span class="seg on">전체</span><span class="seg">프로</span><span class="seg">스트리머</span><span class="seg">경쟁전 랭커</span>
      <span class="muted" style="margin-left:auto">정렬: 적용 많은 순</span>
    </div>
    <div class="f5-grid">${SHARE_CARDS.map(card).join("")}</div>
    <div class="panel f5-detail">
      <div class="f5-dhead"><div><div class="f5-dname">프로선수 A</div><div class="muted" style="font-size:13px">팀 예시 · 갱신 10/15 (예시)</div></div>
        <span class="pill road">공식 인증</span></div>
      <div class="f5-rows">
        ${row("일반 감도", "42")}${row("조준 감도", "38")}${row("스코프 감도 (2·3·4배)", "36 · 34 · 32")}${row("조준점", "십자 · 초록")}
      </div>
      <div class="f5-dpi"><div><span class="muted">마우스 DPI</span> <strong>800</strong></div>
        <div class="muted">코드로 적용되지 않아요 · 내 마우스 프로그램에서 같은 DPI로 맞춰야 같은 감도가 돼요</div></div>
      <p class="muted f5-note">모든 값은 예시 · 환경 설정 코드에는 게임 안 감도만 들어 있어요</p>
      <div class="f5-actions">
        <span class="btn primary">적용하기</span><span class="btn">내 설정으로 되돌리기</span>
      </div>
      <p class="muted f5-note">적용하면 기존 "환경 설정 코드 입력" 기능을 사용하고, 내 설정은 자동으로 백업됩니다 · 코드 XXXX-XXXX (예시)</p>
      <div class="f5-video"><div class="f5-thumb">▶</div><div><strong>이 설정으로 플레이한 영상</strong><div class="muted" style="font-size:12px">본인이 등록한 유튜브 링크 (예시)</div></div></div>
      <div class="f5-esports">소속 팀 · 대회 일정 보기 →</div>
    </div>
    <div class="scene-note">로비 › 콘텐츠 (확장 로드맵) · 이름·수치·코드는 모두 가상의 예시 (실제 인물 아님) · 설정 공유는 본인 동의를 받은 경우만</div>`;
}

// ── ④ 지도 — 비밀의 방·고정 차량 표시 버튼 (확장 로드맵) ──────────
// 10/21 작성자 제안: 신규·라이트 유저가 경기 중 디스코드·카페에서 위치를 찾아보는 불편 → 기존 지도 화면에 켜고 끄는 버튼 추가
// 실제 맵 이미지·실제 위치·외부 사이트 자료는 쓰지 않음: 단순 도형의 가상 섬 + 예시 위치
const MAP_ROOMS = [[180, 130], [300, 95], [470, 120], [610, 170], [140, 300], [395, 350], [560, 330], [210, 470], [480, 500], [640, 430]];
const MAP_CARS = [[255, 215], [430, 250], [590, 260], [330, 440], [600, 520]];
function frame4() {
  const el = document.getElementById("f4");
  const room = ([x, y]) => `<g transform="translate(${x},${y})"><circle r="13" fill="none" stroke="#f5d547" stroke-width="3.5"/><rect x="-5" y="-6" width="10" height="11" rx="1.5" fill="#f5d547"/></g>`;
  const car = ([x, y]) => `<g transform="translate(${x},${y})"><rect x="-15" y="-10" width="30" height="20" rx="6" fill="#7aa7f5" stroke="#0d1b2e" stroke-width="2"/><path d="M-9 -1 h18 l-3 -5 h-12 z" fill="#0d1b2e"/><circle cx="-8" cy="7" r="3" fill="#0d1b2e"/><circle cx="8" cy="7" r="3" fill="#0d1b2e"/></g>`;
  const grid = Array.from({ length: 7 }, (_, i) => `<line x1="${(i + 1) * 100}" y1="0" x2="${(i + 1) * 100}" y2="620" /><line x1="0" y1="${(i + 1) * 88}" x2="760" y2="${(i + 1) * 88}" />`).join("");
  el.innerHTML = `${TAG}
    <div class="f4-mapname"><div class="big">맵 이름</div><div class="muted">예시 · 실제 지도 아님</div></div>
    <div class="f4-tabs"><span class="on">맵</span><span>매치 로그</span><span>미션</span></div>
    <div class="f4-map">
      <svg viewBox="0 0 760 620" aria-label="가상의 섬 지도 (예시)">
        <rect width="760" height="620" fill="#1d2a36"/>
        <path d="M90 140 C120 60 260 40 380 60 C470 30 600 60 670 120 C720 170 700 260 690 330 C700 420 660 520 560 560 C450 600 330 580 250 560 C150 540 80 470 70 380 C50 290 60 210 90 140 Z" fill="#4a4a3c" stroke="#5c5b4a" stroke-width="3"/>
        <path d="M300 300 C340 270 420 280 440 310 C420 330 360 335 300 300 Z" fill="#1d2a36"/>
        <path d="M120 250 C220 260 300 240 380 200 S560 160 650 220 M200 420 C300 380 420 390 520 360 S630 300 680 330 M250 120 C280 250 300 380 330 540 M520 110 C500 230 520 380 470 560" stroke="#8b8a74" stroke-width="3" fill="none" opacity=".7"/>
        <g stroke="rgba(255,255,255,.08)">${grid}</g>
        <path d="M80 520 L690 90" stroke="#ddd" stroke-width="3" stroke-dasharray="14 10" opacity=".6"/>
        ${MAP_ROOMS.map(room).join("")}
        ${MAP_CARS.map(car).join("")}
      </svg>
      <div class="f4-legend">
        <span><svg width="22" height="22" viewBox="-12 -12 24 24">${room([0, 0])}</svg> 비밀의 방</span>
        <span><svg width="34" height="24" viewBox="-17 -12 34 24">${car([0, 0])}</svg> 고정 차량</span>
        <span class="muted">위치는 모두 예시</span>
      </div>
    </div>
    <div class="f4-btns">
      ${["비행기 경로", "마커", "표시 3", "표시 4", "표시 5"].map(x => `<span class="f4-btn old" title="${x}">${x.slice(0, 2)}</span>`).join("")}
      <span class="f4-btn new">고정<br>위치</span>
    </div>
    <div class="panel f4-pop">
      <div class="f4-pop-head"><span class="pill road">추가</span> <strong>고정 위치 표시</strong></div>
      <div class="f4-tog"><span>비밀의 방</span><span class="sw on"><i></i></span></div>
      <div class="f4-tog"><span>고정 차량</span><span class="sw on"><i></i></span></div>
      <p class="muted">기본은 꺼짐 · 필요한 사람만 켬<br>경쟁전 적용 여부는 검토 필요</p>
    </div>
    <div class="scene-note">가상의 섬·예시 위치 (실제 지도·위치 아님) · 회색 = 기존 지도 화면의 탭·버튼 자리, 강조된 버튼과 패널만 새로 추가</div>`;
}

// ── ⑤ 커스터마이즈 › 스킨 검색 (확장 로드맵) ─────────────────────
// 10/21 작성자 결정: 로비에 새 탭을 만들지 않고, 게임에 원래 있는 커스터마이즈 탭에 검색을 더함
// 외부 사이트(pubg.gs)의 스킨 목록은 구조만 참고. 스킨 그림·이름·개수는 쓰지 않고 색 도형과 가상 이름으로
const SKIN_RESULTS = [
  ["스킨 예시 1", "에픽", "#3d6fd6", "#f08a3c", ["파란색", "불꽃 무늬", "AKM"], "보유"],
  ["스킨 예시 2", "레어", "#2c5fb8", "#e8b64a", ["파란색", "불꽃 무늬", "AKM"], "상점"],
  ["스킨 예시 3", "엘리트", "#4b82e6", "#f2643c", ["파란색", "불꽃 무늬"], "판매 종료 · 헌터 상자"],
  ["스킨 예시 4", "레어", "#3557a8", "#9fb7e8", ["파란색", "AKM"], "상점"],
  ["스킨 예시 5", "에픽", "#5a7fd0", "#ff9e5e", ["불꽃 무늬", "AKM"], "제작"],
  ["스킨 예시 6", "일반", "#2f4f8f", "#c9d6f2", ["파란색", "AKM"], "보유"],
];
function frame5() {
  const el = document.getElementById("f5");
  const gun = (a, b) => `<svg viewBox="0 0 120 50" width="120" height="50"><path d="M6 22 h70 l8 -6 h22 v10 h-14 l-4 6 h-20 l-6 14 h-12 l4 -14 h-48 z" fill="${a}"/><path d="M30 22 q10 -10 18 0 q6 -8 12 0" fill="none" stroke="${b}" stroke-width="3"/></svg>`;
  const card = ([name, tier, a, b, why, how], i) => `
    <div class="f6-card${i === 0 ? " on" : ""}">
      <div class="f6-img">${gun(a, b)}<span class="f6-tier">${esc(tier)}</span>${how === "보유" ? '<span class="f6-own">보유 중</span>' : ""}</div>
      <div class="f6-name">${esc(name)}</div>
      <div class="f6-why">${why.map(w => `<span>${esc(w)}</span>`).join("")}</div>
      <div class="muted" style="font-size:12px">얻는 방법: ${esc(how === "보유" ? "보유 중" : how)}</div>
    </div>`;
  el.innerHTML = `${TAG}
    <div class="f6-head"><span class="crumb">커스터마이즈</span> <span class="muted">(기존 메뉴)</span></div>
    <div class="f6-cats">
      ${["의상", "상의", "하의", "마스크", "신발", "모자", "장갑", "안경", "헬멧 스킨", "가방 스킨", "낙하산 스킨", "차량 스킨", "무기 스킨"].map((c, i) =>
        `<div class="${i === 12 ? "on" : ""}">${c}</div>`).join("")}
      <div class="muted" style="font-size:11px;margin-top:6px">종류 목록 (기존)</div>
    </div>
    <div class="f6-main">
      <div class="f6-search">
        <span class="pill road">추가</span>
        <div class="f6-mode"><span>이름</span><span class="on">설명으로 찾기 (AI)</span></div>
        <div class="f6-box">파란 불꽃 무늬 AKM<span class="f6-caret"></span></div>
      </div>
      <div class="f6-filters">
        <span class="seg on">전체 등급</span><span class="seg">보유</span><span class="seg">미보유</span><span class="seg">판매 중</span><span class="seg">판매 종료</span><span class="seg">이벤트</span>
        <span class="muted" style="margin-left:auto;font-size:12px">AI가 설명과 비슷한 스킨 ${SKIN_RESULTS.length}개를 찾았어요 · 태그 = 찾은 이유</span>
      </div>
      <div class="f6-grid">${SKIN_RESULTS.map(card).join("")}</div>
    </div>
    <div class="panel f6-side">
      <div class="f6-preview">캐릭터 미리보기 자리<br><span class="muted">(기존)</span></div>
      <div class="f6-sname">스킨 예시 1 <span class="pill road">에픽</span></div>
      <div class="muted" style="font-size:13px">무기 스킨 · AKM · 보유 중</div>
      <div class="f5-actions" style="margin-top:8px"><span class="btn primary">미리 입어 보기</span></div>
      <p class="muted" style="font-size:12px;margin:4px 0 0">얻는 방법은 카드마다 표시 (상점 · 이벤트 · 제작 · 판매 종료 → 헌터 상자 등)</p>
    </div>
    <div class="scene-note">커스터마이즈(기존)에 검색 칸·필터·찾은 이유만 추가 · 스킨 그림과 이름은 가상의 예시 (실제 아이템 아님)</div>`;
}

// ── 시작 ────────────────────────────────────────────────
async function init() {
  D = await loadData();
  // 카드 규칙 (10/23): 부위로 그리는 피해 종류(settings.csv), 부위 없는 피해의 화면 이름(damage_causes.csv)
  RULES = await loadCardRules();
  const summary = await fetch("../data/my_match_summary.json").then(r => (r.ok ? r.json() : null)).catch(() => null);
  let verify = null;
  try {
    const rows = parseCSV(await fetch("../data/verify_damage_summary.csv").then(r => r.text()));
    const n = rows.reduce((s, r) => s + Number(r.near_n), 0), m = rows.reduce((s, r) => s + Number(r.match), 0);
    if (n) verify = { n, rate: (m / n * 100).toFixed(1) };
  } catch { /* 없으면 문구 생략 */ }

  // ?ex=경기ID(8자리) → ① 카드와 ①-2 매치 리포트를 data/concept_example_경기ID.json 으로 (analyze_my_match.py --match … --out … 로 만든 예시)
  const ex = new URLSearchParams(location.search).get("ex");
  const exSummary = /^[0-9a-f]{8}$/.test(ex ?? "")
    ? await fetch(`../data/concept_example_${ex}.json`).then(r => (r.ok ? r.json() : null)).catch(() => null) : null;
  // ① 기본 예시: 공격하던 적과 나를 쓰러뜨린 적이 다른 장면 (작성자 경기 10/18, analyze_my_match.py --match 452e8a1e 로 만든 파일)
  // 10/22 작성자 결정: ① 카드는 이 한 장(1b)만 남김. 그런 장면이 없는 경기는 공격하던 적이 있는 쓰러짐 → 첫 쓰러짐 순
  const example = exSummary ?? await fetch("../data/concept_example_452e8a1e.json").then(r => (r.ok ? r.json() : null)).catch(() => null);
  frame1(example, "f1b", downs => downs.find(x => x.my_target && !x.my_target.is_killer) ?? downs.find(x => x.my_target) ?? downs[0]);
  frame1c(exSummary ?? summary);   // ①-2 기본: 내 최근 경기 분석 결과
  const classes = await loadClasses();
  frame2(classes);
  frame3(verify, classes);
  frame3b();
  frame4();
  frame5();

  // ?frame=1 → 그 한 장만 1280×720으로 (이미지 저장용)
  const f = new URLSearchParams(location.search).get("frame");
  if (f) {
    document.body.classList.add("single");
    document.querySelectorAll(".frame").forEach(x => { x.style.display = x.id === `f${f}` ? "" : "none"; });
  }
}

init();
