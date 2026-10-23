// 계산 전용 모듈 — 화면(app.js)과 나중에 만들 가이드 화면이 함께 사용한다.
// 게임 수치는 여기에 적지 않는다. 모든 수치는 data/ 의 CSV에서 읽는다.

// 계산 기준 체력 (CLAUDE.md 계산식: "체력 100")
export const HP = 100;

// 부동소수점 오차 허용값: 100 ÷ 25 가 4.0000000001 처럼 나와 5발로 잘못 올림되는 것을 막는다
const EPS = 1e-9;

// ── CSV 읽기 ─────────────────────────────────────────────

// CSV 텍스트 → 객체 배열. 엑셀 BOM, 따옴표로 감싼 칸, 윈도우 줄바꿈(CRLF)을 처리한다.
export function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], cell = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }

  const [header, ...body] = rows.filter(r => r.some(c => c.trim() !== ""));
  return body.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

// data/ 폴더의 CSV를 모두 읽어 숫자 칸을 숫자로 바꿔 돌려준다
export async function loadData(base = "../data/") {
  const files = ["weapons", "armor", "hit_zones", "weapon_multipliers", "falloff"];
  const [wText, aText, zText, cText, fText] = await Promise.all(
    files.map(f => fetch(`${base}${f}.csv`).then(r => {
      if (!r.ok) throw new Error(`${f}.csv 를 읽지 못했습니다 (${r.status})`);
      return r.text();
    })));

  const weapons = parseCSV(wText).map(w => ({
    ...w,
    base_damage: Number(w.base_damage),
    rpm: w.rpm === "" ? null : Number(w.rpm), // DMR·SR은 rpm이 비어 있을 수 있음
    pellets: w.pellets ? Number(w.pellets) : 1, // 샷건: 한 발에 나가는 펠릿 수. 다른 무기는 1
  }));

  const armor = parseCSV(aText)
    // level: 0~3 숫자, 또는 "broken"(부서진 조끼 — 몸통 피해 20% 감소, 텔레메트리 실측 10/21)
    .map(a => ({ ...a, level: /^\d+$/.test(a.level) ? Number(a.level) : a.level, damage_reduction: Number(a.damage_reduction) }))
    .sort((a, b) => (typeof a.level === "number" ? a.level : 99) - (typeof b.level === "number" ? b.level : 99));
  const vests = armor.filter(a => a.item === "vest");
  const helmets = armor.filter(a => a.item === "helmet");

  // 13개 부위: 부위 배율(모든 무기 공통)과 덮는 방어구(helmet / vest / none)
  const zones = parseCSV(zText).map(z => ({ ...z, hit_area: Number(z.hit_area) }));

  // 무기별·부위별 분류 배율: "AKM|Chest" → 1
  // 대부분 분류마다 같지만 예외가 있어(Dragunov 머리 2.8) 무기별로 저장되어 있음
  const classMult = new Map(parseCSV(cText).map(r => [`${r.weapon}|${r.zone}`, Number(r.class_mult)]));

  // 무기별 거리별 기본 피해량: 무기 이름 → [{ distance, base }] (가까운 순)
  const falloff = new Map();
  for (const r of parseCSV(fText)) {
    if (r.base_damage === "") continue;
    if (!falloff.has(r.weapon)) falloff.set(r.weapon, []);
    falloff.get(r.weapon).push({ distance: Number(r.distance_m), base: Number(r.base_damage) });
  }
  for (const list of falloff.values()) list.sort((a, b) => a.distance - b.distance);

  return { weapons, vests, helmets, zones, classMult, falloff };
}

// data/classes.csv (총기 분류별 역할 안내)를 읽는다 — 가이드 화면용
export async function loadClasses(base = "../data/") {
  const text = await fetch(base + "classes.csv").then(r => r.text());
  return parseCSV(text);
}

// ── 부위별 계산 (10/20 새 계산식) ─────────────────────────
// 1발 피해량 = 거리별 기본 피해량 × 부위 배율 × 분류 배율 × (1 − 그 부위를 덮는 방어구 감소율)
// 텔레메트리 13경기 2012발 중 99.2% 일치 (docs/03_검증기록.md)

// 이 무기에 측정값이 있는 거리 목록 (그 사이 거리는 추측하지 않으므로 고를 수 없음)
export function distancesFor(weapon, falloff) {
  return (falloff.get(weapon.weapon) ?? []).map(p => p.distance);
}

// 측정한 거리의 기본 피해량. 측정값이 없는 거리면 null
export function baseAt(weapon, falloff, distance) {
  return (falloff.get(weapon.weapon) ?? []).find(p => p.distance === distance)?.base ?? null;
}

// 무기 한 개 × 부위 한 개 → 결과 (계산할 수 없으면 null)
// armor = { vest: 조끼 행, helmet: 헬멧 행 }
// 샷건은 기본 피해량이 펠릿 1개 값 → 한 발 피해량 = 펠릿 1개 × 펠릿 수 ("전부 같은 부위에 맞았을 때" 최대값)
export function zoneResult(weapon, zone, base, armor, classMult) {
  const cm = classMult.get(`${weapon.weapon}|${zone.zone}`);
  if (base === null || cm === undefined) return null;
  const piece = armor[zone.armor_slot] ?? null; // 팔·다리는 방어구 없음
  const reduction = piece ? piece.damage_reduction : 0;
  const perPellet = base * zone.hit_area * cm * (1 - reduction);
  const damage = perPellet * weapon.pellets;
  const shots = shotsToKill(damage);
  return {
    damage, shots, ttk: ttkMs(weapon, shots),
    perPellet, pellets: weapon.pellets,
    pelletsToKill: weapon.pellets > 1 ? shotsToKill(perPellet) : null, // 쓰러뜨리는 데 필요한 펠릿 수 (샷건만)
    parts: { base, hit_area: zone.hit_area, class_mult: cm, reduction, piece },
  };
}

// ── 발수·TTK ─────────────────────────────────────────────

// 필요 발수 n = ceil(체력 ÷ 1발 피해량)
export function shotsToKill(damage) {
  return Math.ceil(HP / damage - EPS);
}

// TTK(ms) = (n − 1) × 60 ÷ rpm × 1000   (첫 발은 0초에 발사)
// 연사 모드가 없는 무기(auto_fire ≠ Y)나 rpm이 없는 무기는 null
export function ttkMs(weapon, shots) {
  if (weapon.auto_fire !== "Y" || !weapon.rpm) return null;
  return ((shots - 1) * 60 / weapon.rpm) * 1000;
}

