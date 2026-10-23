// 총기 가이드 화면 — 분류 → 무기 → 상세 3단계. 계산은 calc.js를 그대로 쓴다.
import { loadData, loadClasses } from "./calc.js";

// sort: "difficulty"(난이도순, 기본) 또는 "ammo"(탄 종류별)
const state = { weapons: [], vests: [], classes: [], cls: null, weapon: null, sort: "difficulty" };

// ── 표시용 도우미 (계산기 화면과 같은 규칙) ─────────────────

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const badge = verified => (verified === "Y"
  ? `<span class="badge ok">검증됨</span>`
  : `<span class="badge warn">미검증</span>`);

// 난이도 정렬 순서 (data/README.md에 정한 값: 쉬움 / 보통 / 어려움, 빈칸은 미정)
const DIFF_ORDER = ["쉬움", "보통", "어려움"];
const diffRank = d => (DIFF_ORDER.includes(d) ? DIFF_ORDER.indexOf(d) : DIFF_ORDER.length);
const diffBadge = d => {
  const label = d || "미정";
  const cls = { "쉬움": "easy", "보통": "mid", "어려움": "hard" }[d] ?? "none";
  return `<span class="diff diff-${cls}">${esc(label)}</span>`;
};

// 연사 여부가 비어 있는 무기(O12 등)는 계산기와 마찬가지로 수치를 보여주지 않는다
const isCalculable = w => w.auto_fire === "Y" || w.auto_fire === "N";

const weaponsOf = cls => state.weapons.filter(w => w.class === cls);
const classInfo = cls => state.classes.find(c => c.class === cls);
const selectedWeapon = () => state.weapons.find(x => x.weapon === state.weapon && x.class === state.cls);

// 가이드에서 하나로 묶을 이름 (guide_group이 비어 있으면 무기 이름 그대로)
const entryKey = w => w.guide_group || w.weapon;
// 분류 안의 무기를 묶음 단위로 → [{ key, members }]. members는 CSV 순서이고 첫 번째가 기본 선택
function entriesOf(cls) {
  const map = new Map();
  weaponsOf(cls).forEach(w => {
    const k = entryKey(w);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(w);
  });
  return [...map.entries()].map(([key, members]) => ({ key, members }));
}

// 묶음 안에서 값이 다르면 "121~182ms"처럼 범위로 표시
const rangeText = (vals, fmt, unit) => {
  const lo = Math.min(...vals), hi = Math.max(...vals);
  return lo === hi ? `${fmt(lo)}${unit}` : `${fmt(lo)}~${fmt(hi)}${unit}`;
};

// ── 주소(#) 저장: 브라우저 뒤로 가기가 단계별로 동작하게 ──────

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.cls = p.get("class");
  state.weapon = p.get("weapon");
  state.sort = p.get("sort") === "ammo" ? "ammo" : "difficulty";
}
// 정렬 방식은 따로 바꾸지 않으면 지금 선택을 유지한다
function go(cls, weapon, sort = state.sort) {
  const p = new URLSearchParams();
  if (cls) p.set("class", cls);
  if (weapon) p.set("weapon", weapon);
  if (sort !== "difficulty") p.set("sort", sort);
  location.hash = p.toString();
}

// ── 1단계: 분류 카드 ─────────────────────────────────────

function renderClasses() {
  // classes.csv 순서대로, 그리고 classes.csv에 없는 분류가 무기 데이터에 있으면 뒤에 붙인다
  const codes = [...state.classes.map(c => c.class)];
  state.weapons.forEach(w => { if (!codes.includes(w.class)) codes.push(w.class); });

  const grid = document.getElementById("class-grid");
  grid.innerHTML = codes.map(code => {
    const c = classInfo(code);
    const count = entriesOf(code).length; // MG3처럼 묶인 무기는 1종으로 센다
    return `
      <button type="button" class="class-card" data-class="${esc(code)}"
        aria-pressed="${code === state.cls}">
        <div class="class-top">
          <strong>${esc(c?.name_ko ?? code)}</strong>
          <span class="code">${esc(code)}</span>
        </div>
        ${c ? `
          <div class="range">${esc(c.range)}</div>
          <p class="role">${esc(c.role)}</p>
          <p class="tip">${esc(c.tip)}</p>` : `<p class="role muted">분류 설명 없음</p>`}
        <div class="class-foot">
          ${count ? `무기 ${count}종` : `<span class="muted">무기 데이터 추가 예정</span>`}
          ${c ? `<span class="src">${c.official_desc ? "공식 사이트 소개 문구 기반" : "작성자 정리 (공식 문구 없음)"}</span>` : ""}
        </div>
      </button>`;
  }).join("");

  grid.querySelectorAll(".class-card").forEach(btn =>
    btn.addEventListener("click", () => go(btn.dataset.class, null)));
}

