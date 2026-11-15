# Siege of Cairo Hardpoint — session handoff

Saved so we can pick up tomorrow. Main script: [`Siege-of-Cairo-Hardpoint.ts`](../Siege-of-Cairo-Hardpoint.ts).

## Current tuneables

| Constant | Value | Notes |
|---|---|---|
| `CP_COUNT` | 10 | Rotating CPs `200–209`, sectors `300–309` |
| `CENTER_CP_ID` / `CENTER_SECTOR_ID` | 250 / 350 | One-shot opener, never returns |
| `ROTATE_SECONDS` | **90** | Was 120; COD Hardpoint is typically **60s** |
| `MATCH_TIME_SECONDS` | 20 × 60 | Match time limit |
| Recent CP history | **last 5** | Was 3; excludes recent hills from next pick |

Scoring: only one hardpoint active at a time → **1 owned point → +1 score every 10 seconds**.

## Changes made this session

1. Removed `mod.EnableCapturePointDeploying(...)` from `activateCenter` / `activatePair` (CP spawn points deleted from the map).
2. Simplified `getSecondsPerPoint` to only handle 0/1 points held (dropped unused 2- and 3-point rates).
3. Recent exclusion history: **3 → 5**.
4. Rotation duration: **120 → 90** seconds.

Kept: rotation, center opener, distance-based “second nearest” picking, team balance on join, assists scoreboard, etc.

## Open topic: next-hardpoint preview (COD-style)

**Question:** Can BF6 Portal show an “upcoming hill” marker before rotation?

**Answer:** Yes — via **`WorldIcon`**, not a special “auxiliary marker” type.

### Map work required first

Scripts cannot create WorldIcons from thin air. Place **at least one** `WorldIcon` in the Portal/Godot layout with a unique **ObjId** (avoid `200–209`, `300–309`, `250`, `350` — e.g. use `400`).

### One icon vs one per sector

**One movable icon is enough.** No need for one per sector.

- Prefer: `mod.SetObjectTransform(icon, transform)` (WorldIcon is a supported move type)
- Also: `MoveObject` / `SetObjectTransformOverTime`
- Deprecated: `SetWorldIconPosition`

Script already caches positions in `cpPositions[]` — move the icon to the next index’s position for the preview window.

### What a WorldIcon looks like

Floating objective-style marker in 3D space (ping / objective-marker feel), not a physical prop. Pick image from `WorldIconImages`:

`Alert`, `Assist`, `Bomb`, `BombArmed`, `Cross`, `DangerPing`, `Diffuse`, `EMP`, `Explosion`, `Eye`, `FilledPing`, `Flag`, `Hazard`, `Skull`, `SquadPing`, `Triangle`

Also: color (`SetWorldIconColor`), text (`SetWorldIconText` — historically flaky), team/player visibility (`SetWorldIconOwner`), show/hide (`EnableWorldIconImage` / `EnableWorldIconText`).

Suggested preview look: `Triangle` / `FilledPing` / `Flag` in a muted color so it reads as “next,” not “active.”

### Sketch of tomorrow’s feature

COD shows next hill ~**10s** before rotation. Rough flow:

1. Place one WorldIcon (ObjId e.g. `400`), hide at match start.
2. When `elapsedSeconds` is within ~10s of `nextRotateAt`, compute next index (same picker as rotation).
3. Move icon to that CP position; enable image (and maybe text).
4. On rotation: hide preview icon; activate the real CP/sector as today.

Alternatives if icons aren’t enough: custom UI HUD, `DisplayCustomNotificationMessage`.

## Related files

- [`Siege-of-Cairo-Hardpoint.ts`](../Siege-of-Cairo-Hardpoint.ts) — live mode script
- [`scipt-backup.ts`](../scipt-backup.ts) — older all-flags-on script (unused)
- [`Spatials/MP_Abbasid_10-flags-backup.spatial.json`](../Spatials/MP_Abbasid_10-flags-backup.spatial.json) — layout backup with ObjIds

## Suggested next steps

1. Add one `WorldIcon` to the map (ObjId free, e.g. `400`).
2. Wire preview show/move/hide into the tick loop (~10s before rotate).
3. Optionally drop rotation further toward COD’s **60s** if 90 still feels long.
4. Playtest: confirm icon visibility, color, and that preview matches the actual next hill.
