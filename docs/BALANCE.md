# Balance

## Philosophy

Realistic consequences, simplified interfaces. Engineering choices create
strategy, not chores. **No anti-box debuff**: thick armor loses through its
real consequences — mass, drive demand, thermal trapping, cost, joint loads.

## Scrap Points (SP)

Every part and wire costs SP. Lobby presets: Light 700 / Standard 1000 /
Heavy 1400. Part limit 30–120 (default 120).

## Cost/mass reference (current tuning — telemetry will drive changes)

| Category | Examples | Cost | Notes |
|---|---|---|---|
| Frame | steel block 10 / beam 24 / bulkhead 30 | cheap | structure + hp |
| Armor | aluminum 12 / mild 20 / wedge 22 / hardened 45 | medium | hp 150–460 |
| Power | compact 40 (420 kJ) / hidisc 80 (520 kJ, 9.5 kW) / highcap 90 (1300 kJ) / supercap 60 | — | peak W vs energy trade-off |
| Control | core 60 (required) / controller 40 | — | controller = full regulated power |
| Drive | motors 50–90 + wheels 12–30 | — | grip vs durability |
| Weapons | drum 120 / bar 140 / saw 100 / lifter 130 | high | spin-up draw + heat |
| Cooling | heatsink 20 / fan 25 | low | vs heat gen of sustained loads |

Wires cost 5 SP each; gauge (light 2.6 kW / medium 6 kW / heavy 12 kW) is
chosen automatically by load type in the wire tool.

## Archetype goals

At least five viable archetypes: boxy rammer (mobility as offense), wedge +
vertical spinner, bar spinner glass cannon, tanky saw grinder, control-style
lifter/jaw. Power, heat, mass, CoG, joint stress must all matter for each.

## Guardrails

- Hazards default OFF. Advanced ordnance ships later, default OFF, separate
  milestone, high support cost.
- Battery depletion is never destruction — pure endurance builds can lose
  offense but stay in the fight as targets.
- Balance changes come after telemetry: inspect mass, power, heat, stress and
  match-event data before touching numbers. Keep balance PRs separate from
  engine PRs.