// ── 2단계: 분류 안의 무기 목록 ─────────────────────────────

function renderWeaponList() {
  const section = document.getElementById("weapon-section");
  section.hidden = !state.cls;
  if (!state.cls) return;

  const c = classInfo(state.cls);
  document.getElementById("weapon-heading").textContent = `${c?.name_ko ?? state.cls} 무기 고르기`;

  // 정렬 버튼 상태
  document.querySelectorAll("#sort-select button").forEach(btn => {
    btn.setAttribute("aria-checked", String(btn.dataset.sort === state.sort));
    btn.onclick = () => go(state.cls, state.weapon, btn.dataset.sort);
  });

  // 목록의 한 칸 = 묶음 하나. 이름·난이도·탄은 기본 선택(첫 번째) 무기 기준
  // 발수·TTK 계산은 계산기 화면에서만 한다 (10/21: 가이드는 데이터 값 + 계산기 연결만)
  const list = entriesOf(state.cls)
    .map(({ key, members }) => ({ key, members, w: members[0] }))
    // 쉬운 무기부터 → 같은 난이도면 이름 순
    .sort((a, b) => diffRank(a.w.difficulty) - diffRank(b.w.difficulty) || a.key.localeCompare(b.key, "ko"));

  const box = document.getElementById("weapon-list");
  if (!list.length) {
    box.innerHTML = `<p class="empty-box">이 분류의 무기 데이터는 추가 예정입니다.</p>`;
    return;
  }

  // 무기 버튼 하나 (탄 종류별 보기에서는 묶음 제목에 탄이 있으므로 버튼에서 생략)
  const item = ({ key, members, w }) => {
    // 이미 이 묶음의 무기를 보고 있으면 그 선택을 유지, 아니면 기본 선택으로
    const picked = members.find(m => m.weapon === state.weapon);
    const rpms = members.map(m => m.rpm).filter(Boolean);
    // 항목마다 nowrap 상자로 감싸서 줄 중간에서 끊기지 않게 한다
    const stats = [
      `기본 피해량 ${rangeText(members.map(m => m.base_damage), String, "")}${w.pellets > 1 ? ` × 펠릿 ${w.pellets}` : ""}`,
      rpms.length ? `연사력 ${rangeText(rpms, String, "RPM")}` : "연사 모드 없음",
    ].map(t => `<span class="nw">${t}</span>`).join(" · ");
    return `
    <button type="button" class="weapon-item" data-weapon="${esc((picked ?? w).weapon)}"
      aria-pressed="${Boolean(picked)}">
      <div class="wi-top"><strong>${esc(key)}</strong>${diffBadge(w.difficulty)}</div>
      ${members.length > 1 ? `<div class="wi-variants">${members.map(m => esc(m.variant || m.weapon)).join(" · ")} 선택</div>` : ""}
      ${state.sort === "ammo" ? "" : `<div class="wi-ammo">${esc(w.ammo || "탄 종류 미입력")}</div>`}
      <div class="wi-stats">${stats}</div>
    </button>`;
  };

  if (state.sort === "ammo") {
    // 탄 종류로 묶기 → 무기가 많은 탄부터, 탄 미입력 묶음은 맨 뒤. 묶음 안은 위의 난이도순 유지
    const groups = new Map();
    list.forEach(x => {
      const key = x.w.ammo || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(x);
    });
    const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) =>
      (ka === "") - (kb === "") || b.length - a.length || ka.localeCompare(kb, "ko"));
    box.innerHTML = ordered.map(([ammo, xs]) => `
      <div class="ammo-group">
        <h3>${esc(ammo || "탄 종류 미입력")} <span class="muted">${xs.length}종</span></h3>
        <div class="weapon-list">${xs.map(item).join("")}</div>
      </div>`).join("");
  } else {
    box.innerHTML = `<div class="weapon-list">${list.map(item).join("")}</div>`;
  }

  box.querySelectorAll(".weapon-item").forEach(btn =>
    btn.addEventListener("click", () => go(state.cls, btn.dataset.weapon)));
}

// ── 3단계: 무기 상세 (조끼 단계별 표) ───────────────────────

