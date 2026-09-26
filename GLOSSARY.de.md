# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`ausbildungssuche-cli` verwendet werden. Die Domäne ist der bundesweite Katalog für
**Ausbildungs- und Berufsbildungsangebote**; dieses Glossar nennt den englischen Begriff
aus CLI und Bibliothek neben dem deutschen Original und entschlüsselt die knappen,
abgekürzten Abfrageparameter der API.

> **Spickzettel für Suchparameter.** Die API benennt ihre Abfrageparameter mit kurzen
> deutschen Abkürzungen. Die CLI stellt sie als gleichnamige Flags bereit, die Zuordnung
> ist also eins zu eins:
>
> | API-Parameter / Flag | Bedeutung |
> | --- | --- |
> | `sw` | Suchwort (von der API derzeit ignoriert) |
> | `sty` | Suchtyp – Angebots- bzw. Suchart (`0`..`3`) |
> | `orte` | Ort (`Name_lon_lat`) |
> | `re` | Region – Ländercode |
> | `uk` | Umkreis – Suchradius (km oder `Bundesweit`) |
> | `ids` | Berufs-id(s) – Kennung(en) des Berufs |
> | `bart` | Bildungsart |
> | `bg` | Bildungsgutschein – Filter nach Bildungsgutschein |
> | `bt` | Beginntermin – Code für den Beginn (`2`, `101`..`112`; kein Datum) |
> | `page` | Seitenindex, beginnend bei 0 |
> | `size` | Seitengröße (`1`..`2000`; der Server liefert höchstens 20) |

---

## Der Dienst & die API

**Ausbildungssuche.** Der öffentliche Katalog der Bundesagentur für Arbeit mit Ausbildungs-
und Berufsbildungsangeboten (*Ausbildungsangebote*), online im Portal der Behörde
durchsuchbar und über die REST-API bereitgestellt, die dieses Tool kapselt.

**Bundesagentur für Arbeit (BA).** Die Bundesbehörde, die den Dienst Ausbildungssuche und
seine API betreibt.

