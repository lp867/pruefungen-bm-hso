"""Wandelt den OpenOLAT-Stundenplan (iCal) in eine schlanke JSON-Datei für die Website um.

Der iCal-Link enthält einen persönlichen Zugangsschlüssel und wird deshalb nie veröffentlicht:
er kommt aus der Umgebungsvariable OLAT_ICS_URL (auf GitHub als Secret gespeichert).
In die JSON-Datei kommen nur Datum, Zeit, Fach, Zimmer sowie Kursname und Kurslink (Login nötig),
keine Namen von Lehrpersonen.

Aufruf:  OLAT_ICS_URL=... python tools/stundenplan.py [ziel.json]
         python tools/stundenplan.py --file stundenplan.ics [ziel.json]
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

KEEP_PAST_DAYS = 60  # ältere Lektionen werden weggelassen, damit die Datei klein bleibt


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pruefungen-bm-stundenplan"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read().decode("utf-8")


def unfold(text):
    return re.sub(r"\r?\n[ \t]", "", text).splitlines()


def unescape(value):
    return value.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\").strip()


def parse_time(value, params):
    """Gibt die Zeit als lokale Schweizer Zeit 'YYYY-MM-DDTHH:MM' zurück."""
    m = re.match(r"^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$", value)
    if not m:
        return None
    y, mo, d, h, mi, s, z = m.groups()
    if h is None:
        return f"{y}-{mo}-{d}T00:00"
    dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s))
    if z:
        try:
            from zoneinfo import ZoneInfo
            dt = dt.replace(tzinfo=timezone.utc).astimezone(ZoneInfo("Europe/Zurich")).replace(tzinfo=None)
        except Exception:
            pass  # ohne Zeitzonendaten: UTC-Zeit unverändert übernehmen
    return dt.strftime("%Y-%m-%dT%H:%M")


def subject_of(description, summary):
    if re.search(r"kein unterricht", description, re.I):
        return "Informationstermin", "kein Unterricht"
    if description:
        return description, ""
    # Fallback: "EFZ BM Deutsch Semester 2 - Name (…)" -> "Deutsch"
    m = re.search(r"EFZ BM (.+?) Semester", summary)
    return (m.group(1) if m else "Unterricht"), ""


def course_of(cur):
    """Kurs-ID, Kursname und Link zum OpenOLAT-Kurs (ohne Lehrperson)."""
    url = cur.get("url", "")
    m = re.search(r"/RepositoryEntry/(\d+)", url)
    if not m:
        return None, None
    # X-OLAT-LINK: RepositoryEntry§<url>§<Kursname>§<url>§<icon>
    parts = cur.get("olat_link", "").split("§")
    title = parts[2] if len(parts) > 2 else ""
    if not title:  # Fallback: "EFZ BM Deutsch Semester 2 - Name (…)" -> Teil vor " - "
        title = cur.get("summary", "").split(" - ")[0]
    return m.group(1), {"title": title.strip(), "url": url}


def convert(ics_text):
    lessons = []
    courses = {}
    cur = None
    for line in unfold(ics_text):
        if line == "BEGIN:VEVENT":
            cur = {}
            continue
        if line == "END:VEVENT":
            if cur and cur.get("start"):
                subject, note = subject_of(cur.get("description", ""), cur.get("summary", ""))
                lesson = {
                    "start": cur["start"],
                    "end": cur.get("end") or cur["start"],
                    "subject": subject,
                    "room": re.sub(r"^HSOZHO\s*/\s*", "", cur.get("location", "")),
                }
                if note:
                    lesson["note"] = note
                course_id, course = course_of(cur)
                if course_id:
                    lesson["course"] = course_id
                    courses[course_id] = course
                lessons.append(lesson)
            cur = None
            continue
        if cur is None or ":" not in line:
            continue
        head, value = line.split(":", 1)
        name, _, params = head.partition(";")
        if name == "DTSTART":
            cur["start"] = parse_time(value, params)
        elif name == "DTEND":
            cur["end"] = parse_time(value, params)
        elif name == "SUMMARY":
            cur["summary"] = unescape(value)
        elif name == "DESCRIPTION":
            cur["description"] = unescape(value)
        elif name == "LOCATION":
            cur["location"] = unescape(value)
        elif name == "URL":
            cur["url"] = value.strip()
        elif name == "X-OLAT-LINK":
            cur["olat_link"] = unescape(value)
        elif name == "STATUS" and value == "CANCELLED":
            cur["start"] = None

    cutoff = (datetime.now() - timedelta(days=KEEP_PAST_DAYS)).strftime("%Y-%m-%dT00:00")
    lessons = [l for l in lessons if l["start"] >= cutoff]
    lessons.sort(key=lambda l: (l["start"], l["subject"]))
    used = {l["course"] for l in lessons if "course" in l}
    courses = {cid: c for cid, c in sorted(courses.items()) if cid in used}
    return lessons, courses


def main(argv):
    args = list(argv)
    if args[:1] == ["--file"]:
        with open(args[1], encoding="utf-8") as f:
            text = f.read()
        args = args[2:]
    else:
        url = os.environ.get("OLAT_ICS_URL")
        if not url:
            sys.exit("OLAT_ICS_URL ist nicht gesetzt.")
        text = fetch(url)

    target = args[0] if args else os.path.join(os.path.dirname(__file__), "..", "data", "stundenplan.json")
    lessons, courses = convert(text)
    if not lessons:
        sys.exit("Keine Lektionen gefunden, Datei bleibt unverändert.")

    # Nur schreiben, wenn sich der Stundenplan wirklich geändert hat (vermeidet leere Commits)
    try:
        with open(target, encoding="utf-8") as f:
            old = json.load(f)
            if old.get("lessons") == lessons and old.get("courses") == courses:
                print(f"Stundenplan unverändert ({len(lessons)} Lektionen).")
                return
    except (OSError, ValueError):
        pass

    data = {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "courses": courses, "lessons": lessons}
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(f"Stundenplan geschrieben: {len(lessons)} Lektionen -> {target}")


if __name__ == "__main__":
    main(sys.argv[1:])
