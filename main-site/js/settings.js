// Player settings, the same ones the Telegram bot's /settings holds, kept in
// this browser. The bot's "remove old round cards" has no page to tidy here.

import { api } from "./api.js";
import { openModal } from "./ui.js";

const STORAGE = "mrtguessr.settings";
// Where the name lived before there were settings.
const OLD_NAME = "mrtguessr.name";

const DEFAULTS = { name: null, auto_submit: false, confirm_hints: false, map_style: "page" };
const MAP_STYLES = ["page", "light", "dark"];

let current = null;

function load() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE) ?? "{}") ?? {};
    if (!saved.name && localStorage.getItem(OLD_NAME)) saved.name = localStorage.getItem(OLD_NAME);
  } catch {
    // Unreadable or blocked storage: the defaults.
  }
  const out = { ...DEFAULTS };
  if (typeof saved.name === "string" && saved.name.trim()) out.name = saved.name.trim();
  out.auto_submit = saved.auto_submit === true;
  out.confirm_hints = saved.confirm_hints === true;
  if (MAP_STYLES.includes(saved.map_style)) out.map_style = saved.map_style;
  // Adding rounds automatically needs a name to add them under.
  if (!out.name) out.auto_submit = false;
  return out;
}

export function getSettings() {
  current ??= load();
  return { ...current };
}

export function saveSettings(changes) {
  current = { ...getSettings(), ...changes };
  if (!current.name) current.auto_submit = false;
  try {
    localStorage.setItem(STORAGE, JSON.stringify(current));
    localStorage.removeItem(OLD_NAME);
  } catch {
    // Kept for this page view only.
  }
  applyMapStyle();
  render();
  return getSettings();
}

// "page" follows light or dark mode; the others pin the map to one.
export function applyMapStyle() {
  const map = document.getElementById("map");
  const style = getSettings().map_style;
  if (style === "page") delete map.dataset.mapStyle;
  else map.dataset.mapStyle = style;
}

const $ = (id) => document.getElementById(id);

function render() {
  const s = getSettings();
  $("clearNameBtn").classList.toggle("hidden", !s.name);
  $("savedName").textContent = `Now: ${s.name ?? "Not set"}`;

  document.querySelectorAll("#settingsModal [data-setting]").forEach((el) => {
    const on = s[el.dataset.setting];
    el.setAttribute("aria-checked", String(on));
    el.querySelector(".switch-state").textContent = on ? "On" : "Off";
  });
  const auto = document.querySelector('[data-setting="auto_submit"]');
  auto.disabled = !s.name;
  $("autoNote").classList.toggle("hidden", Boolean(s.name));

  document.querySelectorAll("#mapStyleToggle [data-map-style]").forEach((el) => {
    const on = el.dataset.mapStyle === s.map_style;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
  });
}

async function onSaveName(event) {
  event.preventDefault();
  const input = $("settingsName");
  const msg = $("nameMsg");
  const name = input.value.trim();
  if (!name) {
    msg.textContent = "Enter a name.";
    input.focus();
    return;
  }
  $("saveNameBtn").disabled = true;
  msg.textContent = "";
  try {
    // The API cleans and checks it, the same check a submission gets.
    const result = await api.checkName(name);
    saveSettings({ name: result.name });
    input.value = "";
    msg.textContent = "Saved.";
  } catch (err) {
    msg.textContent =
      err.code === "offline"
        ? "Checking a name needs a connection."
        : err.message || "That did not go through. Try again in a moment.";
  } finally {
    $("saveNameBtn").disabled = false;
  }
}

export function openSettings() {
  $("nameMsg").textContent = "";
  $("settingsName").value = "";
  render();
  openModal("settingsModal");
}

export function initSettings() {
  applyMapStyle();
  $("settingsBtn").addEventListener("click", openSettings);
  $("nameForm").addEventListener("submit", onSaveName);
  $("clearNameBtn").addEventListener("click", () => {
    saveSettings({ name: null });
    $("nameMsg").textContent = "Name cleared.";
  });
  document.querySelectorAll("#settingsModal [data-setting]").forEach((el) => {
    el.addEventListener("click", () => saveSettings({ [el.dataset.setting]: !getSettings()[el.dataset.setting] }));
  });
  $("mapStyleToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-map-style]");
    if (btn) saveSettings({ map_style: btn.dataset.mapStyle });
  });
}
