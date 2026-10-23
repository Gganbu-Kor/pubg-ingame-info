// "내 최근 경기" 화면 — scripts/analyze_my_match.py 가 만든 data/my_match_summary.json 을 보여준다.
// 맞은 곳은 계산기와 같은 실루엣으로, 발마다 추정 부위·계산값·그 순간 내 방어구를 함께 보여주고
// 같은 조건으로 계산기를 열 수 있게 연결한다.
import { loadData, distancesFor, baseAt, zoneResult } from "./calc.js";
import { silhouetteSVG } from "./silhouette.js";
import { targetTip, partsWithDamage, partLabel, isShotgunTarget, loadCardRules, isZoneHit, causeName, otherDamage } from "./target_tip.js";

// ── 표시용 도우미 (계산기 화면과 같은 규칙) ──────────────
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const round2 = n => String(Number(Number(n).toFixed(2)));
const levelName = lv => (lv === 0 ? "없음" : lv === "broken" ? "부서짐" : `${lv}레벨`);
const armorText = s => `조끼 ${levelName(s.my_vest)} · 헬멧 ${levelName(s.my_helmet)}`;

// "ACE32에 몸통 4발, 팔 1발" 형태의 문장 조각 (부위가 남는 공격)
// 세부 부위를 모르는 발은 실루엣·표와 같은 이름으로 따로 셈 (예: "머리 1발, 머리·목 1발", 10/23 작성자 지적)
const weaponPhrase = (w, d, zones) => {
  const counts = new Map();
  d.shots.filter(s => s.weapon_id === w.weapon_id).forEach(s => {
    const k = s.zones?.length ? s.part : partLabel(s, zones);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  });
  return `<strong>${esc(w.weapon)}</strong>에 ${[...counts].map(([p, n]) => `${esc(p)} ${n}발`).join(", ")}`;
};

// 쓰러짐 한 문장 (10/23): 부위가 남는 공격은 "AKM에 가슴 2발을 맞고", 수류탄 등은 원인별 합계로 "수류탄에 45 피해를 입고"
// 같은 원인(예: 화염병 불길이 여러 내부 이름으로 기록됨)은 화면 이름 기준으로 합침. 숫자 뒤에 "피해"를 붙여 조사가 숫자에 따라 틀리지 않게
function downSentence(d, rules, zones) {
  const isZoneWeapon = w => { const s = d.shots.find(x => x.weapon_id === w.weapon_id); return !s || isZoneHit(s, rules); };
  const gun = d.by_weapon.filter(isZoneWeapon).map(w => weaponPhrase(w, d, zones));
  const other = otherDamage(d.shots, rules).map(([n, v]) => `<strong>${esc(n)}</strong>에 ${round2(v)}`);
  const parts = [gun.length ? `${gun.join(", ")}을 맞고` : "", other.length ? `${other.join(", ")} 피해를 입고` : ""].filter(Boolean);
  return `${parts.join(", ")} <strong>${esc(d.type)}</strong>했습니다`;
}

// 발별 표의 세부 부위 줄: "쇄골 또는 윗배", 세부 부위를 모르면 묶음 전체 ("머리 또는 목") — 목록·실루엣과 같은 규칙
const detail = (s, zones) => {
  const label = partLabel(s, zones);
  return label !== s.part ? `<div class="cell-sub">${esc(label.split("·").join(" 또는 "))}</div>` : "";
};

// 추정 방법 → 화면 설명
const METHOD = {
  "정확": "계산값과 일치",
  "범위": "거리 감쇠 구간 · 측정 지점 사이 범위 안",
  "잘림": "남은 체력만큼만 들어간 발이라 부위 추정 불가",
  "불일치": "어느 부위 계산값과도 맞지 않음",
  "자료 없음": "계산 자료 없음",
  "측정 범위 밖": "측정 거리 밖",
};

// ── 경기 정보 ───────────────────────────────────────────

