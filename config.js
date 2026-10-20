// Einstellungen der Prüfungsseite
window.PRUEFUNGEN_CONFIG = {
  // ID des Google-Kalenders "Prüfungen BM (von Elias)"
  calendarId:
    "86f3a3eb765f4c49fc250489d0a1c9230bdb67dfe31d7a3ce306e5fa1a8b4028@group.calendar.google.com",

  // Google-API-Schlüssel (Calendar API). Leer lassen = lokale Kopie data/pruefungen.ics verwenden.
  // Anleitung siehe README.md
  apiKey: "AIzaSyAHBNH0rnyPiJXAcFx79piECJdVp3qp8mU",

  // Lokale Kopie des Kalenders (Fallback ohne API-Schlüssel)
  icsFallback: "data/pruefungen.ics",

  // Wie weit zurück vergangene Prüfungen geladen werden (Tage)
  pastDays: 400,
};
