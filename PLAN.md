# PLAN — Mech Royale bot (our own implementation, TypeScript/Bun, from the official TS starter)

## Facts that drive every decision
- Score = mean(16 − place) = number of mechs that die before us. Practice = 48 matches vs 15 house bots acting as ONE squad
  (shared vision, never fight each other, hunt us weakest-first: one hunter early, more as we kill, all late).
- Therefore practice score ≈ (our kills) + (environmental deaths ≈ 0.4–0.7). Top-32 (~5.9) needs ~5 kills/match.
  A pacifist scores ~0.4. Kills are the currency; survival only matters as time to keep killing.
- Finals are 16-mech FFA vs other teams: there, survival/caution matters more (third-party fights). v1 targets practice;
  an FFA stance (detect mechs dying that we did not kill, or beams between other mechs) is v2 scope.
- Per tick we see: self (pos/vel/aim/hp/energy/weapons with cooldown/ammo/charge), visible mechs+NPCs (pos, vel, aim, hp,
  weapons, charging), visible projectiles, pickups, cubes, crates, sounds (bearing±7°, near/mid/far), beams, events,
  drops, zone (current+next+timing), offer. 50 ms budget, 1 CPU. Lockstep: action holds for 2 ticks (0.1 s).
- Shots leave along ACTUAL torso aim, which slews at turn_rate 4 rad/s, pitch 3 rad/s. Gun: 252 m/s, 45 dmg, 0.24 s, mag 12,
  reload 2.4 s, range 230. Laser: hold to charge 0.75 s → 315 dmg hitscan, range 280, cooldown 1.65 s, half move speed while
  charging, +60 % vs mortar holders. Lightning: 60 dmg, 45 m, 30° cone, chains, 3 energy. Slots 0 and 1 fire together.
- Rear hits ×1.5 (outside 180° front arc of torso aim) → face the attacker. Regen 45 HP/s after 5 s with no damage dealt or taken.
- Kills drop all cubes + 2; cubes +4 % HP & damage each (cap 10 for stats). Read all numbers from hello.config.

## The main bet (v1)
Turn the squad's one-at-a-time hunting into kills: a bot that never gets stuck, arms itself early (laser first),
only fires shots that will hit (lead + slew-aware gating, LOS-checked), dodges while fighting (strafe jinks, laser
sidestep, stay out of lightning range), faces its attacker, breaks line of sight to regen when hurt, and scoops kill cubes.
The starter does none of these (no lead, no LOS check, fires at anything, walks blindly into walls → 1.34).

## v1 scope (files: world.ts, nav.ts, brain.ts, bot.ts; mechfight.ts kept as the kit wrapper)
1. **world.ts** — load `hello.map.dir`/v2/world.json + terrain.i16 (fall back to ./kit/arena if dir missing).
   1 m grid: ground height (bilinear terrain), solid top per cell for building/stadium prisms (point-in-ring, minus holes),
   bridges stored as (base,top) intervals. `groundZ(x,y)`, `standZ(x,y)`, `los(a: V3, b: V3): boolean` (step ≤1 m through the
   grid, blocked if ray z < solid top in a building cell or inside a bridge interval, or below terrain). Trees ignored for shots.
   Must build in < 3 s at startup (ready budget 20 s).
2. **nav.ts** — 2 m grid of ground-walkable cells: blocked if any building/stadium footprint or low bridge (base < ground+9.5)
   within mech radius 2.5 m (+0.5 margin); edges blocked if height step > step_up (1.2) or slope > 50°. Largest connected
   component flagged. A* (binary heap, octile, node budget ~6000/call, cached path, replan ≤ every 0.5 s or when goal moves >6 m),
   string-pull smoothing with a walkability line check. If goal cell blocked → nearest walkable cell. `steerTo(goal)` returns a
   move vector toward the next waypoint. Stuck detector: commanded move but horizontal speed < 1.5 m/s for > 0.8 s → jump + boost
   + replan; if still stuck try a random walkable side direction for 0.6 s.
3. **Zone** — safe goal = point inside the NEXT circle (radius × 0.6 toward our side early, × 0.5 late), always also inside the
   current circle. Compute when the shrink will reach us; leave early enough (dist / walk_speed + 8 s slack). Outside the zone:
   boost toward the safe goal and never let fights override this unless zone dps × time-to-safety < 25 % HP.
4. **Tracking & targeting** — remember every mech (pos, vel, hp, weapons, last seen t; server keeps tracking 5 s). Target score:
   prefer mechs with LOS, low hp, close, attacking us (from `damaged.by`), rear exposed; stick to current target (hysteresis).
   NPC drones: only shoot if they are shooting us or nothing else to do and we are healthy (they drop 2 cubes).