function renderMatchInfo(s) {
  const win = s.result?.win_place;
  const result = win === 1
    ? `<span class="result-badge chicken">치킨!</span>`
    : win ? `<span class="result-badge">최종 ${win}위</span>` : "";
  document.getElementById("match-info").innerHTML = `
    <div class="card match-card">
      <div class="match-top">
        <strong>${esc(s.name)}</strong>
        ${result}
      </div>
      <div class="muted">${esc(s.match.created_kst)} · ${esc(s.match.map)} · ${esc(s.match.mode)}</div>
      ${s.match.match_type && s.match.match_type !== "official"
        ? `<p class="note">일반 경기가 아닌 모드(${esc(s.match.match_type)})입니다. 무기·피해 규칙이 달라 계산 비교가 맞지 않을 수 있습니다.</p>` : ""}
    </div>`;
}

// ── 맞은 곳 실루엣 ──────────────────────────────────────

// 진한 색 = 그 부위로 확정된 발 / 연한 색 = 값이 같은 두 부위 중 한 곳(예: 쇄골·윗배)
// shots: 내가 맞은 발 또는 내가 맞힌 발 (같은 형식) / label: 실루엣 설명
function hitSilhouette(shots, zones, label = "내가 맞은 부위", numbers = true) {
  const sure = {}, maybe = {};
  for (const s of shots) {
    const keys = s.zone_keys ?? [];
    if (keys.length === 1) sure[keys[0]] = (sure[keys[0]] ?? 0) + 1;
    else for (const k of keys) (maybe[k] ??= []).push(s.zones.join("·"));
  }
  const ko = Object.fromEntries(zones.map(z => [z.zone, z.zone_ko]));
  const cells = {};
  for (const z of zones) {
    if (sure[z.zone]) cells[z.zone] = { text: numbers ? sure[z.zone] : "", tone: "s2", title: `${ko[z.zone]} 맞음` };
    else if (maybe[z.zone]) cells[z.zone] = { text: "?", tone: "s5", title: `${maybe[z.zone][0]} 중 한 곳: ${maybe[z.zone].length}발` };
  }
  // 부위를 특정하지 못한 발 (잘림 등)
  const unknown = shots.filter(s => !(s.zone_keys ?? []).length);
  return `
    <div class="hit-body">
      ${silhouetteSVG(zones, cells, { label, textOnce: true })}
      <div class="hit-legend">
        <div><span class="chip tone-s2"></span> 맞은 부위 (숫자 = 발수)</div>
        <div><span class="chip tone-s5"></span> 피해량이 같은 두 부위 중 한 곳</div>
        ${unknown.length ? `<p class="hint">부위를 특정하지 못한 발: ${unknown.map(s =>
          `${esc(partLabel(s, zones))} ${round2(s.damage)} (${esc(METHOD[s.zone_method] ?? s.zone_method)})`).join(", ")}</p>` : ""}
      </div>
    </div>`;
}

// ── 계산기 연결 ─────────────────────────────────────────

