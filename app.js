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
    { name: "T&U", hue: 100, re: /t\s*&\s*u|\btu\b|technik|umwelt/i },
    { name: "IKT", hue: 320, re: /ikt|informatik/i },
    { name: "Geschichte", hue: 15, re: /geschichte|politik|\bgp\b/i },
    { name: "IDAF", hue: 285, re: /idaf|idpa/i },
    { name: "BK", hue: 340, re: /\bbk\b|betriebskunde/i },
    { name: "Sport", hue: 125, re: /sport/i },
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

  // Anzahl Einträge als kleine Zähler in den Tabs
  function renderCounts(now) {
    const upcoming = state.events.filter((e) => e.end > now).length;
    const counts = { upcoming, past: state.events.length - upcoming, all: state.events.length };
    document.querySelectorAll("[data-count]").forEach((el) => { el.textContent = counts[el.dataset.count]; });
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
    // Ein Fachfilter lohnt sich erst ab zwei Fächern
    $("subjects").hidden = chips.length < 2;
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

    // Nach Monat gruppieren: pro Monat eine Überschrift und ein Block mit Zeilen
    const groups = [];
    for (const e of shown) {
      const month = fmt.month.format(e.start);
      if (!groups.length || groups[groups.length - 1].month !== month) groups.push({ month, items: [] });
      groups[groups.length - 1].items.push(e);
    }

    list.innerHTML = groups.map((g) => `
      <section class="month-group">
        <h3 class="month">${esc(g.month)}</h3>
        <div class="rows">${g.items.map((e) => renderRow(e, now)).join("")}</div>
      </section>`).join("");
  }

  function renderRow(e, now) {
    const past = e.end <= now;
    const soon = !past && dayDiff(now, e.start) <= settings.soonDays;
    const meta = [timeLabel(e), e.location].filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join("");
    const tags = [
      e.kind ? `<span class="tag${/Nach|Frist/.test(e.kind) ? " tag--warn" : ""}">${esc(e.kind)}</span>` : "",
      e.sameDay ? `<span class="tag tag--warn" title="${esc(e.sameDayTitles.join(", "))}">${esc(conflictLabel(e))}</span>` : "",
    ].join("");
    return `
      <article class="row${past ? " row--past" : ""}" style="--h:${e.subject.hue}">
        <div class="row__date"><span class="row__day">${e.start.getDate()}</span><span class="row__wd">${esc(fmt.weekdayShort.format(e.start).replace(".", ""))}</span></div>
        <div class="row__main">
          <h4 class="row__title">${esc(e.title)}</h4>
          <p class="row__meta"><span class="row__subject">${esc(e.subject.name)}</span>${meta}</p>
          ${e.description ? `<p class="row__desc">${esc(e.description)}</p>` : ""}
          ${tags ? `<div class="tags">${tags}</div>` : ""}
        </div>
        <div class="when${soon ? " when--soon" : ""}">${esc(relLabel(e, now))}</div>
      </article>`;
  }

  function render() {
    if (!state.loaded) return;
    const now = new Date();
    renderHero(now);
    renderCounts(now);
    renderList(now);
    renderFacts(now);
    if (view === "stundenplan") renderTimetable(now); // Prüfungen erscheinen auch im Stundenplan
    renderFooter();
  }

  function renderFooter() {
    $("source").textContent = view === "stundenplan" ? tt.source : state.source;
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

  // ---------- Ansichten: Prüfungen | Stundenplan ----------

  const VIEWS = ["pruefungen", "stundenplan"];
  let view = "pruefungen";

  function setView(next) {
    view = VIEWS.includes(next) ? next : "pruefungen";
    document.querySelectorAll("[data-panel]").forEach((el) => { el.hidden = el.dataset.panel !== view; });
    document.querySelectorAll(".views__tab").forEach((a) => {
      if (a.dataset.view === view) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    if (view === "stundenplan") {
      if (!tt.loaded) loadTimetable();
      else renderTimetable(new Date());
    }
    renderFooter();
  }

  function initViews() {
    window.addEventListener("hashchange", () => setView(location.hash.slice(1)));
    setView(location.hash.slice(1));
  }

  // ---------- Stundenplan ----------

  const tt = { lessons: [], loaded: false, offset: 0, source: "" };
  const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

  // "2026-10-21T08:30" als lokale Zeit lesen
  function localDate(s) {
    const [d, t = "00:00"] = s.split("T");
    const [y, m, day] = d.split("-").map(Number);
    const [h, mi] = t.split(":").map(Number);
    return new Date(y, m - 1, day, h, mi);
  }

  async function loadTimetable() {
    $("tt-week").innerHTML = `<div class="empty">Stundenplan wird geladen…</div>`;
    try {
      const res = await fetch(CONFIG.timetableUrl || "data/stundenplan.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`Stundenplan nicht gefunden (${res.status})`);
      const data = await res.json();
      tt.lessons = data.lessons.map((l) => ({
        start: localDate(l.start),
        end: localDate(l.end),
        subject: l.subject,
        room: l.room,
        note: l.note || "",
        color: classify(l.subject).subject.hue,
      }));
      tt.loaded = true;
      tt.source = `Stundenplan aus OpenOLAT · zuletzt geändert ${fmt.stamp.format(new Date(data.updated))}`;
      renderTimetable(new Date());
      renderFooter();
    } catch (err) {
      console.error(err);
      $("tt-week").innerHTML = `<div class="error">${esc(err.message)}</div>`;
    }
  }

  function mondayOf(d) {
    const day = startOfDay(d);
    day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    return day;
  }

  // Kalenderwoche nach ISO 8601
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
  }

  function shownMonday(now) {
    const base = mondayOf(now);
    // Am Wochenende gleich die kommende Woche zeigen
    if (now.getDay() === 6 || now.getDay() === 0) base.setDate(base.getDate() + 7);
    base.setDate(base.getDate() + tt.offset * 7);
    return base;
  }

  const timeRange = (a, b) => `${fmt.time.format(a)}–${fmt.time.format(b)}`;

  // "Jetzt" bzw. "Als Nächstes" für heute oder den nächsten Schultag
  function renderNow(now) {
    const box = $("tt-now");
    const current = tt.lessons.find((l) => l.start <= now && now < l.end);
    const next = tt.lessons.find((l) => l.start > now);
    const place = (l) => (l.room ? ` · ${esc(l.room)}` : "");
    if (current) {
      box.innerHTML = `<span class="tt-now__label">Jetzt</span><strong>${esc(current.subject)}</strong><span>bis ${fmt.time.format(current.end)}${place(current)}</span>` +
        (next && dayDiff(now, next.start) === 0 ? `<span class="tt-now__after">danach ${esc(next.subject)} um ${fmt.time.format(next.start)}</span>` : "");
    } else if (next) {
      const diff = dayDiff(now, next.start);
      const when = diff === 0 ? `heute um ${fmt.time.format(next.start)}` : diff === 1 ? `morgen um ${fmt.time.format(next.start)}`
        : `${fmt.full.format(next.start)}, ${fmt.time.format(next.start)}`;
      box.innerHTML = `<span class="tt-now__label">Als Nächstes</span><strong>${esc(next.subject)}</strong><span>${esc(when)}${place(next)}</span>`;
    } else {
      box.innerHTML = `<span class="tt-now__label">Stundenplan</span><span>Keine weiteren Lektionen eingetragen.</span>`;
    }
  }

  function renderTimetable(now) {
    if (!tt.loaded) return;
    renderNow(now);

    const monday = shownMonday(now);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      const key = date.getTime();
      const lessons = tt.lessons.filter((l) => startOfDay(l.start).getTime() === key);
      const exams = state.events.filter((e) => e.kind !== "Info" && startOfDay(e.start).getTime() === key);
      // Samstag/Sonntag nur zeigen, wenn dort etwas stattfindet
      if (i >= 5 && !lessons.length && !exams.length) continue;
      days.push({ date, lessons, exams });
    }

    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    $("tt-label").innerHTML = `<strong>KW ${isoWeek(monday)}</strong><span>${esc(fmt.dayMonth.format(monday))} – ${esc(fmt.dayMonth.format(friday))} ${friday.getFullYear()}</span>`;
    $("tt-today").hidden = tt.offset === 0;

    const empty = days.every((d) => !d.lessons.length && !d.exams.length);
    const week = $("tt-week");
    week.style.setProperty("--days", days.length);
    if (empty) {
      week.innerHTML = `<div class="empty tt-empty">Keine Lektionen in dieser Woche, vielleicht Ferien. 🌿</div>`;
      return;
    }

    // Zeitraster: von der frühesten bis zur spätesten Lektion der Woche (in Minuten ab Mitternacht).
    // Jede Lektion wird nach Uhrzeit platziert und ist so hoch, wie sie dauert -> gleiche Zeiten liegen auf gleicher Höhe.
    const minutes = (d) => d.getHours() * 60 + d.getMinutes();
    const all = days.flatMap((d) => d.lessons);
    const from = all.length ? Math.min(...all.map((l) => minutes(l.start))) : 8 * 60;
    const to = all.length ? Math.max(...all.map((l) => minutes(l.end))) : 17 * 60;
    week.style.setProperty("--span", to - from);

    const hours = [];
    for (let h = Math.ceil(from / 60) * 60; h <= to; h += 60) hours.push(h);
    const hourLines = hours.map((h) => `<div class="tt-hour" style="--top:${h - from}"></div>`).join("");
    const axis = `<div class="tt-axis" aria-hidden="true">
        <div></div><div></div>
        <div class="tt-axis__body">${hours.map((h) => `<span style="--top:${h - from}">${h / 60}:00</span>`).join("")}</div>
      </div>`;

    week.innerHTML = axis + days.map(({ date, lessons, exams }) => {
      const isToday = dayDiff(now, date) === 0;
      const examHtml = exams.map((e) =>
        `<div class="tt-exam"><span class="tt-exam__label">${e.kind && /Abgabe|Frist/.test(e.kind) ? "Abgabe" : "Prüfung"}</span><strong>${esc(e.title)}</strong>${e.allDay ? "" : `<span>${esc(timeRange(e.start, e.end))}</span>`}</div>`
      ).join("");
      const lessonHtml = lessons.map((l) => {
        const len = (l.end - l.start) / 60000;
        const cls = (l.end <= now ? " tt-lesson--past" : l.start <= now ? " tt-lesson--now" : "") + (len < 60 ? " tt-lesson--short" : "");
        return `<div class="tt-lesson${cls}" style="--h:${l.color};--top:${minutes(l.start) - from};--len:${len}">
            <span class="tt-lesson__time">${esc(timeRange(l.start, l.end))}</span>
            <span class="tt-lesson__subject">${esc(l.subject)}</span>
            ${l.room || l.note ? `<span class="tt-lesson__room">${esc([l.room, l.note].filter(Boolean).join(" · "))}</span>` : ""}
          </div>`;
      }).join("");
      const nowLine = isToday && minutes(now) > from && minutes(now) < to
        ? `<div class="tt-nowline" style="--top:${minutes(now) - from}" title="Jetzt"></div>` : "";
      return `<section class="tt-day${isToday ? " tt-day--today" : ""}">
          <h3 class="tt-day__head"><span class="tt-day__wd">${WEEKDAYS[date.getDay()]}</span><span class="tt-day__date">${date.getDate()}.${date.getMonth() + 1}.</span>${isToday ? `<span class="tt-day__badge">Heute</span>` : ""}</h3>
          <div class="tt-day__exams">${examHtml}</div>
          <div class="tt-day__body">${hourLines}${lessonHtml || `<p class="tt-free">frei</p>`}${nowLine}</div>
        </section>`;
    }).join("");
  }

  function initTimetable() {
    const move = (delta) => { tt.offset = delta === 0 ? 0 : tt.offset + delta; renderTimetable(new Date()); };
    $("tt-prev").addEventListener("click", () => move(-1));
    $("tt-next").addEventListener("click", () => move(1));
    $("tt-today").addEventListener("click", () => move(0));
    // Pfeiltasten wechseln die Woche, solange der Stundenplan offen ist und nicht getippt wird
    document.addEventListener("keydown", (ev) => {
      if (view !== "stundenplan" || ev.target.closest("input, select, textarea") || document.body.classList.contains("menu-open")) return;
      if (ev.key === "ArrowLeft") move(-1);
      if (ev.key === "ArrowRight") move(1);
    });
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
    const background = [...document.querySelectorAll("[data-panel], .views, .foot")];

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
    $("subscribe-2").href = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(CONFIG.calendarId)}`;

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
  initTimetable();
  setRange(["upcoming", "past", "all"].includes(state.range) ? state.range : "upcoming");
  initViews();
  refresh();
  setInterval(() => {                             // "heute/morgen", "Jetzt" & Listen aktuell halten
    render();
    if (!state.loaded && view === "stundenplan") renderTimetable(new Date());
  }, 60 * 1000);
  if (CONFIG.apiKey) setInterval(refresh, 10 * 60 * 1000); // neue Einträge alle 10 Min.
})();
