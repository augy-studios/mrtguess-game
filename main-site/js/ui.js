import { icon } from "./icons.js";

// Safe to call repeatedly; re-renders when data-icon changes.
export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    const name = el.dataset.icon;
    if (el.dataset.iconRendered === name) return;
    el.innerHTML = icon(name);
    el.dataset.iconRendered = name;
  });
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Which card the page shows: the solo round, a party game, or a replay. The
// others are hidden, and "mrt:view" tells anything that cares, such as the
// solo round's clock, which pauses while it is out of sight.
const VIEWS = ["solo", "party", "replay"];
let view = "solo";

export function showView(name) {
  if (!VIEWS.includes(name)) return;
  for (const id of VIEWS) document.getElementById(id).hidden = id !== name;
  if (view === name) return;
  view = name;
  document.dispatchEvent(new CustomEvent("mrt:view", { detail: name }));
}

export const currentView = () => view;

// Focus goes into the modal on open and back to the opener on close.
const openers = new Map();

export function openModal(id) {
  const backdrop = document.getElementById(id);
  openers.set(id, document.activeElement);
  backdrop.classList.remove("hidden");
  document.body.classList.add("modal-open");
  backdrop.querySelector("button, [href], input")?.focus();
}

export function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
  if (!document.querySelector(".modal-backdrop:not(.hidden)")) {
    document.body.classList.remove("modal-open");
  }
  openers.get(id)?.focus?.();
  openers.delete(id);
}

export function closeTopModal() {
  const open = [...document.querySelectorAll(".modal-backdrop:not(.hidden)")].pop();
  if (!open) return false;
  closeModal(open.id);
  return true;
}
