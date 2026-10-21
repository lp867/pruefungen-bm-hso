# Prüfungen BM

Website, die alle Prüfungsdaten aus dem Google-Kalender **„Prüfungen BM (von Elias)“** anzeigt.
Neue Prüfung? Einfach im Google-Kalender eintragen, die Seite übernimmt sie.

**Online:** <https://lp867.github.io/pruefungen-bm-hso/>

Bei Fragen oder fehlenden Prüfungen: an Elias wenden.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Seitengerüst |
| `style.css` | Design (hell/dunkel, Handy) |
| `app.js` | Lädt den Kalender und stellt ihn dar |
| `config.js` | Kalender-ID und API-Schlüssel |
| `data/pruefungen.ics` | Lokale Kopie des Kalenders (Fallback) |
| `update-kalender.ps1` | Aktualisiert die lokale Kopie |
| `data/stundenplan.json` | Stundenplan (automatisch erzeugt) |
| `tools/stundenplan.py` | Wandelt den OpenOLAT-Stundenplan um |
| `.github/workflows/stundenplan.yml` | Aktualisiert den Stundenplan alle 6 Stunden |

## Stundenplan

Der Tab **Stundenplan** zeigt die Lektionen der Klasse wochenweise, inklusive der Prüfungen aus dem Kalender.

- Quelle ist der OpenOLAT-Kalender. Sein iCal-Link enthält einen persönlichen Schlüssel und ist deshalb **nicht** im Code, sondern als Secret `OLAT_ICS_URL` im GitHub-Repository gespeichert (Settings → Secrets and variables → Actions).
- Die GitHub Action `.github/workflows/stundenplan.yml` holt den Stundenplan alle 6 Stunden, wandelt ihn mit `tools/stundenplan.py` um und speichert `data/stundenplan.json`. Darin stehen nur Datum, Zeit, Fach und Zimmer, keine Namen von Lehrpersonen.
- Sofort aktualisieren: im Repo unter *Actions → Stundenplan aktualisieren → Run workflow*.

## Tipps für Kalendereinträge

- Das **Fach** wird aus dem Titel erkannt (z. B. „Mathe“, „Französisch“, „T&U“, „VWL“, „IKT“).
- Wörter wie **Abgabe**, **Frist**, **Nachprüfung** oder **Kurzprüfung** erzeugen ein Zusatz-Label.
- **Ort** (Zimmer) und **Beschreibung** (z. B. Themen) werden mit angezeigt.

## Live-Modus mit API-Schlüssel (empfohlen)

Ohne Schlüssel zeigt die Seite die lokale Kopie `data/pruefungen.ics`. Mit Schlüssel holt sie die Daten direkt und live von Google:

1. <https://console.cloud.google.com/> öffnen und ein Projekt anlegen.
2. Unter *APIs & Dienste → Bibliothek* die **Google Calendar API** aktivieren.
3. Unter *Anmeldedaten → Anmeldedaten erstellen → API-Schlüssel* einen Schlüssel erstellen.
4. Den Schlüssel einschränken:
   - *Anwendungseinschränkung = Websites*, dort eintragen: `http://localhost:5173/*` und später deine echte Adresse (z. B. `https://deinname.github.io/*`)
   - *API-Einschränkung = Google Calendar API*
5. Den Schlüssel in `config.js` bei `apiKey` eintragen.

Der Schlüssel ist im Quelltext der Seite sichtbar. Das ist bei solchen Browser-Schlüsseln normal: Die Einschränkung aus Schritt 4 sorgt dafür, dass ihn niemand auf anderen Seiten oder für andere Google-Dienste nutzen kann. Die Calendar API ist kostenlos, eine Kreditkarte braucht es nicht.

Der Kalender muss öffentlich bleiben (Google Kalender → Einstellungen → *Öffentlich freigeben*). Das ist bereits so eingestellt.

## Lokal testen

```
python -m http.server 5173
```

Danach <http://localhost:5173> öffnen. Die Seite muss über einen Server laufen. Ein Doppelklick auf `index.html` funktioniert nicht, weil der Browser dann die Kalenderdatei blockiert.
