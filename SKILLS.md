# ausbildungssuche-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for
searching Germany's federal **apprenticeship and vocational-training** catalogue, all
powered by the **[ausbildungssuche](README.md)** CLI over the open
[Bundesagentur für Arbeit Ausbildungssuche API](https://ausbildungssuche.api.bund.dev/)
(`rest.arbeitsagentur.de/infosysbub/absuche`).

Each skill teaches Claude how to drive the `ausbildungssuche` CLI to answer a specific,
real-world question — "what apprenticeships can I do near Köln?", "what is offer
365241044?", "where is the most Pflege training?" — and to report the answer with
evidence rather than guesswork. They encode the parts that are easy to get wrong (the
backwards `Name_lon_lat` location string, the discrete radius set, the 3-letter region
codes, the 10000-result cap) so Claude doesn't have to rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **ausbildung-finder** | Searches offers near a place, dedupes the catalogue's near-duplicates, ranks by distance / start / funding, and enriches with town, date and Bildungsgutschein status. | "Ausbildung als Mechatroniker near Köln", "Umschulung within 50 km, Bildungsgutschein only" |
| **ausbildung-offer-brief** | Fetches one offer by id and turns its nested, HTML-laden record into a readable one-page briefing — provider, dates, cost/funding, entry requirements, how to apply. | "what's offer 365241044?", "summarise this training offer" |
| **ausbildung-market-scan** | Sweeps `page.totalElements` across regions / types / funding to profile the size and distribution of a training market, working around the 10000 cap. | "where is the most Pflege training?", "what share is Bildungsgutschein-funded?" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `ausbildungssuche` CLI** installed globally and on your PATH:
  ```bash
  npm i -g @maschinenlesbar.org/ausbildungssuche-cli   # installs the `ausbildungssuche` bin
  ```
- **An API key.** The Ausbildungssuche API requires a static `X-API-Key`, and it is
  **not bundled** with the CLI. It is a publicly-documented value — `infosysbub-absuche` —
  supplied via the `AUSBILDUNGSSUCHE_API_KEY` env var (preferred) or `--api-key`:
  ```bash
  export AUSBILDUNGSSUCHE_API_KEY=infosysbub-absuche
  ```
  Without it the service answers `403` (CLI exit `3`).

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/ausbildungssuche-cli
/plugin install ausbildungssuche@ausbildungssuche-skills
```

The first command registers the marketplace; the second installs the `ausbildungssuche`
plugin, which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/ausbildungssuche-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/ausbildung-finder/SKILL.md`. Start a new Claude Code session and the skills are
picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> What apprenticeships for Mechatroniker are there within 50 km of Köln, funded ones first?

> Give me a briefing on offer 365241044.

> Which Bundesland has the most Pflege training, and how much of it is Bildungsgutschein-funded?

You can also invoke a skill explicitly with its slash command, e.g. `/ausbildung-finder`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`ausbildungssuche` subcommands to call, in what order, and how to interpret the JSON. The
skills encode the non-obvious parts of this API, all verified against the live service:

- **the location string is `Name_lon_lat` — longitude FIRST**, not `Name_lat_lon` as the
  CLI help and README state. Getting it backwards silently returns **0 results** (no
  `_embedded` block), which masquerades as "nothing nearby" (see **ausbildung-finder**);
- **`--uk` accepts only `10`, `25`, `50`, `100`, `Bundesweit`** — `30`/`75`/`150`/`200`
  return HTTP 400. Out-of-range `--orte` coordinates make the server return HTTP 500;
- **`--re` wants the API's 3-letter `land.code`** (`BAW`, `BAY`, `BER`, `BRA`, `HAM`,
  `NDS`, `NRW`, `RPF`, `SAA`, `SAC`, `SLH`, `THÜ`), not the usual 2-letter abbreviation —
  `BW`/`BY`/`SH` 400. `--sty` is `0..3` (`4` 400);
- **`page.totalElements` caps at exactly 10000** — a broad query reports `10000` whether
  there are 10001 or a million, and you cannot page past that window (see
  **ausbildung-market-scan**);
- **keyword matching is very fuzzy** — even gibberish `--sw` returns ~10000 — so counts
  are upper bounds; lean on the structured filters;
- **`search` returns a HAL envelope** (`_embedded.termine[]`) but **`details` returns a
  bare JSON array** (`[ {…} ]`, read `[0]`); each item is a *Termin* wrapping an *Angebot*,
  with `beginn`/`ende` as **epoch milliseconds** and several fields (`inhalt`, `zugang`,
  `foerderung`) as **HTML strings** that must be stripped (see **ausbildung-offer-brief**).

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.
