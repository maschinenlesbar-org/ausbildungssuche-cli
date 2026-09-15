# Examples

Real examples for the Claude Code skills of the `ausbildungssuche` plugin, one per skill: a request,
the `ausbildungssuche` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `ausbildungssuche` 0.0.5.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [ausbildung-finder](#ausbildung-finder) · [ausbildung-market-scan](#ausbildung-market-scan) · [ausbildung-offer-brief](#ausbildung-offer-brief)

## ausbildung-finder

> I want to retrain as a state-certified Erzieher near Leipzig. What is on offer that a Bildungsgutschein would pay for?

```bash
export AUSBILDUNGSSUCHE_API_KEY=infosysbub-absuche
ausbildungssuche --compact search --sw Erzieher --orte "Leipzig_12.374_51.340" --uk 25 --bg --size 20   # 1207 hits, no Erzieher course among them
ausbildungssuche --compact search --orte "Leipzig_12.374_51.340" --uk 25 --bg --size 1                  # also 1207: the keyword changes nothing
ausbildungssuche --compact search --orte "Leipzig_12.374_51.340" --uk 25 --bg --bart 102 --size 20      # 154; two Erzieher offers carry dkzId 9162
ausbildungssuche --compact search --ids 9162 --orte "Leipzig_12.374_51.340" --uk 25 --bg --size 20      # 2
ausbildungssuche --compact search --ids 9162 --orte "Leipzig_12.374_51.340" --uk 50 --bg --size 20      # 3
ausbildungssuche --compact search --ids 9162 --orte "Leipzig_12.374_51.340" --uk 50 --size 20           # 8 without the voucher filter
```

`--sw Erzieher` returned the same 1,207 offers in the same order as no keyword at all (Word/Excel
basics, IHK exam prep). So the skill took the occupation id from `angebot.systematiken[].dkzId`
(9162, `B 83113-90000`) and filtered with `--ids`, widening to 50 km when 25 km gave only two.
Distances are the API's `abstaende[].abstandInKm`; the offers' own coordinates are just the town centre.

```
Erzieher training within 50 km of Leipzig, Bildungsgutschein-eligible — 3 of 8 offers

  Title                                      Provider                                    Town                          km    Start
  Erzieher/in                                Ludwig Fresenius Schulen                    Leipzig, Sachsen               3.1  2027-08-01
  Staatlich anerkannte/r Erzieher/in         Aus- & WeiterbildungsSchulen des VMKB e.V.  Leipzig, Sachsen               5.4  rolling (run began 2025-08-11)
  Staatlich anerkannte Erzieher:in -         WBS TRAINING SCHULEN gGmbH                  Halle (Saale), Sachsen-Anhalt 31.4  2027-08-01
    Bachelor Professional in Sozialwesen

  All three: full-time (Vollzeit), mehr als 2 Jahre bis 3 Jahre, funding ✓.
  ids: 192018451 · 80081437 · 396148851

Not voucher-eligible (5): Bernd Blindow Gruppe, Leipzig 2.5 km · Euro Akademie Halle 29.7 km ·
IWK Institut für Weiterbildung …, Halle 29.7 km (starts 2027-09-01) · Euro Akademie Altenburg 40.5 km ·
Euro Akademie Rochlitz 43 km
```

Next steps offered: a full briefing on any of the three (ausbildung-offer-brief), or a nationwide search.

## ausbildung-market-scan

> Where in Germany can you train as a state-certified Erzieher, and how much of it does a Bildungsgutschein cover?

```bash
export AUSBILDUNGSSUCHE_API_KEY=infosysbub-absuche
ausbildungssuche --compact search --sw Erzieher --re SAC --size 1 | jq '.page.totalElements'    # 6991 = every offer in Sachsen
ausbildungssuche --compact search --ids 9162 --uk Bundesweit --size 1 | jq '.page.totalElements'        # 319
ausbildungssuche --compact search --ids 9162 --uk Bundesweit --bg --size 1 | jq '.page.totalElements'   # 83
ausbildungssuche --compact search --orte "Frankfurt_8.682_50.110" --uk 10 --size 5   # land.code HES; same for Bremen (BRE), Rostock (MBV)
for re in BAW BAY BER BRA HAM NDS NRW RPF SAA SAC SAN SLH THÜ HES BRE MBV; do   # each with and without --bg
  ausbildungssuche --compact search --ids 9162 --re "$re" --size 1 | jq '.page.totalElements'
done
ausbildungssuche --compact search --ids 9162 --re BAW --size 20 --page 0   # pages 0–3, all 68 offers
```

The keyword is ignored by the API, so the skill counted by occupation id 9162 instead. The skill's
list of 12 region codes misses four states; their codes were read from `adresse.ortStrasse.land.code`
in sample results. The provider tally paged through all of Baden-Württemberg, since pages stop at 20 rows.

```
State-certified Erzieher training (dkzId 9162) by Bundesland — no cell near the 10000 cap
319 offers nationwide, 83 Bildungsgutschein-eligible (26 %)

  Bundesland                   Offers   BG-eligible
  Baden-Württemberg (BAW)        68       12 (18 %)
  Nordrhein-Westfalen (NRW)      49        6 (12 %)
  Bayern (BAY)                   48       19 (40 %)
  Hessen (HES)                   20       10 (50 %)
  Rheinland-Pfalz (RPF)          19        4
  Niedersachsen (NDS)            18        2
  Sachsen (SAC)                  18        8
  Berlin (BER)                   17        6
  Thüringen (THÜ)                14        6
  Sachsen-Anhalt (SAN)           13        3
  … 6 more: MBV 8/2 · BRE 7/4 · SLH 5/1 · BRA 2/0 · SAA 1/0 · HAM 0/0
  (the 16 states add up to 307 of the 319)

Baden-Württemberg, all 68 offers: 34 providers. DAA - Deutsche Angestellten-Akademie GmbH runs 13
(Aalen, Göppingen, Karlsruhe, Reutlingen, Stuttgart); no other provider has more than 3.
56 full-time, 12 part-time.

Read: a small market spread over many schools. Only a quarter is voucher-eligible nationally, but
half of Hessen's and 40 % of Bayern's offers are. Hamburg lists nothing under this occupation id.
```

Next steps offered: the shortlist for one region (ausbildung-finder) or a briefing on one offer.

## ausbildung-offer-brief

> Summarise offer 396148851 for me: what do I need to get in, and is it funded?

```bash
export AUSBILDUNGSSUCHE_API_KEY=infosysbub-absuche
ausbildungssuche --compact details 396148851
```

The record is a one-element array. Its scheme list `angebot.foerderung` is `null`, so the funding
verdict comes from the Termin's `foerderung: true`. The provider address is the Berlin head office;
the venue is in Halle. Dates were converted in Europe/Berlin time (in UTC the start reads 31 July).

```
Staatlich anerkannte Erzieher:in - Bachelor Professional in Sozialwesen — Berufsausbildung
Provider: WBS TRAINING SCHULEN gGmbH · Franckestraße 15, 06110 Halle (Saale), Sachsen-Anhalt
Format: Präsenzunterricht, Vollzeit, Mon–Fri 08.00–15.00 · Duration: mehr als 2 Jahre bis 3 Jahre
Dates: 2027-08-01 to 2030-07-31 (fixed start, no deadline given)
Cost: not stated — funding-eligible ✓

What you'll learn
  • General (480 h): Deutsch/Kommunikation 160, Englisch 160, Wirtschafts- und Sozialkunde 80, Religion oder Ethik 80
  • Field-specific (2,160 h): Erziehungswissenschaften 480, Sozialpädagogische Theorie und Praxis 360,
    Organisation, Recht und Verwaltung 80
  • Didactics: Musik 280, Schriftkultur/Sprache 240, Körper/Bewegung 160, Spiel 160, Gestalten 160,
    Mathematik/Naturwissenschaften 120, Ökologie/Gesundheit 80, Wahlpflicht 40
  • Berufspraktische Ausbildung: 12 weeks

Entry requirements (one of)
  • Realschulabschluss + 2-year relevant vocational training
  • Realschulabschluss + 2-year other vocational training + at least 600 h in a social-pedagogical setting
  • Realschulabschluss without training + 4 years of relevant work
  • Fachoberschule, Fachrichtung Sozialwesen
  • Allgemeine Hochschulreife + 1 year of relevant work

Qualification: staatliche Prüfung → Staatlich anerkannte Erzieher:in - Bachelor Professional in Sozialwesen
Leads to: Krippen, (Integrations-)Kindergärten, Hort, Kinderheime, Kinder- und Jugendhilfe …
Apply / info: https://www.wbs-schulen.de/fachschule-fuer-sozialwesen-halle-saale-ausbildung-erzieher-in-staatlich-geprueft/
Record updated 2026-08-24
```

Next steps offered: compare with the two voucher-eligible Leipzig offers (192018451, 80081437).
