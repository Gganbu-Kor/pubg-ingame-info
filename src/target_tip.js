// "내가 마지막으로 공격하던 적" 표시 도우미 — 내 경기 화면과 컨셉 화면이 함께 쓴다.
// 10/23 작성자 결정: 총뿐 아니라 수류탄·화염병 등도 넣는다. 부위가 남는 공격(settings.csv의 card_damage_categories)만
// 실루엣·발수로 그리고, 그 밖의 피해는 원인별 피해 합계로만 (이름은 damage_causes.csv).
// 작성자 결정 10/21: 목적은 "N발 맞혔는데 왜 안 죽었지?" → 어느 부위에 몇 발, 얼마나 들어갔나.
// 회복·다른 사람의 피해·남은 체력은 계산하지 않는다 (오히려 파악하기 어려움).
// 샷건은 펠릿이 따로 기록되어 숫자가 오해를 낳으므로 맞힌 부위만 보여준다.

import { parseCSV } from "./calc.js";

const r0 = n => Math.round(Number(n));

// 화면 규칙 읽기: 부위로 그리는 피해 종류와, 부위 없는 피해의 화면 이름 (모두 data/ 파일에서)
export async function loadCardRules(base = "../data/") {
  const [settingsText, causesText] = await Promise.all(
    ["settings.csv", "damage_causes.csv"].map(f => fetch(base + f).then(r => r.text())));
  const settings = Object.fromEntries(parseCSV(settingsText).map(r => [r.key, r.value]));
  return {
    cats: new Set((settings.card_damage_categories ?? "").split(";").map(x => x.trim()).filter(Boolean)),
    causeKo: new Map(parseCSV(causesText).map(r => [r.category, r.name_ko])),
    settings,   // 안내 문구에 기준값(교전 간격·회복 기준)을 채울 때 씀
  };
}

// 부위가 남는 공격인지 (예전 요약 파일은 총기 피격만 있어 category가 없음 → 총으로 봄)
export const isZoneHit = (h, rules) => rules.cats.has(h.category ?? "Damage_Gun");

// 화면에 쓸 원인 이름: 부위가 남는 공격은 무기 이름, 그 밖은 damage_causes.csv의 이름 (없으면 기록된 이름 그대로)
export const causeName = (h, rules) => (isZoneHit(h, rules) ? h.weapon : rules.causeKo.get(h.category) ?? h.weapon);

// 부위 없는 피해를 원인별로 합침: [["수류탄", 60], ["화염병", 12]] (피해 큰 순)
export function otherDamage(hits, rules) {
  const m = new Map();
  for (const h of hits) {
    if (isZoneHit(h, rules)) continue;
    const k = causeName(h, rules);
    m.set(k, (m.get(k) ?? 0) + h.damage);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
const lvName = lv => (lv === 0 ? "없음" : lv === "broken" ? "부서짐" : `${lv}레벨`);

// 내가 공격하던 적에게 쓴 무기가 샷건인지
export const isShotgunTarget = (t, data) =>
  (data.weapons.find(w => w.weapon === t.calc_weapon)?.pellets ?? 1) > 1;

// 부위별 [부위 이름, 발수, 피해 합] (추정 부위가 없으면 기록된 부위로), 발수 많은 순
// 목록에 쓰는 부위 이름 (10/23 작성자 지적: 실루엣과 목록을 맞춤)
// 세부 부위를 알면 그 이름. 모르면(남은 체력만큼만 들어간 발 등) 기록된 부위 이름을 쓰되,
// 그 이름이 세부 부위 하나와 같아 헷갈리면 묶음 전체를 적는다 — 예: HeadShot은 "머리"로 기록되지만 머리·목 중 한 곳
// zones: data/hit_zones.csv (세부 부위 ↔ 기록된 부위 묶음)
export function partLabel(h, zones = []) {
  if (h.zones?.length) return h.zones.join("·");
  const group = zones.filter(z => z.damage_reason === h.reason);
  return group.length > 1 && group.some(z => z.zone_ko === h.part) ? group.map(z => z.zone_ko).join("·") : h.part;
}

export function partsWithDamage(hits, zones = []) {
  const m = new Map();
  for (const h of hits) {
    const k = partLabel(h, zones);
    const v = m.get(k) ?? [k, 0, 0];
    v[1] += 1; v[2] += h.damage;
    m.set(k, v);
  }
  return [...m.values()].sort((a, b) => b[1] - a[1] || b[2] - a[2]);
}

// TIP 한 줄: 상대 방어구가 내 피해를 얼마나 줄였나 (그때 상대가 입고 있던 레벨, data/armor.csv 감소율)
// 몸통(조끼)을 맞힌 발이 있으면 조끼, 머리(헬멧)를 맞힌 발이 있으면 헬멧 — 해당 없으면 빈 문자열
export function targetTip(t, data) {
  if (!t) return "";
  const slotOf = h => data.zones.find(z => z.damage_reason === h.reason)?.armor_slot;
  const hitVest = t.hits.some(h => slotOf(h) === "vest");
  const hitHead = t.hits.some(h => slotOf(h) === "helmet");
  const vest = data.vests.find(v => v.level === t.vest);
  const helmet = data.helmets.find(h => h.level === t.helmet);
  const parts = [];
  if (hitVest && vest && vest.damage_reduction > 0) parts.push(`조끼 ${lvName(t.vest)} — 몸통 피해가 ${r0(vest.damage_reduction * 100)}% 줄었어요`);
  if (hitHead && helmet && helmet.damage_reduction > 0) parts.push(`헬멧 ${lvName(t.helmet)} — 머리 피해가 ${r0(helmet.damage_reduction * 100)}% 줄었어요`);
  return parts.length ? `${t.label} ${parts.join(" · ")}` : "";
}
