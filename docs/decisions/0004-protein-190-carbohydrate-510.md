# 0004. Protein is 190 g and carbohydrate 510 g; 210 g and the 185 g floor are retired tokens

- **Status:** accepted
- **Date:** 2026-08-26
- **Deciders:** the protein-architecture council; David ratified
- **Tenet invoked:** none

## Context

The gain phase ran at 3,700 kcal with a 215 g protein ceiling, which the targets note
calls a grocery-spend ceiling and not a health line. The generator was overshooting
protein on 34 of 35 days because the floor had fallen back to `protein minus 25` after a
council ordered `proteinFloor` deleted and the data complied. Separately, 210 g was still
live in five places five days after 190 g had been wired.

## Options considered

- **Keep 210 g and patch the floor.** Leaves the overshoot's cause (protein-dense bank,
  no carbohydrate lever) in place.
- **190 g protein, 510 g carbohydrate, the floor read from the targets file.** Moves the
  calories to carbohydrate and gives the composer room.

## Decision

Protein 190 g, carbohydrate 510 g. 210 g and the 185 g floor are retired and must not
reappear in either repo. Any automation found running on a number below the plan's own
floor is a defect.

## Consequences

Days land inside the ceiling; bought protein fell from 234 g to 199 g a day.

**What gets worse:** the ceiling now binds hard when a low-protein calorie carrier is
removed (the smoothie, 2026-09-13), which is why the starch-side build is queued; and a
retired number has to be hunted in data files as well as code.
