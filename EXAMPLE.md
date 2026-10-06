# Examples

Real examples for the Claude Code skills of the `ausbildungssuche` plugin, one per skill: a request,
the `ausbildungssuche` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026 with `ausbildungssuche` 0.2.0.
The data changes, so your results will differ; the ids shown work for trying the requests
yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [ausbildung-finder](#ausbildung-finder) · [ausbildung-market-scan](#ausbildung-market-scan) · [ausbildung-offer-brief](#ausbildung-offer-brief)

## ausbildung-finder

> I want to retrain as a state-certified Erzieher near Leipzig. What is on offer that a Bildungsgutschein would pay for?

```bash
[ -n "$AUSBILDUNGSSUCHE_API_KEY" ] && echo "key set" || echo "no key"   # no key
ausbildungssuche obtain-key                                             # the public key, kept for the later calls
for p in 0 1 2 3 4; do                                                  # 186 offers; dkzId 9162 turned up on page 3
  ausbildungssuche --compact search --orte "Leipzig_12.374_51.340" --uk 25 --bg --bart 102 --size 20 --page "$p"
done
ausbildungssuche --compact search --ids 9162 --orte "Leipzig_12.374_51.340" --uk 25 --bg --size 20   # 3
ausbildungssuche --compact search --ids 9162 --orte "Leipzig_12.374_51.340" --uk 25 --size 20        # 4 without the voucher filter
```

No key was set in the environment, so the skill obtained the public one and put it on every later
call (the commands above leave that prefix out). The keyword `--sw` filters nothing, so the skill
looked for the occupation id instead: it sampled Berufsausbildung offers near Leipzig and found
`dkzId` 9162 (Staatlich anerkannter Erzieher/Staatlich anerkannte Erzieherin) on the fourth page
(page 3),
then filtered with `--ids`. Distances are the API's `abstaende[].abstandInKm`; dates are in
Europe/Berlin time.

```
Erzieher training within 25 km of Leipzig, Bildungsgutschein-eligible — 3 of 4 offers

  Title                                Provider                                    Town (km)        Start
  Erzieher/in                          Ludwig Fresenius Schulen                    Leipzig (3.1)    2027-08-01
  Erzieherin/Erzieher                  Heimerer Schulen                            Leipzig (3.6)    2027-08-23
  Staatlich anerkannte/r Erzieher/in   Aus- & WeiterbildungsSchulen des VMKB e.V.  Leipzig (5.4)    rolling (run began 2025-08-11)

  All three: Berufsausbildung, full-time (Vollzeit), mehr als 2 Jahre bis 3 Jahre, funding ✓.
  ids: 192018451 · 153387597 · 80081437

Not voucher-eligible (1): Erzieher Ausbildung, Bernd Blindow Gruppe, Leipzig 2.5 km, starts 2027-08-01.
```

Next steps offered: a full briefing on any of the three (ausbildung-offer-brief), or a wider radius.

## ausbildung-market-scan

> Where in Germany can you train as a state-certified Erzieher (dkzId 9162), state by state, and how much of it does a Bildungsgutschein cover?

```bash
[ -n "$AUSBILDUNGSSUCHE_API_KEY" ] && echo "key set" || echo "no key"   # no key: obtain-key as above
ausbildungssuche --compact search --ids 9162 --uk Bundesweit --size 1 | jq '.page.totalElements'        # 337
ausbildungssuche --compact search --ids 9162 --uk Bundesweit --bg --size 1 | jq '.page.totalElements'   # 93
for re in BAW BAY BER BRA BRE HAM HES MBV NDS NRW RPF SAA SAC SAN SLH THÜ; do
  ausbildungssuche --compact search --ids 9162 --re "$re" --size 1 | jq '.page.totalElements'
done
```

The skill held the occupation id constant and swept `--re` over the 16 three-letter `land.code`
values, reading `page.totalElements` each time; the national figures come from runs without
`--re`. Hamburg answered 0 offers, and the CLI added a note on stderr that an unknown `--ids` value
would also give an empty result — here the id is valid, Hamburg just lists nothing under it. To
keep the request count down, the voucher share is national only.

```
State-certified Erzieher training (dkzId 9162) by Bundesland — no cell near the 10000 cap
337 offers nationwide, 93 Bildungsgutschein-eligible (28 %)

  Bundesland                   Offers
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
  … 6 more: MBV 11 · SLH 7 · BRE 6 · BRA 4 · SAA 1 · HAM 0
  (the 16 states add up to 330 of the 337)

Read: a small market spread across the country; Baden-Württemberg, NRW and Bayern list half of
all offers. Just over a quarter is voucher-eligible nationally. Hamburg lists nothing under this id.
```

Next steps offered: the voucher share per state, the shortlist for one region (ausbildung-finder),
or a briefing on one offer.

## ausbildung-offer-brief

> Summarise offer 153387597 for me: what do I need to get in, and is it funded?

```bash
[ -n "$AUSBILDUNGSSUCHE_API_KEY" ] && echo "key set" || echo "no key"   # no key: obtain-key as above
ausbildungssuche --compact details 153387597
```

The record is a one-element array. The cost field is empty, but `kostenBemerkung` says the school
charges no fees, and the scheme list `angebot.foerderung` names Schüler-BAföG and the
Bildungsgutschein. The provider's phone and e-mail are its Dresden office; the venue is in Leipzig.
Dates were converted in Europe/Berlin time.

```
Erzieherin/Erzieher — Berufsausbildung
Provider: Heimerer Schulen · Hohmannstraße 7b, 04129 Leipzig, Sachsen
Format: Sonstige Präsenzveranstaltung, Vollzeit, 35–40 h a week ·
  Duration: mehr als 2 Jahre bis 3 Jahre (part-time alongside work: four years)
Dates: 2027-08-23 to 2030-07-12 (fixed start, no deadline given)
Cost: no school fees ("schulgeldfrei") — funding-eligible ✓

What you'll learn
  • Core subjects: Deutsch, Englisch, Wirtschafts- und Sozialpolitik, Mathematik
  • Professional field: pedagogical relationships and group processes, children's and young
    people's living environments, education and development processes, creativity, special life
    situations, educational partnerships, teamwork and quality; a final paper (Facharbeit)
  • Electives: creative design, yoga, IT; optional focus Heilpädagogik (Leipzig)
  • Projects: first aid, infant care; three work placements in social-pedagogical settings

Entry requirements
  Set by each Bundesland; everywhere a Realschulabschluss plus a vocational qualification, or the
  Fachoberschule in Gesundheit und Soziales.

Qualification: Erzieherin/Erzieher, after a written, oral and practical final examination
Funding options: Schüler-BAföG, Bildungsgutschein (also Meister-BAföG, WeGebAU per the cost note)
Contact: http://www.heimerer.de · dresden@heimerer.de · 0351 8921950
Record updated 2026-09-16
```

Next steps offered: compare with the two other voucher-eligible Leipzig offers (192018451, 80081437).
