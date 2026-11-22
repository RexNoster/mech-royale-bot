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
| 11-22 23:20 | — | Live board (builders-4): #1 Ahmad 6.74, #2 6.63, #32 5.93, #33 5.92, #34 5.91. Practice = 96 matches, FRESH seeds per submission, 4 subs/h, best score counts → resubmitting a strong build has max-of-N upside. Cutoff Mon 05:00 NZDT. | |
| 11-22 23:35 | — | Codex implementing v1 (PLAN scope 1–13) | done |
| 11-22 23:55 | — | at-sim (isolated: Deno --deny-net, scrubbed env), 48 matches seeds 1000–1047, HUNT_KNOW=1: starter 0.54±0.13 (official 1.34); ahmad f29e4d3 1.90±0.24, 1.65 kills, 3456 dealt (official 6.74?) | sim harsh but ordered |
| 11-22 23:58 | 300a595 | v1 SUBMIT (calibration). sim 1.31±0.18, 0.67 kills, 1411 dealt, gun-only 35/48. check.py PASS p99 3.4 ms | predicted ~4 official; awaiting score |
| 11-23 00:10 | — | Sim now fully net-denied: sim AND child bots under Deno --deny-net; sim may only spawn deno. Third-party child bots (ahmad Go, py starter) paused. v1 re-baseline 96 seeds (1000–1095): 1.14±0.12, 0.62 kills, 6 zone deaths (stuck ~70 s outside), gun acc 43% vs ahmad 53%, secondary dmg ~140 vs ~1500/match | weapons = biggest gap |
| 11-23 00:20 | 22ae07c | v2 SUBMIT (Claude-written; Codex stalled on stdin). sim 1.99 vs v1 1.14 (+0.85±0.22 paired 96) | **official 4.45** (v1 official 2.36) → ~2.5 official per sim point here; need sim ≈2.5 for 5.93 |
| 11-23 00:40 | — | Sweeps (paired, fresh ranges): provoke +0.42/−0.11/+0.21 (96/96/288) → pooled +0.19±0.09, adopt. far bands +0.07, retreat .25/.45 ≈0, flip faster −0.05, avoid −0.01, outnumbered-retreat .8 0.00, no-hunt +0.05 | sim saturating on knobs |
| 11-23 00:45 | — | Caveat: per Ahmad notes giddy (6.19 official) ≈ his 2.52 bot in sim → sim misranks top bots; official board is the real instrument | |
| 11-23 00:50 | ba94601 | v3 SUBMIT: v2 + provoke. sim ~2.2–2.3 | pending |
| 11-23 01:05 | ba94601 | v3 official **4.90** (predicted 4.9) → sim tracks our bot at ~2.5 official/sim pt; need +0.4 sim | |
| 11-23 01:20 | 6919b73 | v4 SUBMIT: + farm drones + crates ≤80 m until 150 s (combo +0.14±0.09 / 288; singles flat). Opening 15/25 s −0.12/−0.01 in HK1 sim (off). | pending |
| 11-23 01:25 | — | Testing stealth features under HUNT_KNOW=0 (squad unaware) — Ahmad's top features only make sense there | running |
| 11-23 01:35 | — | HK0 sweep: opening25 −0.39±0.15 (reject), avoid +0.04, rim .85 +0.23±0.12; HK1 rim .85 +0.14 | |
| 11-23 01:40 | 748c623 | v5 SUBMIT: rim 0.95 — paired +0.25±0.10 / +0.20±0.11 (HK1, 288 each) / +0.26±0.10 (HK0, 192); rim 1.0 +0.11; rimLate no effect. Predicted ~5.6–5.8 official | pending |
| 11-23 01:45 | — | no-hunt on v5: +0.26 / +0.08 / −0.03 → pooled +0.11±0.06; KEEP hunt (Ahmad: hunt +0.61 official while sim-neutral) | |
| 11-23 01:50 | 6919b73 | v4 official **4.95** (pred 4.9–5.2) | best so far |
| 11-23 01:55 | 748c623 | v5 official **4.76** (pred ~5.6) → rim/positioning gains in sim do NOT transfer (sim squad parks at 0.6 r of next circle); treat sim positioning results as untrusted; combat changes have transferred | revert rim |
| 11-23 02:10 | — | lightV 7 −0.22±0.08, upDef −0.07, cubeR110 +0.12/−0.00, coverHold too slow (drop) | |
| 11-23 02:15 | 480c81a | v6 SUBMIT: rim 0.6 + laserDuck (+0.13±0.06) + coverReload (+0.07±0.09) | pending |
| 11-23 02:20 | 480c81a | v6 official **4.82**. v4/v5/v6 = 4.95/4.76/4.82 → official noise ≈ ±0.1; recent changes ≈ 0 officially | |
| 11-23 02:22 | — | Ahmad f29e4d3 rebuilt as Go js/wasm, hosted in Deno --deny-net (passes check.py). Sim: ahmad 2.18 (HK0) / 2.28 (HK1) vs our v6 2.47 / 2.51 → no sim mode explains his 6.74; sim cannot rank top bots | official board = instrument |
| 11-23 02:30 | 962a475 | v7 SUBMIT (real-server test): seek (25 s memory / gunfire) + rim 0.4. Sim −0.20/−0.19 (expected: sim inverted for these classes) | pending |
| 11-23 02:35 | 962a475 | v7 official **4.69** → seek + rim 0.4 reverted | |
| 11-23 02:40 | 1becbdb | v8: adaptive lead (real recording: half lead 3.67 m RMS vs full 4.35 m). Official **4.84** | plateau 4.8±0.1 since v4 |
| 11-23 02:50 | — | Real recording: enemy laser 4/5 hits at 50–150 m = 1260/1665 dmg on a gun-only mech | lasers decide real fights |
| 11-23 02:52 | 65e2bb9 | v9 SUBMIT (real test): weapon run. Sim +0.19±0.11 / −0.12±0.12 | pending |
| 11-23 00:00 | — | Codex v2: fire gate cd≤0.1, laser hold-on-LOS-loss + lethal release, weapon values/seek, cube scoop, unseen-attacker turn, anti-lightning, laser dodge, range bands, mortar solve | pending |
