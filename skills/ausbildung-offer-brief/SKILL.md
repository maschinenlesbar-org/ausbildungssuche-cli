---
name: ausbildung-offer-brief
description: >
  Fetch one apprenticeship/training offer by id and turn its deeply nested,
  HTML-laden record into a clean human briefing using the ausbildungssuche-cli.
  Trigger when the user has an offer id and asks "what's offer 365241044?", "tell
  me about this Ausbildung", "summarise this training offer", "how much does it
  cost / is it Bildungsgutschein-funded?", "who's the provider and how do I apply?",
  or pastes an id from a search result. Decodes dates, HTML fields, funding and
  contact info the raw JSON buries.
version: 1.0.0
userInvocable: true
---

# Ausbildung Offer Brief

Take a single offer `id` and produce a **readable one-page briefing** — title, provider,
type, where & when, cost & funding, entry requirements, how to apply — from the
`details` endpoint's verbose, HTML-embedded JSON.

## Tooling

This skill drives the `ausbildungssuche` command. **Before anything else, validate it is available** — run `command -v ausbildungssuche` (or `ausbildungssuche --version`). If it is not on your PATH, STOP and inform the user that the `ausbildungssuche` CLI (`@maschinenlesbar.org/ausbildungssuche-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**An API key is required and NOT bundled** (no key → `403`, exit `3`). It's a static,
public value — `infosysbub-absuche` — supply via env or flag:

```bash
export AUSBILDUNGSSUCHE_API_KEY=infosysbub-absuche
```

Use `--compact`.

## Step 1 — Get an id

The id comes from a `search` result (`_embedded.termine[].id`) or directly from the user.
If you don't have one, run an ausbildung-finder search first. **Don't pass an empty id** —
the CLI rejects it client-side (exit `2`) before any request.

## Step 2 — Fetch the record

```bash
ausbildungssuche --compact details 365241044
```

> **The detail endpoint returns a JSON *array*, not the search envelope.** It's
> `[ { …offer… } ]` — read element `[0]`. (Search returns `_embedded.termine`; details
> returns a bare array. Don't reuse the search-shape parser.)
>
> A non-existent id returns **HTTP 404 → CLI exit `4`** ("not found"). Ids can change as
> the catalogue updates; if one 404s, re-fetch it from a fresh search.

## Step 3 — Read the record (`result[0]`)

The object is a *Termin* (a scheduled run) wrapping an *Angebot* (the offer). Map these to
the briefing — most user-facing detail lives under `angebot`, and **several fields are HTML
strings** (`<p>`, `<ul><li>` …) that must be stripped to plain text:

| Path | Briefing field | Notes |
|---|---|---|
| `angebot.titel` | Title | — |
| `angebot.bildungsanbieter.name` | Provider | |
| `angebot.bildungsanbieter.homepage` / `.email` / `telefonVorwahl`+`telefonDurchwahl` | Contact | concatenate Vorwahl+Durchwahl for the phone number |
| `angebot.bildungsart.bezeichnung` | Type | Berufsausbildung / Fortbildung / Grundqualifikation |
| `angebot.inhalt` | What you'll learn | **HTML** — strip tags, keep the bullet list as plain lines |
| `angebot.abschlussbezeichnung` / `abschlussart` | Qualification gained | **HTML** |
| `angebot.zugang` | Entry requirements | **HTML** |
| `angebot.zielgruppe` | Who it's for | **HTML** |
| `angebot.foerderung` | Funding (free text) | **HTML** — lists eligible funding schemes (Bildungsgutschein, Reha, DRV …) |
| `angebot.link` | Apply / info URL | the provider's enrolment link |
| `adresse.bezeichnung` / `.strasse` / `adresse.ortStrasse.{plz,name}` | Location | venue address |
| `adresse.ortStrasse.land.name` | Bundesland | |
| `adresse.hinweise` | Directions / contact notes | **HTML**, optional |
| `beginn` / `ende` | Start / end date | **epoch milliseconds** — convert with `new Date(ms)`; `null` = not fixed |
| `individuellerEinstieg` | Rolling entry | `true` = start anytime |
| `anmeldeschluss` | Application deadline | epoch ms or null |
| `dauer.bezeichnung` | Duration | |
| `unterrichtsform.bezeichnung` | Format | presence / online / blended |
| `unterrichtszeit` / `unterrichtszeiten` | Schedule | full-time / part-time |
| `kostenWert` / `kostenWaehrung` / `kostenBemerkung` | Cost | `kostenWert` is often `null`; the Termin-level boolean `foerderung` tells you if it's funding-eligible |
| `ansprechpartner` | Named contact | optional |

**HTML handling:** strip tags to plain text, turn `<li>` into bullet lines, decode entities
(`&reg;`, `&amp;`, `&nbsp;`). Never paste raw HTML at the user.

## Step 4 — Write the briefing

```
Mechatroniker — Berufsausbildung
Provider: COMCAVE.COLLEGE GmbH  ·  Sankt Augustin (53757), NRW
Format: blended  ·  Duration: > 1 month  ·  Starts: 2026-10-13 (or rolling)
Cost: not stated — eligible for Bildungsgutschein ✓

What you'll learn
  • …(from inhalt, as bullets)…

Entry requirements
  …(from zugang)…

Qualification: Trägerinternes Zertifikat (from abschlussbezeichnung)

Funding options: Bildungsgutschein, Qualifizierungschancengesetz, … (from foerderung)

Apply / info: https://…    Contact: 0800 0010865 · email@provider.de
```

Rules:
- Lead with title, type, provider, town, start date, and the funding verdict — that's what
  a trainee decides on.
- Convert every epoch-ms date to `YYYY-MM-DD`; show "rolling start" when
  `individuellerEinstieg === true` or `beginn` is null.
- State cost honestly: if `kostenWert` is null, say "cost not stated" and report whether
  `foerderung === true` (funding-eligible) — don't imply free.
- Strip all HTML; keep `inhalt`/`zugang`/`zielgruppe` as short readable sections, not walls
  of markup.
- Surface the `angebot.link` and provider contact so the user can act.
- Omit empty/null fields rather than printing "null".
- Don't dump `angebot.systematiken[].suchworte` (can be 150+ synonym strings) — at most
  mention the occupation it classifies under.
