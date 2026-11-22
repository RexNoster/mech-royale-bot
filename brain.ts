import type { ActorObs, BotAction, Hello, Observation, Vec2, Vec3, WeaponObs } from "./mechfight.ts"
import { Nav } from "./nav.ts"
import { World } from "./world.ts"

const TAU = Math.PI * 2
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const wrap = (x: number) => {
  while (x > Math.PI) x -= TAU
  while (x < -Math.PI) x += TAU
  return x
}
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1])

type Track = { actor: ActorObs; last: number; seen: boolean; los: boolean }
type Mem = { id: number; kind: string; pos: Vec3; last: number }
export type DecisionInfo = {
  mode: string
  target: number | null
  gunGate: boolean
  leadOffset: number
  safeGoal: Vec2
  laser: "idle" | "charge" | "release"
  dodge: boolean
  swap: boolean
}

/** tunables; BOT_PARAMS (JSON env) overrides them for local A/B only — matches never set it */
export const P = {
  provoke: 1, // 1: don't shoot mechs that are not engaging us (unless close or weak)
  provokeR: 50,
  retreatHp: 0.33,
  returnHp: 0.75,
  gunLo: 40,
  gunHi: 70,
  laserLo: 55,
  laserHi: 110,
  laserLoot: 180,
  lootEnemyR: 90,
  flipMin: 0.25,
  flipVar: 0.45,
  strafeW: 7,
  hunt: 1,
  fightMax: 240,
  avoid: 0, // 1: steer away from mechs that are not engaging us
  avoidR: 70,
  avoidW: 3,
  outHp: 0.5, // retreat with 2+ attackers in LOS below this hp fraction
}
try {
  const env = (globalThis as any).process?.env?.BOT_PARAMS
  if (env) Object.assign(P, JSON.parse(env))
} catch {}

const WEAPON_VALUE: Record<string, number> = { laser: 6, lightning: 2.6, mortar: 1.2, gun: 2 }
const UPGRADE_ORDER = [
  "laser_damage", "laser_charge", "armor", "plating", "gun_rate", "gun_damage", "nanites", "gun_mag",
  "lightning_range", "lightning_chain", "lightning_efficiency", "gun_velocity", "servos", "reactor", "capacitor", "gyros", "sensors",
]

export class Brain {
  cfg: any
  tracks = new Map<number, Track>()
  pickups = new Map<number, Mem>()
  cubes = new Map<number, Mem>()
  target: number | null = null
  lastHitBy: number | null = null
  lastHitAt = -Infinity
  lastHitBearing = 0
  lastHitByUnseen = -Infinity
  lastDealt = -Infinity
  lastLosAt = -Infinity
  retreating = false
  mode = "zone"
  info: DecisionInfo = { mode: "zone", target: null, gunGate: false, leadOffset: 0, safeGoal: [0, 0], laser: "idle", dodge: false, swap: false }
  rng: number
  strafe = 1
  flipAt = 0
  stuckAt = -1
  escapeUntil = -1
  escapeDir: Vec2 = [1, 0]
  lastSound: { bearing: number; t: number } | null = null
  scanPhase = 0
  hurtBy = new Map<number, number>()
  hitOn = new Map<number, number>()

  constructor(public hello: Hello, public world: World, public nav: Nav) {
    this.rng = (hello.seed >>> 0) || 12345
    this.cfg = hello.config as any
  }

  random() {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0
    return this.rng / 4294967296
  }

  // ---------------------------------------------------------------- geometry helpers
  scaleOf(a: { cubes?: number }) {
    return 1 + (this.cfg.cubes?.size_per_cube ?? 0.05) * (a.cubes ?? 0)
  }
  center(a: ActorObs): Vec3 {
    const h = a.kind === "npc" ? (this.cfg.npc?.height ?? 3.5) : this.cfg.mech.height * this.scaleOf(a)
    return [a.pos[0], a.pos[1], a.pos[2] + h * 0.5]
  }
  eye(a: ActorObs): Vec3 {
    const h = a.kind === "npc" ? (this.cfg.npc?.height ?? 3.5) : this.cfg.mech.eye_height * this.scaleOf(a)
    return [a.pos[0], a.pos[1], a.pos[2] + h]
  }
  muzzle(o: Observation): Vec3 {
    return [o.self.pos[0], o.self.pos[1], o.self.pos[2] + (o.self.stats.muzzle_height ?? this.cfg.mech.muzzle_height)]
  }
  selfCenter(o: Observation, at?: Vec2): Vec3 {
    const x = at ? at[0] : o.self.pos[0]
    const y = at ? at[1] : o.self.pos[1]
    const z = at ? this.world.standZ(x, y) : o.self.pos[2]
    return [x, y, z + this.cfg.mech.height * this.scaleOf(o.self) * 0.5]
  }
  radiusOf(a: ActorObs) {
    return a.kind === "npc" ? (this.cfg.npc?.radius ?? 1.8) : this.cfg.mech.radius * this.scaleOf(a)
  }

