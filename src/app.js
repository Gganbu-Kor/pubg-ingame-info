// 부위별 TTK 계산기 화면 — 계산은 calc.js, 실루엣 그림은 silhouette.js에 맡기고 여기서는 화면만 그린다.
import { loadData, parseCSV, distancesFor, baseAt, zoneResult } from "./calc.js";
import { silhouetteSVG, bindSilhouette } from "./silhouette.js";

// 현재 화면 상태
const state = {
  weapons: [], vests: [], helmets: [], zones: [], classMult: new Map(), falloff: new Map(),
  vestLevel: 0, helmetLevel: 0, distance: 0, zone: null, pickA: null, pickB: null,
  // 샷건 카드의 실루엣 숫자: "pellets" = 쓰러뜨리는 데 필요한 펠릿 수 / "shots" = 펠릿 전부 명중 시 필요 발수
  pelletView: { pickA: "pellets", pickB: "pellets" },
};

// 처음 선택할 부위: 실측에서 몸통 피격이 가장 많이 들어간 곳 (docs/03_검증기록.md 3번 표)
const DEFAULT_ZONE = "Chest";
// 색 단계: 1발 ~ 5발, 6발 이상은 한 단계로 묶음
const MAX_TONE = 6;

// ── 표시용 도우미 ─────────────────────────────────────────

// 데이터 문자열을 HTML에 넣기 전에 특수문자를 바꿔 화면이 깨지지 않게 한다
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtDamage = d => String(Number(d.toFixed(2)));   // 소수 둘째 자리까지
const fmtTtk = t => `${Math.round(t)}ms`;              // 정수 ms
const fmtPct = r => `${Math.round(r * 100)}%`;
const fmtNum = n => String(Number(n.toFixed(3)));     // 배율 표시

const levelName = lv => (lv === 0 ? "없음" : lv === "broken" ? "부서짐" : `${lv}레벨`);
// 버튼 값(문자열) → 레벨: 숫자면 숫자, 아니면 그대로("broken")
const parseLevel = s => (/^\d+$/.test(String(s)) ? Number(s) : s);
const badge = verified => (verified === "Y"
  ? `<span class="badge ok">검증됨</span>`
  : `<span class="badge warn">미검증</span>`);
const tone = shots => `s${Math.min(shots, MAX_TONE)}`;
const isShotgun = w => w.pellets > 1;

const currentArmor = () => ({
  vest: state.vests.find(v => v.level === state.vestLevel),
  helmet: state.helmets.find(h => h.level === state.helmetLevel),
});
const zoneOf = name => state.zones.find(z => z.zone === name);

// 연사 여부로 무기를 세 묶음으로 나눈다 (Y: TTK 표 / N: 피해량 표 / 빈칸: 확인 필요 → 제외)
const autoWeapons = () => state.weapons.filter(w => w.auto_fire === "Y");
const singleWeapons = () => state.weapons.filter(w => w.auto_fire === "N");
const unknownWeapons = () => state.weapons.filter(w => w.auto_fire !== "Y" && w.auto_fire !== "N");
// 고를 수 있는 무기: 연사 여부가 확인되고 거리별 측정값이 있는 무기
const usableWeapons = () => state.weapons.filter(w =>
  (w.auto_fire === "Y" || w.auto_fire === "N") && distancesFor(w, state.falloff).length);
const weaponByName = name => state.weapons.find(w => w.weapon === name);

// 무기 하나의 13개 부위 결과 (현재 방어구·거리 기준). 측정값이 없는 거리면 null
function weaponResults(w) {
  const base = baseAt(w, state.falloff, state.distance);
  if (base === null) return null;
  const armor = currentArmor();
  return new Map(state.zones.map(z => [z.zone, zoneResult(w, z, base, armor, state.classMult)]));
}

// ── 선택 버튼 (조끼·헬멧·거리) ─────────────────────────────

function segmented(id, options, current, onPick) {
  const box = document.getElementById(id);
  box.innerHTML = options.map(o => `
    <button type="button" role="radio" data-value="${o.value}" aria-checked="${o.value === current}">${esc(o.label)}</button>`).join("");
  box.querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => onPick(parseLevel(btn.dataset.value))));
}