5. **Aiming** — iterative lead: t = dist/speed (+ latency 0.1 s + remaining cooldown), target point = pos + vel·t (clamp vel
   lead to sensible), aim at center mass (pos.z + 4.5·scale). Pitch from muzzle (pos.z + muzzle_height·scale). Command that aim
   every tick. **Fire gate**: only when `los(muzzle, targetPoint)` and |actual aim − solution| (yaw & pitch) < atan(2.0/d) + 0.01
   and d ≤ range. Reload when ammo 0; top-off reload (ammo ≤ 5) when no target in LOS for ≥ 1 s.
6. **Secondary weapons** — Laser: charge while a target is in (or likely back in) LOS ≤ 280 m; release at charge ≥ charge−0.05
   (or when charge damage ≥ target hp) with aim error < atan(2/d) and LOS clear; if LOS lost keep holding (auto-fires at hold_s,
   so release toward the last target only if within 0.3 s of auto-fire and LOS is back; otherwise accept). Lightning: fire when a
   target is within range−2 m, yaw within cone/2 of our ACTUAL aim, LOS clear, energy ≥ 3 (+ reserve 10 when moving matters).
   Mortar: low-arc ballistic solve at 25–220 m, only if target not moving fast or is stationary/clustered; never within 15 m.
7. **Loot** — pickup value: laser 6, lightning 2.6, mortar 1.2. Walk (no boost unless laser and energy > 30) to the best weapon
   within 140 m (path length) when no enemy is engaging us; swap out a worse secondary (`take` + `drop: 1`) when standing on a
   better one. Cubes: go for visible cubes within 70 m when no enemy has LOS on us or the fight is won; always scoop kill cubes.
   Crates: shoot crates within 40 m when idle and nothing better (cube + 50 % weapon).
8. **Fight movement** (engaged = a mech within 200 m with LOS or hit us in last 3 s) — evaluate 16 headings, each checked
   walkable 4 m ahead on the nav grid; score = keep desired range band (laser held: 60–140 m; gun only: 35–100 m; lightning held
   and target has no mortar: 15–38 m) + perpendicular strafe bonus (direction flips every 0.15–0.35 s, random from slot seed) −
   lightning carriers within range+12 m (strong repulsion) − moving into the open toward other known enemies + cover bonus when
   reloading. If an enemy is `charging` with its aim within 0.12 rad of the bearing to us → strong sidestep perpendicular + boost.
   Always aim torso at the target (keeps front arc on attacker).
9. **Retreat & regen** — if hp < 35 % (or effective ttd < 4 s vs ≥2 attackers) and a cell hidden from all known enemy eye
   positions exists within 60 m path → go there, hold fire unless hit, stay until hp > 80 % or found. Kill a weak target (< 25 %
   hp, in LOS, < 80 m) instead of retreating if we are > 20 % hp.
10. **Hunt** — healthy (hp > 70 %), armed, no target: move toward the most recent known enemy / loud sound bearing (gun, laser)
    but stay inside the safe zone region. The squad comes to us; never wander outside the next circle.
11. **Upgrades** — pick by static priority from offer choices: laser_damage, laser_charge (if laser held), armor, plating,
    gun_rate, gun_damage, nanites, gun_mag, lightning_* (if held), servos, reactor, capacitor, sensors, others last.
12. **Supply drops** — go for a landed/landing drop within 160 m path inside the zone when no enemy is visible nearby
    (full HP + 3 cubes); abort if contested.
13. **Debug** — label with mode/target/hp; keep within caps. Logs to stderr only.

## Acceptance checks (all must pass before a version is handed over)
- A1 `py kit/check/check.py -- bun bot.ts` PASS, p99 < 15 ms on this machine, ready < 5 s. (Docker sandbox check not runnable
  locally — no Docker; scorer runs it; keep code dependency-free and write nothing to disk.)
- A2 Replay harness `tools/replay.ts` (feeds kit/check/stream.jsonl.gz obs one by one, in-process) prints per-mode counts and
  proves activation on the recording: fire decisions only when gate true; lead offset non-zero vs moving targets; laser
  charge/release sequence well-formed; `take` issued when standing on a pickup; zone goal inside next circle; no exceptions.
- A3 Unit sanity (tools/selftest.ts): los() blocked through a known building, clear in open field; A* finds a path between two
  open points across campus in < 10 ms; nav component covers > 50 % of the in-bounds area.
- A4 Decision time: max < 30 ms, p99 < 10 ms over the replay (pathfinding budgeted).
- A5 Dockerfile: `FROM oven/bun:1.4.4-slim`, entrypoint `bun /bot/bot.ts`, no runtime installs, map read from hello.map.dir.

## Log
| When (NZDT) | Commit | Hypothesis / change | Result |
| --- | --- | --- | --- |
| 11-22 23:30 | 31d9706 | official TS starter baseline | official python starter scored 1.34 (user) |
| | | Benchmark: ahmad-ovh/Buildathon @ f29e4d3b (HEAD 2026-11-22 14:57 +0800, Apex-Go v3; commit behind 6.74 unverified) | read-only |