// 무기마다: 첫 발 때 내 방어구·거리로 계산기 열기 + 가장 많이 맞은 부위의 계산 결과 한 줄
function calcLinks(d, data) {
  const byWeapon = new Map();
  for (const s of d.shots) {
    if (s.category !== "Damage_Gun" || !s.calc_weapon) continue;
    if (!byWeapon.has(s.calc_weapon)) byWeapon.set(s.calc_weapon, []);
    byWeapon.get(s.calc_weapon).push(s);
  }
  return [...byWeapon.entries()].map(([name, shots]) => {
    const w = data.weapons.find(x => x.weapon === name);
    const first = shots[0];
    // 가장 많이 맞은 (확정된) 부위, 없으면 가슴
    const count = {};
    shots.forEach(s => s.zone_keys?.length === 1 && (count[s.zone_keys[0]] = (count[s.zone_keys[0]] ?? 0) + 1));
    const zoneKey = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Chest";
    // 첫 발 거리 이하에서 가장 가까운 측정 지점 (지점 사이 값은 추측하지 않음)
    const dists = distancesFor(w, data.falloff);
    const dist = dists.filter(x => x <= (first.distance_m ?? 0)).pop() ?? dists[0];
    const zone = data.zones.find(z => z.zone === zoneKey);
    const armor = {
      vest: data.vests.find(v => v.level === first.my_vest),
      helmet: data.helmets.find(h => h.level === first.my_helmet),
    };
    const r = zoneResult(w, zone, baseAt(w, data.falloff, dist), armor, data.classMult);
    const href = `index.html?${new URLSearchParams({ a: name, zone: zoneKey, vest: first.my_vest, helmet: first.my_helmet, d: dist })}`;
    return `
      <div class="calc-link">
        <div class="calc-title"><strong>${esc(name)}</strong> · 첫 발 때 내 ${esc(armorText(first))} · 거리 ${first.distance_m}m</div>
        ${r ? `<p class="calc-line">계산상 <strong>${esc(zone.zone_ko)}</strong>만 맞으면 <strong>${r.shots}발</strong>${r.ttk === null ? "" : ` · ${Math.round(r.ttk)}ms`}
          <span class="muted">(체력 100, ${dist}m 측정값 기준)</span></p>` : ""}
        <a class="calc-button" href="${href}">같은 조건으로 계산기에서 보기 →</a>
      </div>`;
  }).join("");
}

// ── 쓰러짐 카드 ─────────────────────────────────────────

function renderDown(d, data, rules) {
  const sentence = downSentence(d, rules, data.zones);
  // 부위가 남는 공격만 실루엣으로, 그 밖(수류탄 등)은 문장과 아래 한 줄에 원인별 피해 합계로 (10/23)
  const zoneShots = d.shots.filter(s => isZoneHit(s, rules));
  const mineOther = otherDamage(d.shots, rules);
  // 계산기 비교 안내는 부위가 남는 공격이 있을 때만
  const lowStart = d.start_health < 100 && zoneShots.length
    ? `<p class="hint">교전 시작 체력이 100이 아니어서, 계산기의 몇 발 컷보다 적게 맞고 쓰러질 수 있습니다.</p>` : "";
  // 이 교전 중 내 조끼가 부서졌는지
  const broke = d.shots.find(s => s.my_vest === "broken");
  const brokenVest = data.vests.find(v => v.level === "broken");
  const brokeNote = broke && brokenVest
    ? `<p class="note">이 교전 중 내 조끼가 부서졌습니다. 부서진 조끼도 몸통 피해를 ${Math.round(brokenVest.damage_reduction * 100)}% 줄여 줍니다.</p>` : "";

  // 발별 타임라인
  const timeline = d.shots.map(s => {
    const z = isZoneHit(s, rules);
    const exp = Array.isArray(s.expected) ? `${round2(s.expected[0])}~${round2(s.expected[1])}` : s.expected != null ? round2(s.expected) : "–";
    const ok = s.zone_method === "정확" || s.zone_method === "범위";
    return `
    <tr>
      <td class="num">+${(s.t_ms / 1000).toFixed(2)}초</td>
      <td>${esc(s.attacker)}</td>
      <td>${esc(causeName(s, rules))}</td>
      <td>${z ? `${esc(s.part)}${detail(s, data.zones)}` : '<span class="muted">부위 없음</span>'}</td>
      <td class="num">${round2(s.damage)}${s.clipped ? '<div class="cell-sub warn-text">남은 체력만큼</div>' : ""}</td>
      <td class="num">${z ? exp : "–"}<div class="cell-sub ${ok ? "ok-text" : ""}">${z ? esc(METHOD[s.zone_method] ?? s.zone_method ?? "") : ""}</div></td>
      <td>${esc(levelName(s.my_vest))}${s.my_vest === "broken" ? "" : ""}<div class="cell-sub">헬멧 ${esc(levelName(s.my_helmet))}</div></td>
      <td><div class="hp-cell">
        <span class="hp-bar"><span style="width:${Math.max(0, Math.min(100, s.health_before))}%"></span></span>
        <span class="num">${round2(s.health_before)}</span>
      </div></td>
    </tr>`;
  }).join("");

  const links = calcLinks(d, data);

  return `
    <article class="card down-card">
      <div class="down-head">
        <span class="down-type ${d.type === "사망" ? "dead" : "knock"}">${esc(d.type)}</span>
        <span class="muted">${esc(d.time_kst)}</span>
      </div>
      <p class="down-sentence">${sentence}</p>
      <p class="muted down-meta">교전 시작 체력 ${round2(d.start_health)} · ${zoneShots.length === d.shots.length ? "첫 발부터" : "처음 맞은 때부터"} ${(d.duration_ms / 1000).toFixed(2)}초 · 상대 ${d.attackers}명</p>
      ${lowStart}${brokeNote}
      ${zoneShots.length ? hitSilhouette(zoneShots, data.zones) : ""}
      ${zoneShots.length && mineOther.length ? `<p class="hint">실루엣에 없는 피해 (부위가 남지 않음): ${mineOther.map(([n, v]) => `${esc(n)} ${round2(v)}`).join(" · ")}</p>` : ""}
      <h4>맞은 순서</h4>
      <div class="table-wrap"><table>
        <thead><tr><th class="num">시간</th><th>상대</th><th>무기</th><th>부위 <span class="muted">(추정 세부 부위)</span></th>
          <th class="num">피해량</th><th class="num">계산값</th><th>내 조끼</th><th>맞기 전 내 체력</th></tr></thead>
        <tbody>${timeline}</tbody>
      </table></div>
      ${links ? `<h4>계산기와 연결</h4>${links}` : ""}
      ${targetBlock(d, data, rules)}
    </article>`;
}