function renderControls() {
  segmented("vest-select", state.vests.map(v => ({ value: v.level, label: levelName(v.level) })),
    state.vestLevel, v => { state.vestLevel = v; renderAll(); });
  segmented("helmet-select", state.helmets.map(h => ({ value: h.level, label: levelName(h.level) })),
    state.helmetLevel, v => { state.helmetLevel = v; renderAll(); });
  // 거리 선택지는 왼쪽(A) 무기의 측정 지점
  const dists = distancesFor(weaponByName(state.pickA), state.falloff);
  segmented("distance-select", dists.map(d => ({ value: d, label: `${d}m` })),
    state.distance, v => { state.distance = v; renderAll(); });

  const { vest, helmet } = currentArmor();
  const info = (name, a) => (a.level === 0 ? `${name} 없음`
    : `${name} ${levelName(a.level)} 감소 ${fmtPct(a.damage_reduction)} ${badge(a.verified)}`
      + (a.level === "broken" ? ' <span class="muted">(부서진 조끼를 입고 있을 때 · 실측)</span>' : ""));
  document.getElementById("armor-info").innerHTML =
    `${info("조끼", vest)} · ${info("헬멧", helmet)} · 거리 ${state.distance}m (측정값이 있는 거리만 선택 가능)`;
}

function renderLegend() {
  const items = Array.from({ length: MAX_TONE }, (_, i) => i + 1).map(n =>
    `<span class="legend-item"><span class="chip tone-s${n}"></span>${n === MAX_TONE ? `${n}발 이상` : `${n}발`}</span>`);
  items.push(`<span class="legend-item"><span class="chip tone-none"></span>측정 없음</span>`);
  document.getElementById("legend").innerHTML = `<span class="legend-title">필요 발수</span>${items.join("")}`
    + `<span class="legend-note">샷건을 "필요 펠릿 수"로 보면 숫자는 펠릿 개수이고, 색은 같은 단계(6개 이상은 한 색)를 씁니다.</span>`;
}

// ── 비교 카드 (실루엣) ────────────────────────────────────

