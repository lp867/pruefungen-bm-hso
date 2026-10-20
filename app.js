(() => {
  "use strict";

  const CONFIG = window.PRUEFUNGEN_CONFIG;
  const LOCALE = "de-CH";
  const DAY = 24 * 60 * 60 * 1000;

  // Fach anhand des Titels erkennen. Reihenfolge zählt: erster Treffer gewinnt.
  const SUBJECTS = [
    { name: "Mathematik", hue: 215, re: /mathe/i },
    { name: "Deutsch", hue: 0, re: /deutsch|literatur|komma/i },
    { name: "Französisch", hue: 265, re: /franz|frz/i },
    { name: "Englisch", hue: 150, re: /engl/i },
    { name: "Recht", hue: 30, re: /recht/i },
    { name: "VWL", hue: 45, re: /vwl|wirtschaft/i },
    { name: "FRW", hue: 190, re: /frw|finanz|rechnungswesen/i },
    { name: "T&U", hue: 100, re: /t\s*&\s*u|technik|umwelt/i },
    { name: "IKT", hue: 320, re: /ikt|informatik/i },
    { name: "Geschichte", hue: 15, re: /geschichte|politik/i },
    { name: "IDAF", hue: 285, re: /idaf|idpa/i },
    { name: "SPA", hue: 170, re: /\bspa\b/i },
  ];
  const OTHER = { name: "Sonstiges", hue: 220 };

  // Einstellungen (gespeichert im Browser des Besuchers)
  const DEFAULT_SETTINGS = { theme: "system", compact: false, seconds: false, range: "upcoming", soonDays: 3 };
  const settings = { ...DEFAULT_SETTINGS, ...loadSettings() };

  const state = {
    events: [],
    loaded: false,
    loadedAt: null,
    mode: "",
    range: settings.range,
    subject: null,
    query: "",
    source: "",
  };

  // ---------- Hilfsfunktionen ----------

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem("pruefungen:settings")) || {}; } catch { return {}; }
  }
  function saveSettings() {
    try { localStorage.setItem("pruefungen:settings", JSON.stringify(settings)); } catch { /* egal */ }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function dayDiff(from, to) {
    return Math.round((startOfDay(to) - startOfDay(from)) / DAY);
  }

  function classify(title) {
    const subject = SUBJECTS.find((s) => s.re.test(title)) || OTHER;
    let kind = null;
    if (/abgabe|frist|dossier/i.test(title)) kind = "Abgabe / Frist";
    else if (/nachpr|nachhol/i.test(title)) kind = "Nachprüfung";
    else if (/zeugnis|rückgabe/i.test(title)) kind = "Info";
    else if (/kurzpr/i.test(title)) kind = "Kurzprüfung";
    return { subject, kind };
  }

  function makeEvent({ id, title, start, end, allDay, location, description }) {
    title = (title || "Ohne Titel").trim();
    if (!end || end <= start) end = new Date(start.getTime() + (allDay ? DAY : 60 * 60 * 1000));
    return { id, title, start, end, allDay, location: location || "", description: description || "", ...classify(title) };
  }

  // ---------- Daten laden ----------

  async function loadFromApi() {
    const timeMin = new Date(Date.now() - CONFIG.pastDays * DAY).toISOString();
    const params = new URLSearchParams({
      key: CONFIG.apiKey,
      singleEvents: "true",
      orderBy: "startTime",
      timeMin,
      maxResults: "250",
    });
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.calendarId)}/events?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google Calendar API antwortet mit ${res.status}`);
    const data = await res.json();

    const parseDate = (d) => {
      const [y, m, day] = d.split("-").map(Number);
      return new Date(y, m - 1, day);
    };

    return (data.items || [])
      .filter((e) => e.status !== "cancelled")
      .map((e) => {
        const allDay = Boolean(e.start.date);
        return makeEvent({
          id: e.id,
          title: e.summary,
          allDay,
          start: allDay ? parseDate(e.start.date) : new Date(e.start.dateTime),
          end: allDay ? parseDate(e.end.date) : new Date(e.end.dateTime),
          location: e.location,
          description: stripHtml(e.description || ""),
        });
      });
  }

  function stripHtml(s) {
    const div = document.createElement("div");
    div.innerHTML = s.replace(/<br\s*\/?>/gi, "\n");
    return div.textContent || "";
  }

  async function loadFromIcs() {
    const res = await fetch(CONFIG.icsFallback, { cache: "no-store" });
    if (!res.ok) throw new Error(`Lokale Kalenderkopie nicht gefunden (${res.status})`);
    return parseIcs(await res.text());
  }

  function parseIcsDate(value, params) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    const allDay = !h || /VALUE=DATE(?!-)/.test(params);
    if (allDay) return { date: new Date(+y, +mo - 1, +d), allDay: true };
    if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
    // TZID oder "floating": als lokale Zeit behandeln (Nutzer sind in der Schweiz)
    return { date: new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
  }

  function parseIcs(text) {
    const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
    const unescape = (v) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
    const events = [];
    let cur = null;
    let stamp = null;

    for (const line of lines) {
      if (line === "BEGIN:VEVENT") { cur = {}; continue; }
      if (line === "END:VEVENT") {
        if (cur && cur.status !== "CANCELLED" && cur.start) {
          events.push(makeEvent({
            id: cur.uid,
            title: cur.summary,
            start: cur.start.date,
            end: cur.end && cur.end.date,
            allDay: cur.start.allDay,
            location: cur.location,
            description: cur.description,
          }));
        }
        cur = null;
        continue;
      }
      if (!cur) continue;
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const [name, ...rest] = line.slice(0, idx).split(";");
      const params = rest.join(";");
      const value = line.slice(idx + 1);
      switch (name) {
        case "UID": cur.uid = value; break;
        case "SUMMARY": cur.summary = unescape(value); break;
        case "LOCATION": cur.location = unescape(value); break;
        case "DESCRIPTION": cur.description = stripHtml(unescape(value)); break;
        case "STATUS": cur.status = value; break;
        case "DTSTART": cur.start = parseIcsDate(value, params); break;
        case "DTEND": cur.end = parseIcsDate(value, params); break;
        case "DTSTAMP": if (!stamp) stamp = parseIcsDate(value, params); break;
      }
    }
    events.stamp = stamp && stamp.date;
    return events;
  }

  // ---------- Formatierung ----------

  const fmt = {
    weekdayShort: new Intl.DateTimeFormat(LOCALE, { weekday: "short" }),
    dayMonth: new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short" }),
    full: new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    time: new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" }),
    month: new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric" }),
    stamp: new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" }),
  };

  function timeLabel(e) {
    if (e.allDay) {
      const lastDay = new Date(e.end.getTime() - DAY);
      if (dayDiff(e.start, lastDay) >= 1) return `${fmt.dayMonth.format(e.start)} – ${fmt.dayMonth.format(lastDay)}`;
      return "Ganztägig";
    }
    return `${fmt.time.format(e.start)}–${fmt.time.format(e.end)}`;
  }

  function relLabel(e, now) {
    if (e.start <= now && now < e.end) return "läuft gerade";
    const diff = dayDiff(now, e.start);
    if (diff === 0) return "heute";
    if (diff === 1) return "morgen";
    if (diff === -1) return "gestern";
    if (diff > 1) return diff < 14 ? `in ${diff} Tagen` : `in ${Math.round(diff / 7)} Wochen`;
    const ago = -diff;
    return ago < 14 ? `vor ${ago} Tagen` : ago < 60 ? `vor ${Math.round(ago / 7)} Wochen` : `vor ${Math.round(ago / 30)} Monaten`;
  }

  // ---------- Darstellung ----------

  const $ = (id) => document.getElementById(id);

  function renderHero(now) {
    const next = state.events.find((e) => e.end > now);
    const hero = $("hero");
    if (!next) {
      hero.innerHTML = `<p class="hero__label">Nächste Prüfung</p><h2 class="hero__title">Keine Prüfungen geplant 🎉</h2>
        <p class="hero__meta">Sobald ein neuer Termin im Kalender steht, erscheint er hier.</p>`;
      return;
    }
    const running = next.start <= now;
    let ms = Math.max(0, next.start - now);
    const d = Math.floor(ms / DAY); ms -= d * DAY;
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000);
    const cell = (n, unit) => `<div class="countdown__cell"><span class="countdown__num">${n}</span><span class="countdown__unit">${unit}</span></div>`;

    hero.innerHTML = `
      <div class="hero__grid">
        <div>
          <p class="hero__label">${running ? "Läuft gerade" : "Nächste Prüfung"} · ${esc(next.subject.name)}</p>
          <h2 class="hero__title">${esc(next.title)}</h2>
          <p class="hero__meta">
            <span>${esc(fmt.full.format(next.start))}</span>
            <span>${esc(timeLabel(next))}</span>
            ${next.location ? `<span>${esc(next.location)}</span>` : ""}
          </p>
          ${next.sameDay ? `<p class="hero__conflict">Achtung: ${conflictLabel(next)}</p>` : ""}
        </div>
        ${running ? "" : `<div class="countdown" aria-label="Countdown">${cell(d, d === 1 ? "Tag" : "Tage")}${cell(h, "Std")}${cell(m, "Min")}${settings.seconds ? cell(s, "Sek") : ""}</div>`}
      </div>`;
  }

  function renderStats(now) {
    const upcoming = state.events.filter((e) => e.end > now);
    const soon = upcoming.filter((e) => e.start - now < 30 * DAY).length;
    const past = state.events.length - upcoming.length;
    const stat = (n, label, red) => `<div class="stat"><div class="stat__num${red ? " stat__num--red" : ""}">${n}</div><div class="stat__label">${label}</div></div>`;
    $("stats").innerHTML = stat(upcoming.length, "Kommend", true) + stat(soon, "Nächste 30 Tage") + stat(past, "Erledigt");
  }

  // ---------- Konflikte: mehrere Prüfungen am selben Tag ----------

  function markConflicts(events) {
    const byDay = new Map();
    for (const e of events) {
      e.sameDay = 0;
      e.sameDayTitles = [];
      if (e.kind === "Info") continue; // z. B. Zeugnisrückgabe ist keine Prüfung
      const key = startOfDay(e.start).getTime();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    }
    for (const group of byDay.values()) {
      if (group.length < 2) continue;
      for (const e of group) {
        e.sameDay = group.length - 1;
        e.sameDayTitles = group.filter((o) => o !== e).map((o) => o.title);
      }
    }
  }

  function conflictLabel(e) {
    return `${e.sameDay + 1} Prüfungen an diesem Tag`;
  }

  function eventsInRange(now) {
    if (state.range === "upcoming") return state.events.filter((e) => e.end > now);
    if (state.range === "past") return state.events.filter((e) => e.end <= now).reverse();
    return state.events;
  }

  function renderChips(inRange) {
    const present = new Map();
    inRange.forEach((e) => present.set(e.subject.name, e.subject));
    if (state.subject && !present.has(state.subject)) state.subject = null;
    const chips = [...present.values()].sort((a, b) => a.name.localeCompare(b.name, LOCALE));
    $("subjects").innerHTML =
      `<button type="button" class="chip chip--all" data-subject="" aria-pressed="${!state.subject}">Alle Fächer</button>` +
      chips.map((s) => `<button type="button" class="chip" style="--h:${s.hue}" data-subject="${esc(s.name)}" aria-pressed="${state.subject === s.name}">${esc(s.name)}</button>`).join("");
  }

  function renderList(now) {
    const inRange = eventsInRange(now);
    renderChips(inRange);

    const q = state.query.trim().toLowerCase();
    const shown = inRange.filter((e) =>
      (!state.subject || e.subject.name === state.subject) &&
      (!q || `${e.title} ${e.subject.name} ${e.location} ${e.description}`.toLowerCase().includes(q))
    );

    const list = $("list");
    if (!shown.length) {
      list.innerHTML = `<div class="empty">${state.range === "upcoming" && !q && !state.subject ? "Keine kommenden Prüfungen. Geniess die Zeit! 🎉" : "Keine passenden Einträge gefunden."}</div>`;
      return;
    }

    let html = "";
    let lastMonth = "";
    for (const e of shown) {
      const month = fmt.month.format(e.start);
      if (month !== lastMonth) { html += `<h3 class="month">${esc(month)}</h3>`; lastMonth = month; }
      const past = e.end <= now;
      const daysLeft = dayDiff(now, e.start);
      const soon = !past && daysLeft <= settings.soonDays;
      html += `
        <article class="card${past ? " card--past" : ""}" style="--h:${e.subject.hue}">
          <div class="date"><span class="date__day">${e.start.getDate()}</span><span class="date__wd">${esc(fmt.weekdayShort.format(e.start).replace(".", ""))}</span></div>
          <div>
            <h4 class="card__title">${esc(e.title)}</h4>
            <p class="card__meta">
              <span>${esc(timeLabel(e))}</span>
              ${e.location ? `<span>${esc(e.location)}</span>` : ""}
            </p>
            ${e.description ? `<p class="card__desc">${esc(e.description)}</p>` : ""}
            <div class="tags">
              <span class="tag tag--subject">${esc(e.subject.name)}</span>
              ${e.kind ? `<span class="tag${/Nach|Frist/.test(e.kind) ? " tag--warn" : ""}">${esc(e.kind)}</span>` : ""}
              ${e.sameDay ? `<span class="tag tag--warn" title="${esc(e.sameDayTitles.join(", "))}">${esc(conflictLabel(e))}</span>` : ""}
            </div>
          </div>
          <div class="when${soon ? " when--soon" : ""}">${esc(relLabel(e, now))}</div>
        </article>`;
    }
    list.innerHTML = html;
  }

  function render() {
    if (!state.loaded) return;
    const now = new Date();
    renderHero(now);
    renderStats(now);
    renderList(now);
    renderFacts(now);
    $("source").textContent = state.source;
  }

  function renderFacts(now) {
    const upcoming = state.events.filter((e) => e.end > now).length;
    const subjects = new Set(state.events.map((e) => e.subject.name)).size;
    const conflictDays = new Set(state.events.filter((e) => e.sameDay && e.end > now).map((e) => startOfDay(e.start).getTime())).size;
    const row = (k, v) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
    $("facts").innerHTML =
      row("Einträge", `${state.events.length} total, ${upcoming} kommend`) +
      row("Fächer", String(subjects)) +
      row("Konflikte", conflictDays ? `${conflictDays} Tag(e) mit mehreren Prüfungen` : "keine kommenden") +
      row("Datenquelle", state.mode === "api" ? "Google Kalender (live)" : "Lokale Kalenderkopie") +
      row("Stand", state.loadedAt ? fmt.stamp.format(state.loadedAt) : "–") +
      (state.mode === "api" ? row("Aktualisierung", "automatisch alle 10 Min.") : "");
  }

  // ---------- Bedienung ----------

  function setRange(range) {
    state.range = range;
    document.querySelectorAll("#range button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.range === range)));
    render();
  }

  // ---------- Einstellungen ----------

  let tickTimer = null;

  function applySettings() {
    const root = document.documentElement;
    if (settings.theme === "light" || settings.theme === "dark") root.dataset.theme = settings.theme;
    else delete root.dataset.theme;
    document.body.classList.toggle("compact", settings.compact);

    // Countdown: jede Sekunde oder alle 30 Sekunden neu zeichnen
    clearInterval(tickTimer);
    tickTimer = setInterval(() => { if (state.loaded) renderHero(new Date()); }, settings.seconds ? 1000 : 30 * 1000);

    // Bedienelemente im Panel auf den aktuellen Stand bringen
    const press = (groupId, value) =>
      document.querySelectorAll(`#${groupId} button`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));
    press("set-theme", settings.theme);
    press("set-range", settings.range);
    $("set-compact").checked = settings.compact;
    $("set-seconds").checked = settings.seconds;
    $("set-soon").value = String(settings.soonDays);
  }

  function updateSetting(key, value) {
    settings[key] = value;
    saveSettings();
    applySettings();
    if (key === "range") setRange(value);
    else render();
  }

  function initSettings() {
    const drawer = $("settings");
    const menu = $("menu");
    const header = document.querySelector(".top");
    // Alles ausser Kopfzeile und Panel ist gesperrt, solange das Menü offen ist
    const background = [document.querySelector(".hero"), document.querySelector("main"), document.querySelector(".foot"), document.querySelector(".top__actions")];

    const isOpen = () => menu.getAttribute("aria-expanded") === "true";

    function setOpen(open) {
      if (open === isOpen()) return;
      document.documentElement.style.setProperty("--top-h", `${header.offsetHeight}px`);
      menu.setAttribute("aria-expanded", String(open));
      menu.setAttribute("aria-label", open ? "Einstellungen schliessen" : "Einstellungen und Infos öffnen");
      document.body.classList.toggle("menu-open", open);
      drawer.inert = !open;
      background.forEach((el) => { el.inert = open; });
      if (!open) menu.focus();
    }

    menu.addEventListener("click", () => setOpen(!isOpen()));
    $("settings-overlay").addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && isOpen()) setOpen(false); });
    window.addEventListener("resize", () => document.documentElement.style.setProperty("--top-h", `${header.offsetHeight}px`));

    const group = (id, key) => $(id).addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-value]");
      if (b) updateSetting(key, b.dataset.value);
    });
    group("set-theme", "theme");
    group("set-range", "range");
    $("set-compact").addEventListener("change", (ev) => updateSetting("compact", ev.target.checked));
    $("set-seconds").addEventListener("change", (ev) => updateSetting("seconds", ev.target.checked));
    $("set-soon").addEventListener("change", (ev) => updateSetting("soonDays", Number(ev.target.value)));

    $("reload").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = "Lädt…";
      await refresh();
      btn.disabled = false;
      btn.textContent = "Daten neu laden";
    });

    applySettings();
  }

  function initControls() {
    $("range").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-range]");
      if (b) setRange(b.dataset.range);
    });
    $("subjects").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-subject]");
      if (!b) return;
      const s = b.dataset.subject || null;
      state.subject = state.subject === s ? null : s;
      renderList(new Date());
    });
    $("search").addEventListener("input", (ev) => {
      state.query = ev.target.value;
      renderList(new Date());
    });
    const subscribeUrl = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(CONFIG.calendarId)}`;
    $("subscribe").href = subscribeUrl;
    $("subscribe-2").href = subscribeUrl;

    // iCal-Link für andere Kalender-Apps (iPhone, Outlook, …)
    const icalUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(CONFIG.calendarId)}/public/basic.ics`;
    const field = $("ical-url");
    field.value = icalUrl;
    field.addEventListener("focus", () => field.select());
    $("ical-copy").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      try {
        await navigator.clipboard.writeText(icalUrl);
      } catch {
        field.select();
        document.execCommand("copy");
      }
      btn.textContent = "Kopiert ✓";
      setTimeout(() => { btn.textContent = "Kopieren"; }, 2000);
    });
  }

  async function refresh() {
    try {
      let events = null;
      if (CONFIG.apiKey) {
        try {
          events = await loadFromApi();
          state.mode = "api";
          state.loadedAt = new Date();
          state.source = `Live aus Google Kalender · Stand ${fmt.stamp.format(state.loadedAt)}`;
        } catch (err) {
          // Google nicht erreichbar oder Schlüssel abgelehnt: auf lokale Kopie ausweichen
          console.warn("Live-Abruf fehlgeschlagen, verwende lokale Kopie:", err);
          if (state.mode === "api") return; // bereits Live-Daten angezeigt, diese behalten
        }
      }
      if (!events) {
        events = await loadFromIcs();
        state.mode = "ics";
        state.loadedAt = events.stamp || new Date();
        state.source = `Lokale Kalenderkopie vom ${fmt.stamp.format(state.loadedAt)}`;
      }
      state.events = events.sort((a, b) => a.start - b.start);
      markConflicts(state.events);
      state.loaded = true;
      render();
    } catch (err) {
      console.error(err);
      if (!state.loaded) {
        $("hero").innerHTML = `<p class="hero__label">Fehler</p><h2 class="hero__title">Kalender konnte nicht geladen werden</h2>`;
        $("list").innerHTML = `<div class="error">${esc(err.message)}</div>`;
      }
    }
  }

  initSettings();
  initControls();
  setRange(["upcoming", "past", "all"].includes(state.range) ? state.range : "upcoming");
  refresh();
  setInterval(render, 60 * 1000);                 // "heute/morgen" & Listen aktuell halten
  if (CONFIG.apiKey) setInterval(refresh, 10 * 60 * 1000); // neue Einträge alle 10 Min.
})();