function renderDetail() {
  const section = document.getElementById("detail-section");
  const w = selectedWeapon();
  section.hidden = !w;
  if (!w) return;

  const c = classInfo(w.class);
  // 같은 묶음(guide_group)의 다른 버전 → 선택 버튼 (예: MG3 660RPM / 990RPM)
  const siblings = w.guide_group ? weaponsOf(w.class).filter(x => x.guide_group === w.guide_group) : [];
  const variantBar = siblings.length > 1 ? `
    <div class="sort-bar variant-bar">
      <span class="label">선택</span>
      <div class="segmented" role="radiogroup" aria-label="버전 선택">
        ${siblings.map(s => `<button type="button" role="radio" data-weapon="${esc(s.weapon)}"
          aria-checked="${s.weapon === w.weapon}">${esc(s.variant || s.weapon)}</button>`).join("")}
      </div>
    </div>` : "";
  const armorRef = state.vests.find(v => v.level > 0); // 조끼 감소율 출처 표시용
  const diffBlock = `
    <div class="diff-block">
      <div><span class="label">사용 난이도</span> ${diffBadge(w.difficulty)}
        <span class="src">${w.difficulty ? esc(w.difficulty_source || "출처 미기재") : "작성자 의견 입력 예정"}</span></div>
      ${w.difficulty_reason ? `<p>${esc(w.difficulty_reason)}</p>` : ""}
    </div>`;

  // 부위별 발수·TTK는 계산기에서 (이 무기를 왼쪽에 고른 상태로 열림)
  const calcHref = `index.html?${new URLSearchParams({ a: w.weapon })}`;
  const table = !isCalculable(w)
    ? `<p class="empty-box">연사 여부가 확인되지 않아 계산기에서 제외된 무기입니다.</p>`
    : `
      <p class="spec">기본 피해량 <strong>${w.base_damage}</strong>${w.pellets > 1 ? ` (펠릿 1개, 한 발에 ${w.pellets}개)` : ""}${w.rpm ? ` · 연사력 ${w.rpm}RPM` : " · 연사 모드 없음"}</p>
      <p><a class="calc-button" href="${calcHref}">${esc(w.weapon)} 부위별 발수·TTK 보기 (계산기) →</a></p>
      <p class="hint">머리·가슴·팔·다리 등 13개 부위와 상대 조끼·헬멧·거리에 따라 발수가 달라집니다.</p>`;

  document.getElementById("detail").innerHTML = `
    <div class="detail-head">
      <h3>${esc(entryKey(w))}</h3>
      <span class="muted">${esc(c?.name_ko ?? w.class)}${c ? ` · ${esc(c.range)}` : ""}</span>
    </div>
    ${variantBar}
    ${w.note ? `<p class="note">${esc(w.note)}</p>` : ""}
    <p class="ammo-line"><span class="label">사용 탄</span> ${esc(w.ammo || "미입력")}
      ${w.ammo_source ? `<span class="src">${esc(w.ammo_source)}</span>` : ""}</p>
    ${diffBlock}
    <h4>얼마나 강한가</h4>
    ${table}
    <p class="source">
      무기 수치: ${esc(w.source)} · ${esc(w.patch)} 기준 ${badge(w.verified)}<br>
      ${armorRef ? `조끼 감소율: ${esc(armorRef.source)} ${badge(armorRef.verified)}` : ""}
    </p>
`;

  document.querySelectorAll("#detail .variant-bar button").forEach(btn =>
    btn.addEventListener("click", () => go(state.cls, btn.dataset.weapon)));
}

// ── 전체 다시 그리기 ─────────────────────────────────────

function renderAll() {
  readHash();
  renderClasses();
  renderWeaponList();
  renderDetail();
}

async function init() {
  try {
    const [data, classes] = await Promise.all([loadData(), loadClasses()]);
    state.weapons = data.weapons;
    state.vests = data.vests;
    state.classes = classes;

    // 상단 비공식 문구에 데이터의 패치 버전을 넣는다
    const patches = [...new Set(state.weapons.map(w => w.patch).filter(Boolean))].join("/");
    document.getElementById("disclaimer").textContent =
      `비공식 개인 프로젝트 · KRAFTON과 무관 · ${patches} 기준 · 반동·명중률·부착물 미반영`;

    renderAll();

    // 분류·무기를 새로 고르면 해당 단계로 화면을 내려준다
    // (정렬이나 MG3 속도처럼 같은 무기 안에서만 바꿨을 때는 그대로)
    const position = () => {
      const w = selectedWeapon();
      return `${state.cls}|${w ? entryKey(w) : ""}`;
    };
    window.addEventListener("hashchange", () => {
      const before = position();
      renderAll();
      if (position() === before) return;
      const target = state.weapon ? "detail-section" : state.cls ? "weapon-section" : null;
      if (target) document.getElementById(target).scrollIntoView({ behavior: "smooth", block: "start" });
    });
  } catch (err) {
    document.querySelector("main").innerHTML = `
      <div class="error">
        <h2>데이터를 불러오지 못했습니다</h2>
        <p>프로젝트 폴더에서 터미널로 <code>python3 -m http.server --bind 127.0.0.1</code>를 실행한 뒤
        <code>http://localhost:8000/src/guide.html</code> 로 접속해 주세요.</p>
        <p class="detail">${esc(err.message)}</p>
      </div>`;
  }
}

init();
