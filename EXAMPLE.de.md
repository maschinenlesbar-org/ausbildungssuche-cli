# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `ausbildungssuche`, eines pro Skill: eine
Anfrage, die `ausbildungssuche`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 mit `ausbildungssuche` 0.2.0 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs können Sie
die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [ausbildung-finder](#ausbildung-finder) · [ausbildung-market-scan](#ausbildung-market-scan) · [ausbildung-offer-brief](#ausbildung-offer-brief)

## ausbildung-finder

> Umschulung zum staatlich anerkannten Erzieher in der Nähe von Leipzig – welche Angebote werden über einen Bildungsgutschein gefördert?

```bash
[ -n "$AUSBILDUNGSSUCHE_API_KEY" ] && echo "key set" || echo "no key"   # no key
ausbildungssuche obtain-key                                             # der öffentliche Schlüssel, für die weiteren Aufrufe behalten
for p in 0 1 2 3 4; do                                                  # 186 Angebote; dkzId 9162 tauchte auf Seite 3 auf
  ausbildungssuche --compact search --orte "Leipzig_12.374_51.340" --uk 25 --bg --bart 102 --size 20 --page "$p"
done
ausbildungssuche --compact search --ids 9162 --orte "Leipzig_12.374_51.340" --uk 25 --bg --size 20   # 3
ausbildungssuche --compact search --ids 9162 --orte "Leipzig_12.374_51.340" --uk 25 --size 20        # 4 ohne Gutschein-Filter
```

In der Umgebung war kein Schlüssel gesetzt, also hat der Skill den öffentlichen abgerufen und bei
jedem weiteren Aufruf mitgegeben (die Befehle oben lassen dieses Präfix weg). Das Suchwort `--sw`
filtert nichts, deshalb hat der Skill stattdessen die Berufs-ID gesucht: Er hat
Berufsausbildungsangebote rund um Leipzig gesichtet und auf der vierten Seite (Seite 3) die
`dkzId` 9162 gefunden (Staatlich anerkannter Erzieher/Staatlich anerkannte Erzieherin) und dann
mit `--ids` gefiltert. Die Entfernungen stammen aus `abstaende[].abstandInKm` der API; die Daten
sind in Europe/Berlin-Zeit umgerechnet.

```
Erzieher-Ausbildung im Umkreis von 25 km um Leipzig, Bildungsgutschein-fähig – 3 von 4 Angeboten

  Titel                                Anbieter                                    Ort (km)         Beginn
  Erzieher/in                          Ludwig Fresenius Schulen                    Leipzig (3,1)    2027-08-01
  Erzieherin/Erzieher                  Heimerer Schulen                            Leipzig (3,6)    2027-08-23
  Staatlich anerkannte/r Erzieher/in   Aus- & WeiterbildungsSchulen des VMKB e.V.  Leipzig (5,4)    laufender Einstieg (Durchgang seit 2025-08-11)

  Alle drei: Berufsausbildung, Vollzeit, mehr als 2 Jahre bis 3 Jahre, förderfähig ✓.
  IDs: 192018451 · 153387597 · 80081437

Nicht gutscheinfähig (1): Erzieher Ausbildung, Bernd Blindow Gruppe, Leipzig 2,5 km, Beginn 2027-08-01.
```

Als Nächstes angeboten: eine ausführliche Zusammenfassung eines der drei Angebote
(ausbildung-offer-brief) oder ein größerer Umkreis.

## ausbildung-market-scan

> Wo in Deutschland kann man sich zum staatlich anerkannten Erzieher (dkzId 9162) ausbilden lassen, aufgeschlüsselt nach Bundesland, und wie viel davon ist über einen Bildungsgutschein förderfähig?

```bash
[ -n "$AUSBILDUNGSSUCHE_API_KEY" ] && echo "key set" || echo "no key"   # no key: obtain-key wie oben
ausbildungssuche --compact search --ids 9162 --uk Bundesweit --size 1 | jq '.page.totalElements'        # 337
ausbildungssuche --compact search --ids 9162 --uk Bundesweit --bg --size 1 | jq '.page.totalElements'   # 93
for re in BAW BAY BER BRA BRE HAM HES MBV NDS NRW RPF SAA SAC SAN SLH THÜ; do
  ausbildungssuche --compact search --ids 9162 --re "$re" --size 1 | jq '.page.totalElements'
done
```

Der Skill hat die Berufs-ID festgehalten und `--re` über die 16 dreistelligen `land.code`-Werte
laufen lassen, jeweils mit `page.totalElements`; die bundesweiten Zahlen stammen aus Abfragen ohne
`--re`. Hamburg lieferte 0 Angebote, und die CLI wies auf stderr darauf hin, dass auch ein
unbekannter `--ids`-Wert ein leeres Ergebnis ergäbe – hier ist die ID gültig, Hamburg führt
darunter einfach nichts. Um die Zahl der Anfragen klein zu halten, ist der Gutschein-Anteil nur
bundesweit erhoben.

```
Ausbildung zum staatlich anerkannten Erzieher (dkzId 9162) nach Bundesland – kein Wert nahe der Obergrenze 10000
337 Angebote bundesweit, 93 Bildungsgutschein-fähig (28 %)

  Bundesland                   Angebote
  Baden-Württemberg (BAW)        69
  Nordrhein-Westfalen (NRW)      53
  Bayern (BAY)                   47
  Hessen (HES)                   28
  Sachsen (SAC)                  24
  Rheinland-Pfalz (RPF)          18
  Berlin (BER)                   17
  Niedersachsen (NDS)            17
  Thüringen (THÜ)                15
  Sachsen-Anhalt (SAN)           13
  … 6 weitere: MBV 11 · SLH 7 · BRE 6 · BRA 4 · SAA 1 · HAM 0
  (die 16 Länder ergeben zusammen 330 der 337)

Fazit: ein kleiner Markt, über das ganze Land verteilt; Baden-Württemberg, NRW und Bayern stellen
die Hälfte aller Angebote. Bundesweit ist gut ein Viertel gutscheinfähig. Hamburg führt unter
dieser ID nichts.
```

Als Nächstes angeboten: der Gutschein-Anteil je Bundesland, die Auswahlliste für eine Region
(ausbildung-finder) oder eine Zusammenfassung eines Angebots.

## ausbildung-offer-brief

> Eine Zusammenfassung von Angebot 153387597: Welche Voraussetzungen gelten, und wird es gefördert?

```bash
[ -n "$AUSBILDUNGSSUCHE_API_KEY" ] && echo "key set" || echo "no key"   # no key: obtain-key wie oben
ausbildungssuche --compact details 153387597
```

Der Datensatz ist ein Array mit einem Element. Das Kostenfeld ist leer, aber `kostenBemerkung` sagt,
dass die Schule kein Schulgeld erhebt, und die Liste `angebot.foerderung` nennt Schüler-BAföG und
den Bildungsgutschein. Telefon und E-Mail des Anbieters gehören zu seinem Dresdner Standort; der
Unterrichtsort liegt in Leipzig. Die Daten sind in Europe/Berlin-Zeit umgerechnet.

```
Erzieherin/Erzieher – Berufsausbildung
Anbieter: Heimerer Schulen · Hohmannstraße 7b, 04129 Leipzig, Sachsen
Form: Sonstige Präsenzveranstaltung, Vollzeit, 35–40 Std. pro Woche ·
  Dauer: mehr als 2 Jahre bis 3 Jahre (berufsbegleitend: vier Jahre)
Termine: 2027-08-23 bis 2030-07-12 (fester Beginn, kein Anmeldeschluss angegeben)
Kosten: schulgeldfrei – förderfähig ✓

Inhalte
  • Pflichtbereich: Deutsch, Englisch, Wirtschafts- und Sozialpolitik, Mathematik
  • Berufsbezogener Bereich: pädagogische Beziehungen und Gruppenprozesse, Lebenswelten von Kindern
    und Jugendlichen, Bildungs- und Entwicklungsprozesse, Kreativität, besondere Lebenssituationen,
    Erziehungspartnerschaften, Teamarbeit und Qualität; eine Facharbeit
  • Wahlpflicht: kreatives Gestalten, Yoga, EDV; Wahlbereich Schwerpunkt Heilpädagogik (Leipzig)
  • Projekte: Erste Hilfe, Säuglingspflege; drei Praktika in sozialpädagogischen Einrichtungen

Zugangsvoraussetzungen
  Regelt jedes Bundesland selbst; überall ein Realschulabschluss und ein Berufsabschluss, oder die
  Fachoberschule Gesundheit und Soziales.

Abschluss: Erzieherin/Erzieher, nach schriftlicher, mündlicher und praktischer Abschlussprüfung
Förderung: Schüler-BAföG, Bildungsgutschein (laut Kostenhinweis auch Meister-BAföG, WeGebAU)
Kontakt: http://www.heimerer.de · dresden@heimerer.de · 0351 8921950
Datensatz aktualisiert 2026-09-16
```

Als Nächstes angeboten: Vergleich mit den beiden anderen gutscheinfähigen Leipziger Angeboten
(192018451, 80081437).
