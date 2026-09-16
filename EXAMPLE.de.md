# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `ausbildungssuche`, eines pro Skill: eine
Anfrage, die `ausbildungssuche`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `ausbildungssuche` 0.0.5 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [ausbildung-finder](#ausbildung-finder) · [ausbildung-market-scan](#ausbildung-market-scan) · [ausbildung-offer-brief](#ausbildung-offer-brief)

## ausbildung-finder

> Umschulung zur staatlich anerkannten Erzieherin in der Nähe von Leipzig – welche Angebote werden über einen Bildungsgutschein gefördert?

```bash
eval "$(ausbildungssuche obtain-key --export)"
ausbildungssuche --compact search --sw Erzieher --orte "Leipzig_12.374_51.340" --uk 25 --bg --size 20   # 1207 Treffer, kein Erzieher-Kurs darunter
ausbildungssuche --compact search --orte "Leipzig_12.374_51.340" --uk 25 --bg --size 1                  # ebenfalls 1207: das Suchwort ändert nichts
ausbildungssuche --compact search --orte "Leipzig_12.374_51.340" --uk 25 --bg --bart 102 --size 20      # 154; zwei Erzieher-Angebote tragen dkzId 9162
ausbildungssuche --compact search --ids 9162 --orte "Leipzig_12.374_51.340" --uk 25 --bg --size 20      # 2
ausbildungssuche --compact search --ids 9162 --orte "Leipzig_12.374_51.340" --uk 50 --bg --size 20      # 3
ausbildungssuche --compact search --ids 9162 --orte "Leipzig_12.374_51.340" --uk 50 --size 20           # 8 ohne Gutschein-Filter
```

`--sw Erzieher` lieferte dieselben 1.207 Angebote in derselben Reihenfolge wie eine Suche ganz ohne
Suchwort (Word/Excel-Grundlagen, IHK-Prüfungsvorbereitung). Der Skill hat deshalb die Berufs-ID aus
`angebot.systematiken[].dkzId` genommen (9162, `B 83113-90000`), mit `--ids` gefiltert und auf 50 km
erweitert, weil 25 km nur zwei Treffer ergaben. Die Entfernungen stammen aus `abstaende[].abstandInKm`
der API; die Koordinaten der Angebote selbst sind nur die Ortsmitte.

```
Erzieher-Ausbildung im Umkreis von 50 km um Leipzig, Bildungsgutschein-fähig – 3 von 8 Angeboten

  Titel                                      Anbieter                                    Ort                             km    Beginn
  Erzieher/in                                Ludwig Fresenius Schulen                    Leipzig, Sachsen               3,1  2027-08-01
  Staatlich anerkannte/r Erzieher/in         Aus- & WeiterbildungsSchulen des VMKB e.V.  Leipzig, Sachsen               5,4  laufender Einstieg (Durchgang seit 2025-08-11)
  Staatlich anerkannte Erzieher:in -         WBS TRAINING SCHULEN gGmbH                  Halle (Saale), Sachsen-Anhalt 31,4  2027-08-01
    Bachelor Professional in Sozialwesen

  Alle drei: Vollzeit, mehr als 2 Jahre bis 3 Jahre, förderfähig ✓.
  IDs: 192018451 · 80081437 · 396148851

Nicht gutscheinfähig (5): Bernd Blindow Gruppe, Leipzig 2,5 km · Euro Akademie Halle 29,7 km ·
IWK Institut für Weiterbildung …, Halle 29,7 km (Beginn 2027-09-01) · Euro Akademie Altenburg 40,5 km ·
Euro Akademie Rochlitz 43 km
```

Als Nächstes angeboten: ein ausführliches Briefing zu einem der drei Angebote (ausbildung-offer-brief) oder eine bundesweite Suche.

## ausbildung-market-scan

> Wo in Deutschland kann man sich zur staatlich anerkannten Erzieherin ausbilden lassen, und wie viel davon ist über einen Bildungsgutschein förderfähig?

```bash
eval "$(ausbildungssuche obtain-key --export)"
ausbildungssuche --compact search --sw Erzieher --re SAC --size 1 | jq '.page.totalElements'    # 6991 = alle Angebote in Sachsen
ausbildungssuche --compact search --ids 9162 --uk Bundesweit --size 1 | jq '.page.totalElements'        # 319
ausbildungssuche --compact search --ids 9162 --uk Bundesweit --bg --size 1 | jq '.page.totalElements'   # 83
ausbildungssuche --compact search --orte "Frankfurt_8.682_50.110" --uk 10 --size 5   # land.code HES; ebenso Bremen (BRE), Rostock (MBV)
for re in BAW BAY BER BRA HAM NDS NRW RPF SAA SAC SAN SLH THÜ HES BRE MBV; do   # jeweils mit und ohne --bg
  ausbildungssuche --compact search --ids 9162 --re "$re" --size 1 | jq '.page.totalElements'
done
ausbildungssuche --compact search --ids 9162 --re BAW --size 20 --page 0   # Seiten 0–3, alle 68 Angebote
```

Die API ignoriert das Suchwort, deshalb hat der Skill über die Berufs-ID 9162 gezählt. Der Liste
der 12 Regionscodes im Skill fehlen vier Länder; ihre Codes stammen aus `adresse.ortStrasse.land.code`
in Stichproben. Für die Anbieterzählung wurden alle Seiten für Baden-Württemberg abgerufen, da eine
Seite höchstens 20 Einträge liefert.

```
Ausbildung zur staatlich anerkannten Erzieherin (dkzId 9162) nach Bundesland – kein Wert nahe der 10000-Grenze
319 Angebote bundesweit, davon 83 Bildungsgutschein-fähig (26 %)

  Bundesland                   Angebote   BG-fähig
  Baden-Württemberg (BAW)        68        12 (18 %)
  Nordrhein-Westfalen (NRW)      49         6 (12 %)
  Bayern (BAY)                   48        19 (40 %)
  Hessen (HES)                   20        10 (50 %)
  Rheinland-Pfalz (RPF)          19         4
  Niedersachsen (NDS)            18         2
  Sachsen (SAC)                  18         8
  Berlin (BER)                   17         6
  Thüringen (THÜ)                14         6
  Sachsen-Anhalt (SAN)           13         3
  … 6 weitere: MBV 8/2 · BRE 7/4 · SLH 5/1 · BRA 2/0 · SAA 1/0 · HAM 0/0
  (die 16 Länder ergeben zusammen 307 der 319)

Baden-Württemberg, alle 68 Angebote: 34 Anbieter. DAA - Deutsche Angestellten-Akademie GmbH stellt 13
(Aalen, Göppingen, Karlsruhe, Reutlingen, Stuttgart); kein anderer Anbieter hat mehr als 3.
56 Vollzeit, 12 Teilzeit.

Einordnung: ein kleiner Markt, verteilt auf viele Schulen. Bundesweit ist nur ein Viertel
gutscheinfähig, in Hessen aber die Hälfte und in Bayern 40 %. Hamburg führt unter dieser Berufs-ID nichts.
```

Als Nächstes angeboten: die Trefferliste für eine Region (ausbildung-finder) oder ein Briefing zu einem Angebot.

## ausbildung-offer-brief

> Eine Zusammenfassung von Angebot 396148851: Welche Voraussetzungen gelten, und wird es gefördert?

```bash
eval "$(ausbildungssuche obtain-key --export)"
ausbildungssuche --compact details 396148851
```

Der Datensatz ist ein Array mit einem Element. Die Liste der Förderprogramme `angebot.foerderung` ist
`null`, das Förderurteil stammt daher aus `foerderung: true` am Termin. Die Anbieteradresse ist der
Berliner Hauptsitz; unterrichtet wird in Halle. Die Daten wurden in Europe/Berlin-Zeit umgerechnet
(in UTC stünde der Beginn auf dem 31.07.).

```
Staatlich anerkannte Erzieher:in - Bachelor Professional in Sozialwesen – Berufsausbildung
Anbieter: WBS TRAINING SCHULEN gGmbH · Franckestraße 15, 06110 Halle (Saale), Sachsen-Anhalt
Form: Präsenzunterricht, Vollzeit, Mo–Fr 08.00–15.00 Uhr · Dauer: mehr als 2 Jahre bis 3 Jahre
Zeitraum: 2027-08-01 bis 2030-07-31 (fester Beginn, kein Anmeldeschluss angegeben)
Kosten: nicht angegeben – förderfähig ✓

Inhalte
  • Fachrichtungsübergreifend (480 Std.): Deutsch/Kommunikation 160, Englisch 160, Wirtschafts- und Sozialkunde 80, Religion oder Ethik 80
  • Fachrichtungsbezogen (2.160 Std.): Erziehungswissenschaften 480, Sozialpädagogische Theorie und Praxis 360,
    Organisation, Recht und Verwaltung 80
  • Didaktik/Methodik: Musik 280, Schriftkultur/Sprache 240, Körper/Bewegung 160, Spiel 160, Gestalten 160,
    Mathematik/Naturwissenschaften 120, Ökologie/Gesundheit 80, Wahlpflicht 40
  • Berufspraktische Ausbildung: 12 Wochen

Zugangsvoraussetzungen (eine davon)
  • Realschulabschluss + 2-jährige einschlägige Berufsausbildung
  • Realschulabschluss + 2-jährige nicht einschlägige Berufsausbildung + mind. 600 Std. Praxis in einer sozialpädagogischen Einrichtung
  • Realschulabschluss ohne Berufsausbildung + 4-jährige einschlägige Berufstätigkeit
  • Fachoberschule, Fachrichtung Sozialwesen
  • Allgemeine Hochschulreife + 1-jährige einschlägige Tätigkeit

Abschluss: staatliche Prüfung → Staatlich anerkannte Erzieher:in - Bachelor Professional in Sozialwesen
Einsatzfelder: Krippen, (Integrations-)Kindergärten, Hort, Kinderheime, Kinder- und Jugendhilfe …
Anmeldung / Info: https://www.wbs-schulen.de/fachschule-fuer-sozialwesen-halle-saale-ausbildung-erzieher-in-staatlich-geprueft/
Datensatz aktualisiert 2026-08-24
```

Als Nächstes angeboten: Vergleich mit den beiden gutscheinfähigen Leipziger Angeboten (192018451, 80081437).