  // ---------------------------------------------------------------- zone
  zoneAt(o: Observation, t: number) {
    const z = o.zone
    const span = Math.max(1e-6, z.shrink_end - z.shrink_start)
    const f = clamp((t - z.shrink_start) / span, 0, 1)
    return {
      c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f] as Vec2,
      r: z.radius + (z.next_radius - z.radius) * f,
    }
  }

  safeGoal(o: Observation): Vec2 {
    const z = o.zone
    const p = o.self.pos
    const dx = p[0] - z.next_center[0]
    const dy = p[1] - z.next_center[1]
    const d = Math.hypot(dx, dy) || 1
    const f = z.next_radius > 150 ? 0.6 : 0.45
    const reach = Math.min(d, z.next_radius * f)
    let q: Vec2 = [z.next_center[0] + (dx / d) * reach, z.next_center[1] + (dy / d) * reach]
    const now = this.zoneAt(o, o.t)
    const dc = dist(q, now.c)
    const limit = Math.max(0, now.r - 8)
    if (dc > limit) q = [now.c[0] + ((q[0] - now.c[0]) / dc) * limit, now.c[1] + ((q[1] - now.c[1]) / dc) * limit]
    return q
  }

  /** seconds until the zone edge reaches us (Infinity if never within the known window) */
  zoneSlack(o: Observation): number {
    const p: Vec2 = [o.self.pos[0], o.self.pos[1]]
    for (let dt = 0; dt <= 120; dt += 1) {
      const z = this.zoneAt(o, o.t + dt)
      if (dist(p, z.c) > z.r - 4) return dt
    }
    return Infinity
  }

  // ---------------------------------------------------------------- memory
  update(o: Observation) {
    const muzzle = this.muzzle(o)
    const visibleIds = new Set(o.mechs.map((m) => m.id))
    for (const a of o.mechs) {
      const los = dist(a.pos, o.self.pos) < 320 && this.world.los(muzzle, this.center(a))
      this.tracks.set(a.id, { actor: a, last: o.t, seen: true, los })
    }
    for (const [id, v] of this.tracks) {
      if (!visibleIds.has(id)) {
        v.seen = false
        v.los = false
      }
      if (o.t - v.last > (this.cfg.vision?.memory_s ?? 5) + 3) this.tracks.delete(id)
    }
    for (const e of o.events) {
      if (e.type === "damaged") {
        this.lastHitAt = o.t
        if (e.by !== null && e.by !== undefined) {
          this.lastHitBy = e.by
          this.hurtBy.set(e.by, o.t)
          if (!visibleIds.has(e.by)) this.lastHitByUnseen = o.t
        }
        if (e.bearing !== null && e.bearing !== undefined) this.lastHitBearing = e.bearing
      } else if (e.type === "hit") {
        this.lastDealt = o.t
        this.hitOn.set(e.target, o.t)
      } else if (e.type === "took") {
        this.pickups.delete(e.id)
      } else if (e.type === "kill") {
        if (this.target === e.target) this.target = null
      }
    }
    // weapon pickups and cubes persist on the ground: remember them
    const pickupIds = new Set(o.pickups.map((p) => p.id))
    for (const p of o.pickups) this.pickups.set(p.id, { id: p.id, kind: p.kind, pos: p.pos, last: o.t })
    const cubeIds = new Set(o.cubes.map((c) => c.id))
    for (const c of o.cubes) this.cubes.set(c.id, { id: c.id, kind: "cube", pos: c.pos, last: o.t })
    const near = (this.cfg.vision?.near_range ?? 45) - 8
    for (const [id, m] of this.pickups) {
      if (!pickupIds.has(id) && dist(m.pos, o.self.pos) < near) this.pickups.delete(id)
      else if (o.t - m.last > 150) this.pickups.delete(id)
    }
    for (const [id, m] of this.cubes) {
      if (!cubeIds.has(id) && dist(m.pos, o.self.pos) < near) this.cubes.delete(id)
      else if (o.t - m.last > 60) this.cubes.delete(id)
    }
    for (const s of o.sounds) {
      if (["gun", "laser", "lightning", "laser_charge", "step", "boost", "mortar", "reload", "jet"].includes(s.kind)) {
        this.lastSound = { bearing: s.bearing, t: o.t - (s.age ?? 0) }
      }
    }
    if ([...this.tracks.values()].some((v) => v.los && v.actor.kind === "mech")) this.lastLosAt = o.t
  }

  enemies(): Track[] {
    return [...this.tracks.values()].filter((v) => v.actor.kind === "mech")
  }

  // ---------------------------------------------------------------- targeting
  choose(o: Observation): ActorObs | null {
    let best = -Infinity
    let id: number | null = null
    const mechInLos = this.enemies().some((v) => v.los)
    for (const [k, v] of this.tracks) {
      const a = v.actor
      const d = dist(a.pos, o.self.pos)
      if (a.kind === "npc") {
        const shootingUs = k === this.lastHitBy && o.t - this.lastHitAt < 4
        if (mechInLos || !shootingUs) continue
      }
      if (!v.seen && o.t - v.last > 2) continue
      if (d > 300) continue
      if (P.provoke && a.kind === "mech" && !this.engaging(o, a)) continue
      const maxHp = a.max_hp ?? 1400
      const hpFrac = a.hp === undefined ? 1 : a.hp / maxHp
      let s = (v.los ? 60 : 0) + (1 - hpFrac) * 45 - d * 0.18
      if (k === this.lastHitBy && o.t - this.lastHitAt < 3) s += 30
      if (k === this.target) s += 25
      if (a.kind === "mech" && this.isRear(o, a)) s += 10
      if (s > best) {
        best = s
        id = k
      }
    }
    this.target = id
    return id === null ? null : this.tracks.get(id)!.actor
  }

  engaging(o: Observation, a: ActorObs) {
    const d = dist(a.pos, o.self.pos)
    if (o.t - (this.hurtBy.get(a.id) ?? -99) < 10 || o.t - (this.hitOn.get(a.id) ?? -99) < 7) return true
    if (d < P.provokeR) return true
    if (a.hp !== undefined && a.hp < 0.35 * (a.max_hp ?? 1400)) return true
    const toUs = Math.atan2(o.self.pos[1] - a.pos[1], o.self.pos[0] - a.pos[0])
    if (d < 170 && Math.abs(wrap(a.aim[0] - toUs)) < 0.25) return true
    const closing = a.vel[0] * Math.cos(toUs) + a.vel[1] * Math.sin(toUs)
    return d < 130 && closing > 3
  }

  isRear(o: Observation, a: ActorObs) {
    const bearingToUs = Math.atan2(o.self.pos[1] - a.pos[1], o.self.pos[0] - a.pos[0])
    return Math.abs(wrap(bearingToUs - a.aim[0])) > ((this.cfg.mech.front_arc_deg ?? 180) * Math.PI) / 360
  }

  /** aiming solution for a straight projectile (speed Infinity = hitscan) */
  solution(o: Observation, a: ActorObs, w: WeaponObs) {
    const m = this.muzzle(o)
    const speed = w.stats.speed ?? Infinity
    const range = w.stats.range ?? 0
    const c = this.center(a)
    const latency = 0.1 + clamp(w.cooldown ?? 0, 0, 0.1)
    let t = (Number.isFinite(speed) ? Math.hypot(c[0] - m[0], c[1] - m[1], c[2] - m[2]) / speed : 0) + latency
    let px = c[0]
    let py = c[1]
    let pz = c[2]
    for (let i = 0; i < 3; i++) {
      px = c[0] + clamp(a.vel[0] * t, -60, 60)
      py = c[1] + clamp(a.vel[1] * t, -60, 60)
      pz = c[2] + clamp(a.vel[2] * t, -10, 10)
      const groundHere = this.world.groundZ(px, py)
      if (pz - c[2] + a.pos[2] < groundHere) pz = groundHere + (c[2] - a.pos[2])
      t = (Number.isFinite(speed) ? Math.hypot(px - m[0], py - m[1], pz - m[2]) / speed : 0) + latency
    }
    const d = Math.hypot(px - m[0], py - m[1])
    const aim: Vec2 = [Math.atan2(py - m[1], px - m[0]), Math.atan2(pz - m[2], d)]
    return { point: [px, py, pz] as Vec3, aim, d: Math.hypot(px - m[0], py - m[1], pz - m[2]), range, lead: Math.hypot(px - c[0], py - c[1]) }
  }

  aligned(o: Observation, aim: Vec2, d: number, r: number) {
    const tol = Math.atan(Math.max(0.8, r * 0.85) / Math.max(1, d)) + 0.006
    return Math.abs(wrap(o.self.aim[0] - aim[0])) < tol && Math.abs(o.self.aim[1] - aim[1]) < tol * 1.6
  }

  mortarSolution(o: Observation, a: ActorObs, w: WeaponObs): { aim: Vec2; ok: boolean; d: number } {
    const v = w.stats.speed ?? 72
    const g = w.stats.gravity ?? 22
    const p = o.self.pos
    const tubeZ = p[2] + this.cfg.mech.height * this.scaleOf(o.self) + 0.5
    let tx = a.pos[0]
    let ty = a.pos[1]
    let ang = 0.6
    for (let i = 0; i < 2; i++) {
      const d = Math.hypot(tx - p[0], ty - p[1])
      const dz = a.pos[2] + 1 - tubeZ
      const disc = v ** 4 - g * (g * d * d + 2 * dz * v * v)
      if (disc < 0) return { aim: [0, 0], ok: false, d }
      ang = Math.atan((v * v - Math.sqrt(disc)) / (g * d))
      const tf = d / (v * Math.cos(ang))
      tx = a.pos[0] + a.vel[0] * tf * 0.6
      ty = a.pos[1] + a.vel[1] * tf * 0.6
    }
    const d = Math.hypot(tx - p[0], ty - p[1])
    const yaw = Math.atan2(ty - p[1], tx - p[0])
    let ok = ang <= (this.cfg.mech.max_pitch ?? 1.3)
    let prev: Vec3 = [p[0], p[1], tubeZ]
    const vx = v * Math.cos(ang) * Math.cos(yaw)
    const vy = v * Math.cos(ang) * Math.sin(yaw)
    const vz = v * Math.sin(ang)
    const tf = d / (v * Math.cos(ang))
    for (let k = 1; k <= 6 && ok; k++) {
      const t = (tf * k) / 7
      const q: Vec3 = [p[0] + vx * t, p[1] + vy * t, tubeZ + vz * t - 0.5 * g * t * t]
      if (!this.world.los(prev, q)) ok = false
      prev = q
    }
    return { aim: [yaw, ang], ok, d }
  }

  upgrade(o: Observation) {
    if (!o.offer) return undefined
    const held = new Set(o.self.weapons.filter(Boolean).map((w) => w!.kind))
    const rank = (id: string) => {
      let n = UPGRADE_ORDER.findIndex((x) => id === x || id.startsWith(x))
      for (const k of ["laser", "lightning", "mortar", "gun"]) if (id.startsWith(k) && !held.has(k as any)) n = 99
      return n < 0 ? 98 : n
    }
    let best = 0
    for (let i = 1; i < o.offer.choices.length; i++) if (rank(o.offer.choices[i].id) < rank(o.offer.choices[best].id)) best = i
    return best
  }

  // ---------------------------------------------------------------- loot
  secondary(o: Observation) {
    const idx = o.self.weapons.findIndex((w) => w && w.kind !== "gun")
    return { idx, kind: idx >= 0 ? o.self.weapons[idx]!.kind : null }
  }

  reachable(p: Vec3) {
    if (!this.nav.walkable([p[0], p[1]])) return false
    return Math.abs(p[2] - this.world.groundZ(p[0], p[1])) < 3
  }

  wantPickup(o: Observation, kind: string) {
    if (o.self.weapons.some((w) => w?.kind === kind)) return false
    if (kind === "gun") return o.self.weapons.some((w) => !w)
    if (o.self.weapons.some((w) => !w)) return true
    const sec = this.secondary(o)
    return sec.kind !== null && (WEAPON_VALUE[kind] ?? 0) > (WEAPON_VALUE[sec.kind] ?? 0)
  }

  enemyNear(o: Observation, p: number[], r: number, needLos = true) {
    return this.enemies().some((v) => o.t - v.last < 4 && dist(v.actor.pos, p) < r && (!needLos || v.los))
  }

  lootGoal(o: Observation): { goal: Vec2; mode: string; boost: boolean } | null {
    const me = o.self
    const sec = this.secondary(o)
    const hasEmpty = me.weapons.some((w) => !w)
    let best: { goal: Vec2; mode: string; boost: boolean } | null = null
    let bestScore = -Infinity
    if (!this.enemyNear(o, me.pos, P.lootEnemyR)) {
      for (const p of this.pickups.values()) {
        if (!this.wantPickup(o, p.kind) || !this.reachable(p.pos)) continue
        const d = dist(p.pos, me.pos)
        const lim = p.kind === "laser" && sec.kind !== "laser" ? P.laserLoot : hasEmpty ? 120 : 70
        if (d > lim) continue
        const s = (WEAPON_VALUE[p.kind] ?? 0) * 30 - d
        if (s > bestScore) {
          bestScore = s
          best = { goal: [p.pos[0], p.pos[1]], mode: "loot", boost: p.kind === "laser" && me.energy > 30 }
        }
      }
    }
    for (const c of this.cubes.values()) {
      if (!this.reachable(c.pos)) continue
      const d = dist(c.pos, me.pos)
      if (d > 70 || this.enemyNear(o, c.pos, 70)) continue
      const s = 120 - d
      if (s > bestScore) {
        bestScore = s
        best = { goal: [c.pos[0], c.pos[1]], mode: "cubes", boost: false }
      }
    }
    return best
  }

  // ---------------------------------------------------------------- movement helpers
  headingOk(pos: Vec2, h: number, r = 5) {
    return this.nav.walkable([pos[0] + Math.cos(h) * r, pos[1] + Math.sin(h) * r]) && this.nav.walkable([pos[0] + Math.cos(h) * 2.5, pos[1] + Math.sin(h) * 2.5])
  }

  inZoneSoon(o: Observation, q: Vec2) {
    const z = this.zoneAt(o, o.t + 8)
    return dist(q, z.c) < z.r - 6
  }

  fightHeading(o: Observation, tgt: ActorObs): Vec2 {
    const me = o.self
    const pos: Vec2 = [me.pos[0], me.pos[1]]
    const bearing = Math.atan2(tgt.pos[1] - pos[1], tgt.pos[0] - pos[0])
    const sec = this.secondary(o).kind
    const tgtMortar = (tgt.weapons ?? []).includes("mortar")
    let lo = P.gunLo
    let hi = P.gunHi
    if (sec === "laser") {
      lo = P.laserLo
      hi = P.laserHi
    } else if (sec === "lightning" && !tgtMortar) {
      lo = 12
      hi = 34
    }
    if (o.t >= this.flipAt) {
      this.strafe *= -1
      this.flipAt = o.t + P.flipMin + this.random() * P.flipVar
    }
    const lightRange = this.cfg.weapons?.lightning?.range ?? 45
    const others = this.enemies().filter((v) => v.actor.id !== tgt.id && o.t - v.last < 5)
    const all = [...others.map((v) => v.actor), tgt]
    let best = -Infinity
    let bh = bearing + (this.strafe * Math.PI) / 2
    for (let i = 0; i < 16; i++) {
      const h = (i * TAU) / 16
      if (!this.headingOk(pos, h)) continue
      const q: Vec2 = [pos[0] + Math.cos(h) * 6, pos[1] + Math.sin(h) * 6]
      const nd = dist(q, tgt.pos)
      let s = 0
      if (nd < lo) s -= (lo - nd) * 1.2
      if (nd > hi) s -= (nd - hi) * 1.2
      s += P.strafeW * Math.sin(h - bearing) * this.strafe
      for (const a of all) {
        if (!(a.weapons ?? []).includes("lightning")) continue
        if (sec === "lightning" && a.id === tgt.id && !tgtMortar) continue
        const ed = dist(q, a.pos)
        if (ed < lightRange + 14) s -= (lightRange + 14 - ed) * 2.5
      }
      for (const v of others) {
        const ed = dist(q, v.actor.pos)
        if (ed < 60) s -= (60 - ed) * 0.4
      }
      if (!this.inZoneSoon(o, q)) s -= 30
      if (s > best) {
        best = s
        bh = h
      }
    }
    return [Math.cos(bh), Math.sin(bh)]
  }

  /** bend the intended move away from mechs that are not (yet) engaging us, so we don't wake them */
  avoidSteer(o: Observation, move: Vec2, targetId: number | null): Vec2 {
    const me = o.self
    const pos: Vec2 = [me.pos[0], me.pos[1]]
    const near = this.enemies().filter((v) => v.actor.id !== targetId && o.t - v.last < 5 && dist(v.actor.pos, pos) < P.avoidR && !this.engaging(o, v.actor))
    if (!near.length) return move
    const mlen = Math.hypot(move[0], move[1])
    const mh = Math.atan2(move[1], move[0])
    let best = -Infinity
    let bh = mh
    for (let i = 0; i < 16; i++) {
      const h = (i * TAU) / 16
      if (!this.headingOk(pos, h)) continue
      const q: Vec2 = [pos[0] + Math.cos(h) * 6, pos[1] + Math.sin(h) * 6]
      let s = mlen > 0.1 ? Math.cos(h - mh) * 2 : 0
      for (const v of near) {
        const now = dist(pos, v.actor.pos)
        const nxt = dist(q, v.actor.pos)
        s += ((nxt - now) / 6) * P.avoidW * (1 - now / P.avoidR)
      }
      if (!this.inZoneSoon(o, q)) s -= 5
      if (s > best) {
        best = s
        bh = h
      }
    }
    return [Math.cos(bh), Math.sin(bh)]
  }

  dodgeHeading(o: Observation): Vec2 | null {
    const me = o.self
    const pos: Vec2 = [me.pos[0], me.pos[1]]
    for (const v of this.enemies()) {
      const a = v.actor
      if (!v.seen || !a.charging || !v.los) continue
      if (dist(a.pos, me.pos) > 290) continue
      const toUs = Math.atan2(pos[1] - a.pos[1], pos[0] - a.pos[0])
      if (Math.abs(wrap(a.aim[0] - toUs)) > 0.16) continue
      let best = -Infinity
      let bh = toUs + Math.PI / 2
      for (let i = 0; i < 16; i++) {
        const h = (i * TAU) / 16
        if (!this.headingOk(pos, h)) continue
        const q: Vec2 = [pos[0] + Math.cos(h) * 6, pos[1] + Math.sin(h) * 6]
        const s = Math.abs(Math.sin(h - toUs)) * 10 + (Math.cos(h - toUs) > 0 ? 1 : 0) + (this.inZoneSoon(o, q) ? 0 : -8)
        if (s > best) {
          best = s
          bh = h
        }
      }
      return [Math.cos(bh), Math.sin(bh)]
    }
    return null
  }

  coverGoal(o: Observation): Vec2 | null {
    const me = o.self
    const pos: Vec2 = [me.pos[0], me.pos[1]]
    const foes = this.enemies().filter((v) => o.t - v.last < 6).map((v) => v.actor)
    if (!foes.length) return null
    let found: Vec2 | null = null
    let best = Infinity
    for (let r = 12; r <= 64; r += 8) {
      for (let i = 0; i < 20; i++) {
        const h = (i * TAU) / 20
        const q: Vec2 = [pos[0] + Math.cos(h) * r, pos[1] + Math.sin(h) * r]
        if (!this.nav.walkable(q) || !this.inZoneSoon(o, q)) continue
        const c = this.selfCenter(o, q)
        const top: Vec3 = [c[0], c[1], c[2] + 3.5]
        if (foes.some((e) => this.world.los(this.eye(e), c) || this.world.los(this.eye(e), top))) continue
        const nearest = Math.min(...foes.map((e) => dist(e.pos, q)))
        const s = r - Math.min(nearest, 120) * 0.15
        if (s < best) {
          best = s
          found = q
        }
      }
      if (found && r >= 28) break
    }
    return found
  }

  // ---------------------------------------------------------------- main
  act(o: Observation): BotAction {
    this.update(o)
    const me = o.self
    const pos: Vec2 = [me.pos[0], me.pos[1]]
    const safe = this.safeGoal(o)
    const a: BotAction = {}
    const pick = this.upgrade(o)
    if (pick !== undefined) a.pick = pick
    let dodge = false
    let swap = false

    const zNow = this.zoneAt(o, o.t)
    const outside = dist(pos, zNow.c) > zNow.r - 1 || !me.in_zone
    const eta = dist(pos, safe) / (me.stats.walk_speed ?? 11.7)
    const zoneUrgent = outside || this.zoneSlack(o) < eta + 10

    let target = this.choose(o)
    const tTrack = target ? this.tracks.get(target.id)! : null
    const losTarget = tTrack && tTrack.los ? target : null
    const hpFrac = me.hp / me.max_hp
    const losFoes = this.enemies().filter((v) => v.los && dist(v.actor.pos, me.pos) < 230)
    const weakTarget = !!losTarget && losTarget.kind === "mech" && losTarget.hp !== undefined && losTarget.hp < 0.3 * (losTarget.max_hp ?? 1400) && dist(losTarget.pos, me.pos) < 90
    if (this.retreating && hpFrac > P.returnHp) this.retreating = false
    if (!this.retreating && (hpFrac < P.retreatHp || (losFoes.length >= 2 && hpFrac < P.outHp)) && !weakTarget) this.retreating = true
    const retreat = this.retreating && !weakTarget

    // ------------------------------------------------ movement
    let goal: Vec2 = safe
    let move: Vec2 | null = null
    let boost = false
    this.mode = "hold"
    const dh = this.dodgeHeading(o)
    if (zoneUrgent) {
      this.mode = "zone"
      boost = outside && me.energy > 20
    } else if (dh) {
      move = dh
      boost = me.energy > 15
      dodge = true
      this.mode = "dodge"
    } else if (retreat) {
      this.mode = "retreat"
      const cg = this.coverGoal(o)
      if (cg) goal = cg
      else if (target) {
        const away = Math.atan2(me.pos[1] - target.pos[1], me.pos[0] - target.pos[0])
        goal = [pos[0] + Math.cos(away) * 50, pos[1] + Math.sin(away) * 50]
      }
      boost = me.energy > 40 && losFoes.length > 0
    } else if (losTarget && losTarget.kind === "mech" && dist(losTarget.pos, me.pos) < P.fightMax) {
      this.mode = "fight"
      move = this.fightHeading(o, losTarget)
    } else {
      const loot = this.lootGoal(o)
      const drop = o.drops.find((d) => d.lands_in < 6 && dist(d.pos, me.pos) < 150 && !this.enemyNear(o, d.pos, 90, false) && this.reachable(d.pos))
      if (loot) {
        goal = loot.goal
        boost = loot.boost
        this.mode = loot.mode
      } else if (drop && hpFrac < 0.95) {
        goal = [drop.pos[0], drop.pos[1]]
        this.mode = "drop"
      } else if (P.hunt && target && target.kind === "mech") {
        this.mode = "hunt"
        goal = [target.pos[0], target.pos[1]]
      } else if (losTarget) {
        this.mode = "npc"
        move = this.fightHeading(o, losTarget)
      } else {
        const crate = o.crates
          .filter((c) => dist(c.pos, me.pos) < 45 && this.world.los(this.muzzle(o), [c.pos[0], c.pos[1], c.pos[2] + 1]))
          .sort((x, y) => dist(x.pos, me.pos) - dist(y.pos, me.pos))[0]
        if (crate && hpFrac > 0.6) {
          this.mode = "crate"
          target = { id: crate.id, kind: "npc", pos: crate.pos, vel: [0, 0, 0], aim: [0, 0], hp: crate.hp } as ActorObs
        }
      }
    }
    if (!move) move = this.nav.steerTo(pos, goal, o.t)
    if (this.mode === "hold" && dist(pos, safe) < 12) move = [0, 0]
    if (P.avoid && !dodge && this.mode !== "zone") move = this.avoidSteer(o, move, target?.id ?? null)

    // stuck / off-grid escape
    const speed = Math.hypot(me.vel[0], me.vel[1])
    const offGrid = !this.nav.walkable(pos)
    if (o.t < this.escapeUntil) {
      move = this.escapeDir
      a.jump = true
      boost = true
    } else if ((speed < 1.5 && Math.hypot(move[0], move[1]) > 0.5) || (offGrid && this.mode !== "dodge")) {
      if (this.stuckAt < 0) this.stuckAt = o.t
      if (o.t - this.stuckAt > 0.7) {
        const [ci, cj] = this.nav.nearest(pos)
        const np = this.nav.point(ci, cj)
        const h = offGrid && dist(np, pos) > 1 ? Math.atan2(np[1] - pos[1], np[0] - pos[0]) : this.random() * TAU
        this.escapeDir = [Math.cos(h), Math.sin(h)]
        this.escapeUntil = o.t + 0.8
        this.nav.lastPlan = -Infinity
        this.stuckAt = -1
        move = this.escapeDir
        a.jump = true
        boost = true
      }
    } else this.stuckAt = -1
    a.move = move
    a.boost = boost

    // ------------------------------------------------ aiming & firing
    let gunGate = false
    let lead = 0
    let laserState: DecisionInfo["laser"] = "idle"
    a.fire = [false, false]
    const gi = me.weapons.findIndex((w) => w?.kind === "gun")
    const gun = gi >= 0 ? me.weapons[gi] : null
    const li = me.weapons.findIndex((w) => w?.kind === "laser")
    const laser = li >= 0 ? me.weapons[li] : null
    const charging = !!laser && (laser.charge ?? 0) > 0
    const holdFire = retreat && !(o.t - this.lastHitAt < 1.2)
    const fireTarget = target && (losTarget === target || this.mode === "crate") ? target : null
    const aimTarget = fireTarget ?? (charging && target ? target : null)

    if (aimTarget) {
      const refW = gun ?? me.weapons.find(Boolean)!
      const gs = this.solution(o, aimTarget, refW)
      const hs = laser ? this.solution(o, aimTarget, { ...laser, stats: { ...laser.stats, speed: Infinity } } as WeaponObs) : gs
      const r = this.radiusOf(aimTarget)
      const laserReady = !!laser && charging && (laser.charge ?? 0) >= (laser.stats.charge ?? 0.75) - 0.12
      const gunIdle = !gun || (gun.ammo ?? 1) === 0 || (gun.reload ?? 0) > 0.1
      const useHs = !!laser && (laserReady || gunIdle)
      const s = useHs ? hs : gs
      a.aim = s.aim
      lead = gs.lead
      const clear = this.world.los(this.muzzle(o), s.point)
      if (gun && fireTarget) {
        const al = this.aligned(o, gs.aim, gs.d, r)
        gunGate = (gun.ammo ?? 1) > 0 && (gun.reload ?? 0) <= 0 && gun.cooldown <= 0.1 && gs.d <= (gun.stats.range ?? 230) && al && this.world.los(this.muzzle(o), gs.point) && !holdFire
        a.fire[gi] = gunGate
      }
      if (gun && (gun.ammo ?? 1) === 0 && (gun.reload ?? 0) <= 0) a.reload = true
      for (let i = 0; i < 2; i++) {
        const w = me.weapons[i]
        if (!w || w.kind === "gun") continue
        if (w.kind === "laser") {
          const full = w.stats.charge ?? 0.75
          const ch = w.charge ?? 0
          const hold = this.cfg.weapons?.laser?.hold_s ?? 2
          const mech = aimTarget.kind === "mech"
          const minFrac = w.stats.min_frac ?? 0.35
          let dmg = (w.stats.damage ?? 315) * (minFrac + (1 - minFrac) * clamp(ch / full, 0, 1))
          dmg *= 1 + (this.cfg.cubes?.damage_per_cube ?? 0.04) * Math.min(me.cubes, this.cfg.cubes?.stat_cap ?? 10)
          if (mech && this.isRear(o, aimTarget)) dmg *= this.cfg.mech.rear_mult ?? 1.5
          if (mech && (aimTarget.weapons ?? []).includes("mortar")) dmg *= 1 + (w.stats.cookoff ?? this.cfg.weapons?.laser?.cookoff ?? 0)
          const lethal = mech && aimTarget.hp !== undefined && ch >= (w.stats.min_charge ?? 0.15) && dmg >= aimTarget.hp
          const canRelease = fireTarget === aimTarget && hs.d <= (w.stats.range ?? 280) && this.aligned(o, hs.aim, hs.d, r) && this.world.los(this.muzzle(o), hs.point)
          if (ch > 0) {
            if ((ch >= full - 0.05 || lethal) && canRelease) {
              a.fire[i] = false
              laserState = "release"
            } else if (ch < full + hold - 0.15) {
              a.fire[i] = true
              laserState = "charge"
            } else {
              a.fire[i] = !canRelease
            }
          } else if (w.cooldown <= 0.1 && fireTarget && (mech || !this.enemies().length) && hs.d <= (w.stats.range ?? 280) && !holdFire) {
            a.fire[i] = true
            laserState = "charge"
          }
        } else if (w.kind === "lightning" && fireTarget) {
          const cone = ((w.stats.cone_deg ?? 30) * Math.PI) / 360
          const d = dist(aimTarget.pos, me.pos)
          const yawTo = Math.atan2(aimTarget.pos[1] - me.pos[1], aimTarget.pos[0] - me.pos[0])
          a.fire[i] = w.cooldown <= 0.1 && d <= (w.stats.range ?? 45) - 2 && Math.abs(wrap(me.aim[0] - yawTo)) < cone * 0.8 && clear && me.energy >= (w.stats.energy ?? 3) + 6 && !holdFire
        } else if (w.kind === "mortar" && fireTarget && aimTarget.kind === "mech") {
          const ms = this.mortarSolution(o, aimTarget, w)
          const gunBusy = !gun || (gun.reload ?? 0) > 0.3 || ms.d > 160
          if (ms.ok && ms.d >= 28 && ms.d <= 230 && w.cooldown <= 0.1 && !holdFire && gunBusy && !laserReady) {
            a.aim = ms.aim
            a.fire[i] = Math.abs(wrap(me.aim[0] - ms.aim[0])) < 0.03 && Math.abs(me.aim[1] - ms.aim[1]) < 0.03
          }
        }
      }
    } else {
      if (laser && charging) {
        const full = laser.stats.charge ?? 0.75
        const hold = this.cfg.weapons?.laser?.hold_s ?? 2
        a.fire[li] = (laser.charge ?? 0) < full + hold - 0.15
        if (a.fire[li]) laserState = "charge"
      }
      if (o.t - this.lastHitByUnseen < 1.2 || (o.t - this.lastHitAt < 1.2 && !losFoes.length)) {
        a.aim = [this.lastHitBearing, 0]
      } else if (target) {
        a.aim = [Math.atan2(target.pos[1] - me.pos[1], target.pos[0] - me.pos[0]), 0]
      } else if (this.lastSound && o.t - this.lastSound.t < 3) {
        a.aim = [this.lastSound.bearing, 0]
      } else {
        this.scanPhase += 0.12
        const base = Math.hypot(move[0], move[1]) > 0.3 ? Math.atan2(move[1], move[0]) : Math.atan2(safe[1] - pos[1], safe[0] - pos[0]) + Math.PI
        a.aim = [base + Math.sin(this.scanPhase) * 1.0, 0]
      }
      if (gun && (gun.ammo ?? 99) <= 4 && (gun.reload ?? 0) <= 0 && o.t - this.lastLosAt > 0.8) a.reload = true
    }

    // ------------------------------------------------ pickups
    const reach = this.cfg.loot?.pickup_radius ?? 4
    for (const p of o.pickups) {
      if (dist(p.pos, me.pos) > reach || Math.abs(p.pos[2] - me.pos[2]) > 4) continue
      if (!this.wantPickup(o, p.kind)) continue
      if (!me.weapons.some((w) => !w)) {
        const sec = this.secondary(o)
        if (sec.idx < 0) continue
        if (me.weapons[sec.idx]?.kind === "laser" && charging) continue
        a.drop = sec.idx
        swap = true
      }
      a.take = p.id
      break
    }

    this.info = { mode: this.mode, target: target?.id ?? null, gunGate, leadOffset: lead, safeGoal: safe, laser: laserState, dodge, swap }
    return a
  }

  safeAct(o: Observation): BotAction {
    const g = this.safeGoal(o)
    const p = o.self.pos
    const d = Math.hypot(g[0] - p[0], g[1] - p[1]) || 1
    return { move: [(g[0] - p[0]) / d, (g[1] - p[1]) / d], aim: [Math.atan2(g[1] - p[1], g[0] - p[0]), 0], boost: !o.self.in_zone }
  }
}