**Ausbildungssuche-API.** Der REST-Dienst unter
`rest.arbeitsagentur.de/infosysbub/absuche`. Er gehört zur Dienstefamilie
`infosysbub` (Informationssystem Bildung und Beruf) der Behörde;
`absuche` ist die Komponente Ausbildungssuche. Dokumentiert unter
[ausbildungssuche.api.bund.dev](https://ausbildungssuche.api.bund.dev/).

**X-API-Key.** Ein statischer, öffentlich dokumentierter API-Schlüssel
, der bei jeder Anfrage erforderlich ist. Er ist **nicht mitgeliefert** – mit `obtain-key` abrufen oder
übergeben Sie ihn per `--api-key`, über die Umgebungsvariable `AUSBILDUNGSSUCHE_API_KEY` oder
die Client-Option `apiKey`; andernfalls entfällt der Header, und der Dienst antwortet mit
`401`/`403`. Ein leerer oder nur aus Leerzeichen bestehender Schlüssel gilt als nicht
vorhanden (es wird kein Header gesendet). Für CI und Live-Tests lässt sich der öffentliche
Schlüssel separat abrufen (nie aus der CLI heraus) – mit
dem CLI-Befehl `obtain-key` abrufen (`npm run obtain-key`).

---

## Ressourcen / Endpoints

**Ausbildungsangebot.** Die zentrale Ressource – ein einzelnes Ausbildungs- bzw.
Bildungsangebot. Die API stellt es über zwei Endpoints bereit:

**Suche (`/pc/v1/ausbildungsangebot`).** Die Sammlung für die Angebotssuche. Akzeptiert
die oben genannten Suchparameter und liefert eine HAL+JSON-Hülle. Ausgeliefert als
`application/hal+json`; auf einen einfachen `Accept`-Header `application/json` antwortet
sie mit `406`, daher fordert der Client ausdrücklich HAL an. CLI: `search`. Bibliothek: `client.search()`.

**Details (`/pc/v1/ausbildungsangebot/{id}`).** Der vollständige Datensatz zu einem Angebot
per ID. Dieser Endpoint liefert `application/json` (und antwortet umgekehrt mit `406` auf
einen HAL+JSON-`Accept`), daher fordert der Client hier einfaches JSON an. CLI: `details <id>`.
Bibliothek: `client.details(id)`.

---

## Hülle der Suchergebnisse (HAL+JSON)

**HAL+JSON.** Hypertext Application Language auf Basis von JSON – der Medientyp, den der
Such-Endpoint liefert. Ein HAL-Dokument enthält die Nutzdaten sowie Hypermedia-Metadaten in
den reservierten Elementen `_embedded` und `_links`.

**`_embedded`.** Der Container mit den eingebetteten Angebotsobjekten eines Suchergebnisses.
Angebote sind groß und tief verschachtelt, deshalb behält der Client sie als unveränderte
rohe JSON-Objekte, statt sie auf einen Teiltyp einzuschränken.

**`_links`.** HAL-Hypermedia-Links (self, nächste/vorherige Seite usw.). Eine Angebots-ID,
die aus einem `_links`-href kopiert wurde, kann bereits prozentkodiert sein; der Client
erkennt das und kodiert sie beim Aufbau des Detail-Pfads nicht doppelt.

**`page` (PageInfo).** HAL-Metadaten zur Paginierung eines Suchergebnisses:
`size`, `totalElements`, `totalPages` und `number` (die aktuelle Seite, beginnend bei 0).
`totalElements` ist auf `10000` gedeckelt: Eine breite Abfrage meldet genau `10000`, also
„10000 oder mehr“, und nur diese ersten 10000 Ergebnisse lassen sich durchblättern.

---

## Kennungen

**Angebots-ID.** Die Kennung eines einzelnen Ausbildungsangebots, übergeben an
`details <id>`. Angebots-IDs sind numerisch; alles andere lehnt die CLI ab (Exit `2`,
bevor eine Anfrage gesendet wird), und die Bibliothek lehnt eine leere ID sowie eine
`.`/`..`-ID (auch prozentkodiert) mit einem Validierungsfehler ab.

**Ort (`orte`).** Der Ort, auf den eine Suche eingegrenzt wird, geschrieben als
`Name_lon_lat` mit dem **Längengrad zuerst**, z. B. `Köln_6.957_50.938`. Steht der
Breitengrad vorn, liefert die API stillschweigend 0 Treffer. Bei einer Ortssuche trägt
jedes Angebot seine Entfernung vom Ort in `abstaende[].abstandInKm`. Ein Ort grenzt die
Suche nur zusammen mit einem Umkreis (`uk`) ein; allein ergänzt er nur die Entfernungen,
daher verlangt die CLI neben `--orte` auch `--uk`.

**Berufs-ID (`ids`).** Kennung(en) eines Berufs, auf den eine Suche eingegrenzt
wird: die `dkzId` in `angebot.systematiken[]` eines Angebots (z. B. `9162`,
Staatlich anerkannter Erzieher). Mehrere IDs lassen sich durch Kommas trennen. Das ist
der einzige funktionierende Berufsfilter: Das Suchwort `sw` ignoriert die API.

**Regions- bzw. Ländercode (`re`).** Der dreistellige Code eines Bundeslands, auf das eine Suche
eingegrenzt wird: `BAW`, `BAY`, `BER`, `BRA`, `BRE`, `HAM`, `HES`, `MBV`, `NDS`, `NRW`,
`RPF`, `SAA`, `SAC`, `SAN`, `SLH`, `THÜ`. Mehrere Codes lassen sich durch Kommas trennen.
Den Code eines Angebots enthält `adresse.ortStrasse.land.code`; die zweistelligen
Abkürzungen (z. B. `BW`) führen zu HTTP 400, daher lehnt die CLI jeden anderen Code ab
(Exit `2`); einen kleingeschriebenen schreibt sie groß (`nrw` → `NRW`).

---

## Filterwerte, Einheiten & Enums

**Angebotstyp (`sty`).** Ein kleiner ganzzahliger Code `0`..`3`, der die Art des
Angebots bzw. der Suche auswählt. Den Wert `4` lehnt die API mit HTTP 400 ab;
die CLI lehnt alles außerhalb von `0`..`3` ab (Exit `2`).

**Umkreis (`uk`).** Der Suchradius um den Ort in **Kilometern** – `10`, `25`, `50` oder
`100` – oder die Zeichenkette `Bundesweit`, um ohne Radiusbegrenzung im ganzen Land zu
suchen. Andere Werte (z. B. `30`, `150`, `200`) führen zu HTTP 400, daher lehnt die CLI sie ab
(Exit `2`); `bundesweit` in beliebiger Schreibweise wird als `Bundesweit` gesendet. Ein Umkreis in
Kilometern braucht einen Ort (`orte`): ohne ihn ignoriert die API den Umkreis, daher lehnt
die CLI `--uk 25` ohne `--orte` ab.

**Bildungsart (`bart`).** Die Kategorie der gesuchten Ausbildung bzw. Bildung.

**Bildungsgutschein (`bg`).** Ein boolescher Filter, der die Ergebnisse auf Angebote
beschränkt, die mit einem *Bildungsgutschein* gefördert werden können – einem staatlich
ausgegebenen Gutschein, der eine zugelassene Bildungsmaßnahme finanziert.

**Beginntermin (`bt`).** Ein Code für den gewünschten Beginn der Ausbildung, kein Datum:
Laut der Beschreibung der Upstream-API bedeutet `2` frühere Termine und `101`..`112`
Januar..Dezember des Folgejahres. `0` und `1` werden ebenfalls akzeptiert (ihre Bedeutung
ist nicht dokumentiert); jeder andere Wert führt zu HTTP 400, daher lehnt die CLI ihn ab
(Exit `2`). Mehrere Codes können kommagetrennt angegeben werden.

**Seite (`page`).** Seitenindex, beginnend bei 0, zum Blättern durch die Suchergebnisse.
Die API liefert höchstens 10000 Ergebnisse einer Abfrage, daher darf `(page + 1) × size`
höchstens `10000` sein (bei der Standardgröße 20 ist die letzte Seite `499`); eine spätere
Seite führt zu HTTP 500, daher lehnt die CLI sie ab (Exit `2`).

**Seitengröße (`size`).** Anzahl der Ergebnisse pro Seite, eine ganze Zahl `1`..`2000`.
`MAX_PAGE_SIZE` ist `2000`; der Server ersetzt `size=0` stillschweigend (durch 20) und
ignoriert zu große Werte, daher lehnt die CLI alles außerhalb von `1..2000` vorab ab.
Tatsächlich liefert der Server höchstens **20** Zeilen pro Seite: Eine größere `size`
kommt als `page.size` 20 zurück.

---

## Exit-Codes

**Exit-Codes.** Die CLI bildet Ergebnisse auf Prozess-Exit-Codes ab: `0` bei Erfolg;
`2` bei Aufruf- bzw. Argumentvalidierungsfehlern; `3` bei `401`/`403` (Anfrage abgelehnt,
oft wegen des API-Schlüssels); `4` bei `404`; `5` bei `406` (Aushandlung über `Accept`
fehlgeschlagen); `6` bei einem Netzwerk- oder Transportfehler (DNS, Verbindung, Timeout,
Obergrenze der Antwortgröße); `1` bei allen anderen Fehlern. `--help`/`--version` liefern `0`.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `AusbildungssucheClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder – stehen jetzt in **[DEVELOPING.md](DEVELOPING.md)**.
