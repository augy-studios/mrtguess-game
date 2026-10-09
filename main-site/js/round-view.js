// The masked name and the hint rows, drawn the same way for a solo round, a
// party turn and a replay.

import { escapeHtml } from "./ui.js";
import { HINT_LABELS } from "./rules.js";

export { HINT_LABELS };

const isLetter = (ch) => /\p{L}/u.test(ch);
const safeHex = (hex) => (/^#[0-9a-f]{6}$/i.test(hex ?? "") ? hex : "#748477");

// `before` is the mask last drawn for the same name, if any: letters that
// were blank in it pop in.
export function maskMarkup(mask, before = "") {
  const prev = [...before];
  const chars = [...mask];
  const sameRound = prev.length === chars.length;

  const words = [[]];
  chars.forEach((ch, i) => {
    if (ch === " ") words.push([]);
    else words.at(-1).push({ ch, i });
  });

  const html = words
    .map(
      (word) =>
        `<span class="word">${word
          .map(({ ch, i }) => {
            if (ch === "_") return `<span class="tile blank"></span>`;
            if (!isLetter(ch)) return `<span class="sep">${escapeHtml(ch)}</span>`;
            const fresh = sameRound && prev[i] === "_";
            return `<span class="tile${fresh ? " fresh" : ""}">${escapeHtml(ch)}</span>`;
          })
          .join("")}</span>`
    )
    .join("");

  const spoken = words.map((word) => word.map(({ ch }) => (ch === "_" ? "blank" : ch)).join(", ")).join("; next word: ");
  return { html, label: `Station name: ${spoken}` };
}

function hintRow(label, content) {
  return `<div class="hint-row"><dt>${label}</dt><dd>${content}</dd></div>`;
}

const codeChips = (codes) => codes.map((c) => `<span class="chip code">${escapeHtml(c)}</span>`).join("");

// Colours, codes and line names: the rows above the map.
export function hintRows(h) {
  const rows = [
    hintRow(
      "Line colour",
      (h.colors ?? [])
        .map((c) => `<span class="chip"><span class="dot" style="--dot:${safeHex(c.hex)}"></span>${escapeHtml(c.name)}</span>`)
        .join("")
    ),
  ];
  if (h.codes?.length) rows.push(hintRow(h.codes.length > 1 ? "Codes" : "Code", codeChips(h.codes)));
  if (h.line_names?.length) {
    rows.push(hintRow(h.line_names.length > 1 ? "Lines" : "Line", escapeHtml(h.line_names.join(", "))));
  }
  return rows.join("");
}

// Bought after the map, so shown below it.
export function laterHintRows(h) {
  return h.name_zh ? hintRow("Chinese name", `<span class="zh" lang="zh-Hans">${escapeHtml(h.name_zh)}</span>`) : "";
}

export { codeChips };

// The answer's other names, for a result.
export function altNames(a) {
  return [
    a.name_zh ? `<span lang="zh-Hans">${escapeHtml(a.name_zh)}</span>` : "",
    a.name_ta ? `<span lang="ta">${escapeHtml(a.name_ta)}</span>` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// "760 × 1.5 hard × 1.2 for 1 minute × 1.17 speed". Factors of 1 are left out.
export function breakdown(scoring, difficultyLabel) {
  const parts = [String(scoring.base)];
  if (scoring.difficulty !== 1) parts.push(`${scoring.difficulty} ${difficultyLabel.toLowerCase()}`);
  if (scoring.timer !== 1) parts.push(`${scoring.timer} timer`);
  if (scoring.speed !== 1) parts.push(`${scoring.speed} speed`);
  return parts.length > 1 ? `${parts.join(" × ")}` : "";
}

export const stationCount = (n) => (n === 1 ? "1 station" : `${n} stations`);

// m:ss
export function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