// ── 내가 마지막으로 공격하던 적 (작성자 결정 10/21, 10/23 수류탄 등 포함) ──────────
// 나를 쓰러뜨린 상대와 다를 수 있음. 쓰러지기 전에 내가 적에게 피해를 준 적이 없으면 표시하지 않음
// 같은 교전에서 피해를 준 다른 적은 한 줄로 함께 보여 줌 (10/23)
function targetBlock(d, data, rules) {
  const t = d.my_target;
  if (!t) return "";
  const others = d.my_other_targets ?? [];
  const tZone = t.hits.filter(h => isZoneHit(h, rules));
  const tOther = otherDamage(t.hits, rules);
  const why = targetTip(t, data);
  const sg = isShotgunTarget(t, data);   // 샷건은 숫자 없이 맞힌 부위만
  const parts = [...partsWithDamage(tZone, data.zones).map(([p, n, dmg]) => (sg ? esc(p) : `${esc(p)} ${n}발 · ${round2(dmg)}`)),
    ...tOther.map(([n, v]) => `${esc(n)} · ${round2(v)}`)].join(" / ");
  const rows = sg ? "" : t.hits.map(h => `
    <tr>
      <td class="num">${h.t_ms < 0 ? `맞기 ${(-h.t_ms / 1000).toFixed(2)}초 전` : `+${(h.t_ms / 1000).toFixed(2)}초`}</td>
      <td>${esc(causeName(h, rules))}</td>
      <td>${isZoneHit(h, rules) ? `${esc(h.part)}${detail(h, data.zones)}` : '<span class="muted">부위 없음</span>'}</td>
      <td class="num">${round2(h.damage)}</td>
      <td>${esc(levelName(h.target_vest))}<div class="cell-sub">헬멧 ${esc(levelName(h.target_helmet))}</div></td>
    </tr>`).join("");
  const total = tOther.length ? `합계 <strong>${round2(t.total_damage)}</strong> 피해`
    : sg ? "샷건 · 맞힌 부위만 표시" : `총 <strong>${tZone.length}발 · ${round2(t.total_damage)}</strong> 피해`;
  const otherTargets = others.length
    ? `<p class="muted down-meta">같은 교전에서 피해를 준 다른 적: ${others.map(o =>
      `${esc(o.label)} ${round2(o.total_damage)} (${[...new Set(o.hits.map(h => causeName(h, rules)))].map(esc).join("·")})`).join(" · ")}</p>` : "";
  return `
    <h4>내가 마지막으로 공격하던 적 — ${esc(t.label)}${t.is_killer ? " (나를 쓰러뜨린 상대)" : " (나를 쓰러뜨린 상대와 다름)"}</h4>
    <p class="down-sentence" style="font-size:16px">${total}${t.knocked_by_me ? " · <strong>기절시킴</strong>" : ""}${t.healed_reset ? ' <span class="muted">(상대가 회복해서, 회복 이후 맞힌 발만 셈)</span>' : ""}</p>
    <p class="muted down-meta">${parts}</p>
    ${otherTargets}
    ${why ? `<p class="note">${esc(why)}</p>` : ""}
    ${tZone.length ? hitSilhouette(tZone, data.zones, `${t.label}에게 맞힌 부위`, !sg) : ""}
    ${sg ? "" : `<div class="table-wrap"><table>
      <thead><tr><th class="num">시간</th><th>무기</th><th>부위 <span class="muted">(추정)</span></th><th class="num">피해량</th><th>상대 방어구</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`}`;
}