function renderCard(el, key) {
  const list = usableWeapons();
  const w = weaponByName(state[key]);
  const results = weaponResults(w);
  const zone = zoneOf(state.zone);

  // 실루엣 칸: 부위마다 필요 발수
  const cells = {};
  if (results) {
    for (const z of state.zones) {
      const r = results.get(z.zone);
      if (!r) continue;
      const n = isShotgun(w) && state.pelletView[key] === "pellets" ? r.pelletsToKill : r.shots;
      cells[z.zone] = {
        text: n, tone: tone(n),
        title: isShotgun(w)
          ? `${z.zone_ko}: 펠릿 1개 ${fmtDamage(r.perPellet)} · 필요 펠릿 ${r.pelletsToKill}개 · 전부 명중 시 ${r.shots}발`
          : `${z.zone_ko}: 1발 ${fmtDamage(r.damage)} · ${r.shots}발${r.ttk === null ? "" : ` · ${fmtTtk(r.ttk)}`}`,
      };
    }
  }

  // 분류별로 묶은 무기 선택 목록
  const classes = [...new Set(list.map(x => x.class))];
  const options = classes.map(c => `<optgroup label="${esc(c)}">${list.filter(x => x.class === c).map(x =>
    `<option ${x.weapon === w.weapon ? "selected" : ""}>${esc(x.weapon)}</option>`).join("")}</optgroup>`).join("");

  const dists = distancesFor(w, state.falloff);
  const r = results?.get(zone.zone);

  el.innerHTML = `
    <select aria-label="무기 선택">${options}</select>
    <div class="spec">${esc(w.class)} · 0m 기본 피해량 <strong>${w.base_damage}</strong>${isShotgun(w) ? ` (펠릿 1개, 한 발에 ${w.pellets}개)` : ""}${w.rpm ? ` · 연사력 ${w.rpm}RPM` : ""} ${badge(w.verified)}</div>
    ${w.note ? `<p class="note">${esc(w.note)}</p>` : ""}
    ${isShotgun(w) ? `
    <div class="pellet-bar">
      <span class="label">실루엣 숫자</span>
      <div class="segmented" role="radiogroup" aria-label="샷건 실루엣 숫자 기준">
        <button type="button" role="radio" data-view="pellets" aria-checked="${state.pelletView[key] === "pellets"}">필요 펠릿 수</button>
        <button type="button" role="radio" data-view="shots" aria-checked="${state.pelletView[key] === "shots"}">전부 명중 시 발수</button>
      </div>
      <p class="hint">샷건은 한 발에 펠릿 ${w.pellets}개가 퍼져 나갑니다. "전부 명중"은 ${w.pellets}개가 모두 같은 부위에 맞았을 때의 최대값입니다.</p>
    </div>` : ""}
    <div class="body-layout">
      ${silhouetteSVG(state.zones, cells, { selected: zone.zone, label: `${w.weapon} 부위별 필요 발수` })}
      <div class="zone-detail" aria-live="polite">
        ${!results ? `<p class="na-box">이 무기는 ${state.distance}m 측정값이 없습니다.<br>측정 거리: ${dists.map(d => `${d}m`).join(" · ")}</p>`
          : !r ? `<p class="na-box">${esc(zone.zone_ko)}: 이 분류의 배율 데이터가 없습니다.</p>`
          : `
          <div class="zone-name">${esc(zone.zone_ko)}</div>
          <dl class="stats stats-col">
            ${isShotgun(w) ? `
            <div><dt>펠릿 1개 피해량</dt><dd>${fmtDamage(r.perPellet)}</dd></div>
            <div><dt>필요 펠릿 수</dt><dd>${r.pelletsToKill}개 <span class="na">/ 한 발 ${r.pellets}개</span></dd></div>
            <div><dt>전부 명중 시 한 발</dt><dd>${fmtDamage(r.damage)}</dd></div>
            <div><dt>전부 명중 시 필요 발수</dt><dd>${r.shots}발</dd></div>` : `
            <div><dt>1발 피해량</dt><dd>${fmtDamage(r.damage)}</dd></div>
            <div><dt>필요 발수</dt><dd>${r.shots}발</dd></div>`}
            <div><dt>TTK</dt><dd>${r.ttk === null ? '<span class="na">연사 모드 없음</span>' : fmtTtk(r.ttk)}</dd></div>
          </dl>
          <p class="formula">
            기본 ${fmtNum(r.parts.base)}<span class="muted">(${state.distance}m${isShotgun(w) ? ", 펠릿 1개" : ""})</span>
            × 부위 ${fmtNum(r.parts.hit_area)} × 분류 ${fmtNum(r.parts.class_mult)}
            × (1 − ${r.parts.piece ? `${zone.armor_slot === "helmet" ? "헬멧" : "조끼"}${r.parts.piece.level === "broken" ? "(부서짐)" : ""} ${fmtPct(r.parts.reduction)}` : "방어구 없음 0%"})
            = <strong>${fmtDamage(r.perPellet)}</strong>${isShotgun(w) ? ` → × ${r.pellets}개 = <strong>${fmtDamage(r.damage)}</strong>` : ""}
          </p>`}
      </div>
    </div>
    ${results ? zoneTable(results, w) : ""}`;

  el.querySelector("select").addEventListener("change", e => {
    state[key] = e.target.value;
    // 왼쪽 무기가 바뀌어 지금 거리에 측정값이 없으면, 그 무기의 측정 거리 중 가장 가까운 곳으로
    if (key === "pickA") {
      const ds = distancesFor(weaponByName(state.pickA), state.falloff);
      if (!ds.includes(state.distance)) state.distance = ds.filter(d => d <= state.distance).pop() ?? ds[0];
    }
    renderAll();
  });
  el.querySelectorAll(".pellet-bar button").forEach(btn => btn.addEventListener("click", () => {
    state.pelletView[key] = btn.dataset.view;
    renderAll();
  }));
  bindSilhouette(el, z => { state.zone = z; renderAll(); });
}

// 13개 부위 전체를 표로 (색을 구분하기 어려운 사람·화면 낭독기용)
function zoneTable(results, w) {
  const sg = isShotgun(w);
  return `
    <details class="zone-table">
      <summary>13개 부위 표로 보기</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>부위</th><th>방어구</th>${sg ? '<th class="num">펠릿 1개</th><th class="num">필요 펠릿</th>' : ""}
          <th class="num">${sg ? "전부 명중 시 한 발" : "1발 피해량"}</th><th class="num">필요 발수</th><th class="num">TTK</th></tr></thead>
        <tbody>${state.zones.map(z => {
          const r = results.get(z.zone);
          const slot = { helmet: "헬멧", vest: "조끼", none: "없음" }[z.armor_slot] ?? z.armor_slot;
          return `<tr${z.zone === state.zone ? ' class="picked"' : ""}><td>${esc(z.zone_ko)}</td><td>${slot}</td>
            ${sg ? `<td class="num">${r ? fmtDamage(r.perPellet) : "–"}</td><td class="num">${r ? `${r.pelletsToKill}개` : "–"}</td>` : ""}
            <td class="num">${r ? fmtDamage(r.damage) : "–"}</td><td class="num">${r ? `${r.shots}발` : "–"}</td>
            <td class="num">${r?.ttk != null ? fmtTtk(r.ttk) : "–"}</td></tr>`;
        }).join("")}</tbody>
      </table></div>
    </details>`;
}

