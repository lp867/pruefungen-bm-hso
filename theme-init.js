// Design sofort setzen, bevor die Seite gezeichnet wird, damit sie nicht kurz im falschen Modus aufblitzt.
// (Eigene Datei statt eingebettetem Skript, damit die Content Security Policy eingebettete Skripte verbieten kann.)
try {
  var t = (JSON.parse(localStorage.getItem("pruefungen:settings")) || {}).theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
