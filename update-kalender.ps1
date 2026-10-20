# Laedt die aktuelle oeffentliche Kopie des Pruefungskalenders nach data/pruefungen.ics
# (Fallback, falls der Live-Abruf ueber die Google-API einmal nicht klappt)
$calendarId = "86f3a3eb765f4c49fc250489d0a1c9230bdb67dfe31d7a3ce306e5fa1a8b4028@group.calendar.google.com"
$url = "https://calendar.google.com/calendar/ical/$([uri]::EscapeDataString($calendarId))/public/basic.ics"
$target = Join-Path $PSScriptRoot "data\pruefungen.ics"

New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
Invoke-WebRequest -UseBasicParsing $url -OutFile $target
$count = (Select-String -Path $target -Pattern '^BEGIN:VEVENT').Count
Write-Host "Kalender aktualisiert: $count Eintraege -> $target"