// ── 순위표 (선택한 부위 기준) ──────────────────────────────

const nameCell = w => `${esc(w.weapon)}${w.note ? `<div class="row-note">${esc(w.note)}</div>` : ""}`;
const pickedClass = w => ([state.pickA, state.pickB].includes(w.weapon) ? ' class="picked"' : "");

// 무기 목록 → [{ w, r }] (r이 null이면 이 거리 측정값 없음)
const rankRows = list => list.map(w => ({ w, r: weaponResults(w)?.get(state.zone) ?? null }));

function renderTtkTable() {
  const zone = zoneOf(state.zone);
  document.getElementById("rank-title").innerHTML =
    `TTK 순위 <span class="h2-sub">${esc(zone.zone_ko)} · 조끼 ${levelName(state.vestLevel)} · 헬멧 ${levelName(state.helmetLevel)} · ${state.distance}m · 연사 모드가 있는 무기</span>`;
  const rows = rankRows(autoWeapons().filter(w => distancesFor(w, state.falloff).length));
  const ok = rows.filter(x => x.r).sort((a, b) => a.r.ttk - b.r.ttk || a.r.shots - b.r.shots || a.w.weapon.localeCompare(b.w.weapon, "ko"));
  const none = rows.filter(x => !x.r);
  const maxTtk = Math.max(...ok.map(x => x.r.ttk), 1);

  const table = document.getElementById("ttk-table");
  table.innerHTML = `
    <thead><tr><th>순위</th><th>무기</th><th>분류</th><th class="num">1발 피해량</th>
      <th class="num">필요 발수</th><th class="num">TTK</th><th>검증</th></tr></thead>
    <tbody>${ok.map(({ w, r }, i) => `
      <tr${pickedClass(w)} data-weapon="${esc(w.weapon)}">
        <td class="num">${i + 1}</td>
        <td>${nameCell(w)}</td>
        <td>${esc(w.class)}</td>
        <td class="num">${fmtDamage(r.damage)}</td>
        <td class="num"><span class="chip tone-${tone(r.shots)}"></span> ${r.shots}발</td>
        <td class="num ttk-cell"><span>${fmtTtk(r.ttk)}</span><span class="bar" style="width:${(r.ttk / maxTtk) * 100}%"></span></td>
        <td>${badge(w.verified)}</td>
      </tr>`).join("")}
      ${none.map(({ w }) => `
      <tr class="muted-row" data-weapon="${esc(w.weapon)}">
        <td class="num">–</td><td>${nameCell(w)}</td><td>${esc(w.class)}</td>
        <td colspan="3" class="num">${state.distance}m 측정값 없음 (최대 ${Math.max(...distancesFor(w, state.falloff))}m)</td>
        <td>${badge(w.verified)}</td>
      </tr>`).join("")}
    </tbody>`;
  table.querySelectorAll("tbody tr").forEach(tr => tr.addEventListener("click", () => {
    if (!usableWeapons().some(w => w.weapon === tr.dataset.weapon)) return;
    state.pickA = tr.dataset.weapon;
    const ds = distancesFor(weaponByName(state.pickA), state.falloff);
    if (!ds.includes(state.distance)) state.distance = ds.filter(d => d <= state.distance).pop() ?? ds[0];
    renderAll();
    document.getElementById("card-a").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

function renderDamageTable() {
  const rows = rankRows(singleWeapons()).filter(x => x.r).sort((a, b) => b.r.damage - a.r.damage);
  document.getElementById("damage-section").hidden = !rows.length;
  document.getElementById("damage-table").innerHTML = `
    <thead><tr><th>순위</th><th>무기</th><th>분류</th><th class="num">1발 피해량</th><th class="num">필요 발수</th>
      <th class="num">필요 펠릿 <span class="muted">(샷건)</span></th><th>검증</th></tr></thead>
    <tbody>${rows.map(({ w, r }, i) => `
      <tr${pickedClass(w)}><td class="num">${i + 1}</td><td>${nameCell(w)}</td><td>${esc(w.class)}</td>
        <td class="num">${fmtDamage(r.damage)}${isShotgun(w) ? `<div class="cell-sub">펠릿 ${r.pellets}개 전부 명중</div>` : ""}</td>
        <td class="num">${r.shots}발</td>
        <td class="num">${isShotgun(w) ? `${r.pelletsToKill}개 / ${r.pellets}개` : "–"}</td><td>${badge(w.verified)}</td></tr>`).join("")}
    </tbody>`;
}

function renderExcluded() {
  // 연사 여부 확인 필요 + 거리별 측정값이 없는 무기
  const noData = state.weapons.filter(w => !unknownWeapons().includes(w) && !distancesFor(w, state.falloff).length);
  const items = [
    ...unknownWeapons().map(w => `<li><strong>${esc(w.weapon)}</strong> — 연사 여부 확인 필요${w.note ? ` · ${esc(w.note)}` : ""}</li>`),
    ...noData.map(w => `<li><strong>${esc(w.weapon)}</strong> — 거리별 측정값 없음</li>`),
  ];
  document.getElementById("excluded-section").hidden = !items.length;
  document.getElementById("excluded-list").innerHTML = items.join("");
}

// ── 전체 다시 그리기 ─────────────────────────────────────

function renderAll() {
  const names = usableWeapons().map(w => w.weapon);
  if (!names.includes(state.pickA)) state.pickA = names[0];
  if (!names.includes(state.pickB)) state.pickB = names[1] ?? names[0];

  renderControls();
  renderCard(document.getElementById("card-a"), "pickA");
  renderCard(document.getElementById("card-b"), "pickB");
  renderTtkTable();
  renderDamageTable();
  renderExcluded();
}

// 검증 결과 요약 문구 (data/verify_damage_summary.csv). 파일이 없으면 문구를 바꾸지 않음
async function renderVerifyNote() {
  try {
    const rows = parseCSV(await fetch("../data/verify_damage_summary.csv").then(r => r.text()));
    const n = rows.reduce((s, r) => s + Number(r.near_n), 0);
    const m = rows.reduce((s, r) => s + Number(r.match), 0);
    if (n) document.getElementById("verify-note").textContent =
      `실제 경기 기록(텔레메트리) ${n.toLocaleString()}발 중 ${(m / n * 100).toFixed(1)}%가 이 계산과 일치했습니다.`;
  } catch { /* 요약 파일이 없어도 계산기는 동작 */ }
}

// ── 시작 ────────────────────────────────────────────────

async function init() {
  try {
    const data = await loadData();
    Object.assign(state, data);
    state.vestLevel = state.vests[0].level;
    state.helmetLevel = state.helmets[0].level;
    state.zone = zoneOf(DEFAULT_ZONE) ? DEFAULT_ZONE : state.zones[0].zone;

    // 상단 비공식 문구에 데이터의 패치 버전을 넣는다 (코드에 패치 번호를 적지 않음)
    const patches = [...new Set(state.weapons.map(w => w.patch).filter(Boolean))].join("/");
    document.getElementById("disclaimer").textContent =
      `비공식 개인 프로젝트 · KRAFTON과 무관 · ${patches} 기준 · 반동·명중률·부착물 미반영`;

    // 처음 비교 무기: 무방어·0m·가슴 기준 TTK 1·2위
    const top = rankRows(autoWeapons()).filter(x => x.r).sort((a, b) => a.r.ttk - b.r.ttk);
    state.pickA = top[0]?.w.weapon;
    state.pickB = top[1]?.w.weapon;

    // 주소로 처음 상태 지정 (예: index.html?a=S686&b=AKM&zone=Chest&vest=2&helmet=1&d=50)
    // 다른 화면(내 최근 경기 등)에서 계산기로 연결할 때 사용. 없는 값은 무시
    const q = new URLSearchParams(location.search);
    if (weaponByName(q.get("a"))) state.pickA = q.get("a");
    if (weaponByName(q.get("b"))) state.pickB = q.get("b");
    if (zoneOf(q.get("zone"))) state.zone = q.get("zone");
    if (state.vests.some(v => v.level === parseLevel(q.get("vest")))) state.vestLevel = parseLevel(q.get("vest"));
    if (state.helmets.some(h => h.level === parseLevel(q.get("helmet")))) state.helmetLevel = parseLevel(q.get("helmet"));
    if (q.has("d") && distancesFor(weaponByName(state.pickA), state.falloff).includes(Number(q.get("d")))) state.distance = Number(q.get("d"));

    renderLegend();
    renderAll();
    renderVerifyNote();
  } catch (err) {
    // 대부분 파일을 더블클릭으로 열어서(file://) CSV를 못 읽은 경우
    document.querySelector("main").innerHTML = `
      <div class="error">
        <h2>데이터를 불러오지 못했습니다</h2>
        <p>프로젝트 폴더에서 터미널로 <code>python3 -m http.server --bind 127.0.0.1</code>를 실행한 뒤
        <code>http://127.0.0.1:8000/src/</code> 로 접속해 주세요.</p>
        <p class="detail">${esc(err.message)}</p>
      </div>`;
  }
}

init();
