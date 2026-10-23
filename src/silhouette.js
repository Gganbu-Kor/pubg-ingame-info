// 사람 실루엣(SVG) — 13개 부위를 나눠 그리고 부위마다 값(발수 등)을 표시한다.
// 계산기·내 최근 경기·컨셉 화면이 함께 쓴다. 게임 수치는 없고 그림 좌표만 있다.
// 공식 게임 UI·캐릭터 모델을 쓰지 않은 단순 도형 실루엣.

// 부위 이름(hit_zones.csv의 zone) → 도형 목록. 팔·다리는 왼쪽·오른쪽 두 개
// 좌표계: 가로 240 × 세로 440, 가운데 x = 120
// (10/21 사람 윤곽 곡선 버전을 시도했으나 작성자 판단으로 단순 도형 유지)
const SHAPES = {
  "Head":          [{ t: "ellipse", cx: 120, cy: 38, rx: 24, ry: 28 }],
  "Neck":          [{ x: 110, y: 68, w: 20, h: 12, r: 3 }],
  "Clavicle":      [{ x: 80, y: 82, w: 80, h: 16, r: 8 }],
  "Chest":         [{ x: 80, y: 100, w: 80, h: 44, r: 6 }],
  "Upper Stomach": [{ x: 84, y: 146, w: 72, h: 28, r: 5 }],
  "Lower Stomach": [{ x: 86, y: 176, w: 68, h: 24, r: 5 }],
  "Pelvis":        [{ x: 84, y: 202, w: 72, h: 28, r: 8 }],
  "Upper Arm":     [{ x: 52, y: 84, w: 25, h: 70, r: 10 }, { x: 163, y: 84, w: 25, h: 70, r: 10 }],
  "Forearm":       [{ x: 47, y: 156, w: 25, h: 64, r: 10 }, { x: 168, y: 156, w: 25, h: 64, r: 10 }],
  "Hand":          [{ x: 45, y: 222, w: 27, h: 26, r: 9 }, { x: 168, y: 222, w: 27, h: 26, r: 9 }],
  "Thigh":         [{ x: 86, y: 232, w: 33, h: 88, r: 10 }, { x: 121, y: 232, w: 33, h: 88, r: 10 }],
  "Calf":          [{ x: 88, y: 322, w: 29, h: 82, r: 10 }, { x: 123, y: 322, w: 29, h: 82, r: 10 }],
  "Foot":          [{ x: 84, y: 406, w: 33, h: 20, r: 8 }, { x: 123, y: 406, w: 33, h: 20, r: 8 }],
};

// 작은 부위는 글자를 줄인다
const SMALL = new Set(["Neck", "Clavicle", "Hand", "Foot"]);

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 도형 중심 (글자 위치)
const center = s => (s.t === "ellipse" ? [s.cx, s.cy] : [s.x + s.w / 2, s.y + s.h / 2]);

function shapeTag(s) {
  return s.t === "ellipse"
    ? `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}"/>`
    : `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}"/>`;
}

// cells: 부위 이름 → { text: 부위 안에 쓸 짧은 값, tone: 색 단계 이름(CSS 클래스), title: 마우스를 올리면 나올 설명 }
// 값이 없는 부위(cells에 없음)는 회색 + "–"
// selected: 강조할 부위 이름 / emptyText: 값이 없는 부위에 쓸 글자 (기본 "–", 작은 카드에서는 "")
// textOnce: 팔·다리처럼 양쪽이 있는 부위의 숫자를 한쪽에만 (맞은 발수 표시용 — 텔레메트리는 좌우를 구분하지 않아
//           양쪽을 다 칠하는데, 숫자까지 양쪽에 쓰면 발수가 두 배로 보임)
export function silhouetteSVG(zones, cells, { selected = null, label = "부위별 값", emptyText = "–", textOnce = false } = {}) {
  const groups = zones.map(z => {
    const shapes = SHAPES[z.zone] ?? [];
    const c = cells[z.zone];
    const tone = c ? c.tone : "none";
    const text = c ? c.text : emptyText;
    const title = c?.title ?? `${z.zone_ko}: 값 없음`;
    const small = SMALL.has(z.zone) ? " small" : "";
    const labels = (textOnce ? shapes.slice(0, 1) : shapes).map(s => {
      const [x, y] = center(s);
      return `<text x="${x}" y="${y}" class="zone-text${small}">${esc(text)}</text>`;
    }).join("");
    return `
      <g class="zone tone-${tone}${z.zone === selected ? " selected" : ""}" data-zone="${esc(z.zone)}"
         tabindex="0" role="button" aria-label="${esc(title)}" aria-pressed="${z.zone === selected}">
        <title>${esc(title)}</title>
        ${shapes.map(shapeTag).join("")}
        ${labels}
      </g>`;
  }).join("");

  return `<svg class="silhouette" viewBox="0 0 240 440" role="group" aria-label="${esc(label)}">${groups}</svg>`;
}

// 실루엣의 부위를 누르거나 Enter/Space를 누르면 onPick(부위 이름) 호출
export function bindSilhouette(root, onPick) {
  root.querySelectorAll(".zone").forEach(g => {
    g.addEventListener("click", () => onPick(g.dataset.zone));
    g.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(g.dataset.zone); }
    });
  });
}