function renderDowns(s, data, rules) {
  const box = document.getElementById("downs");
  if (!s.downs.length) {
    box.innerHTML = `<p class="empty-box">${s.result?.win_place === 1 ? "치킨! " : ""}이 경기에서는 다른 플레이어에게 쓰러지지 않았습니다.</p>`;
    return;
  }
  box.innerHTML = `<h2>나를 쓰러뜨린 공격 <span class="h2-sub">${s.downs.length}회</span></h2>`
    + s.downs.map(d => renderDown(d, data, rules)).join("");
}

// ── 시작 ────────────────────────────────────────────────

async function init() {
  try {
    const res = await fetch("../data/my_match_summary.json");
    if (!res.ok) throw new Error("NO_SUMMARY");
    const summary = await res.json();
    if (summary.downs.some(d => d.shots.some(s => !("zone_method" in s)))) throw new Error("OLD_SUMMARY");
    const [data, rules] = await Promise.all([loadData(), loadCardRules()]);

    renderMatchInfo(summary);
    renderDowns(summary, data, rules);
    // 안내 문구의 기준값: 교전 간격은 이 요약을 만들 때 쓴 값, 회복 기준은 data/settings.csv
    document.querySelectorAll(".gap-sec").forEach(x => (x.textContent = summary.settings.engagement_gap_sec));
    document.querySelectorAll(".reset-hp").forEach(x => (x.textContent = rules.settings.target_reset_heal_hp));
  } catch (err) {
    const rerun = `<p><code>.venv/bin/python scripts/analyze_my_match.py</code></p>`;
    document.querySelector("main").innerHTML = `
      <div class="error">
        <h2>경기 요약을 불러오지 못했습니다</h2>
        ${err.message === "NO_SUMMARY"
          ? `<p>아직 분석한 경기가 없습니다. 프로젝트 폴더의 터미널에서 아래 두 명령을 차례로 실행한 뒤 새로고침하세요.</p>
             <p><code>.venv/bin/python scripts/fetch_my_match.py 닉네임</code></p>${rerun}`
          : err.message === "OLD_SUMMARY"
          ? `<p>예전 형식의 경기 요약입니다. 터미널에서 아래 명령으로 다시 분석한 뒤 새로고침하세요.</p>${rerun}`
          : `<p>프로젝트 폴더에서 터미널로 <code>python3 -m http.server --bind 127.0.0.1</code>를 실행한 뒤
             <code>http://127.0.0.1:8000/src/match.html</code> 로 접속해 주세요.</p>`}
        <p class="detail">${esc(err.message)}</p>
      </div>`;
  }
}

init();
