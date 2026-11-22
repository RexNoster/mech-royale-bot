import { World } from "../world.ts"
import { Nav } from "../nav.ts"
import { Brain } from "../brain.ts"
import type { Hello, Observation } from "../mechfight.ts"

const raw=await Bun.file("kit/check/stream.jsonl.gz").arrayBuffer(),text=await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))).text(),lines=text.trim().split("\n").map(JSON.parse),hello=lines.find(x=>x.type==="hello") as Hello
hello.map.dir="./kit/arena";const world=World.load(hello),nav=new Nav(world,hello.config.mech.radius+.5,hello.config.mech.step_up,hello.config.mech.max_slope_deg),brain=new Brain(hello,world,nav),modes:Record<string,number>={},times:number[]=[];let exceptions=0,gateViolations=0,lead=0,charges=0,releases=0,takes=0,zoneOk=0,zoneN=0
for(const o of lines.filter(x=>x.type==="obs") as Observation[]){const t=performance.now();try{const a=brain.act(o);times.push(performance.now()-t);modes[brain.info.mode]=(modes[brain.info.mode]??0)+1;if(a.fire?.some(Boolean)&&o.self.weapons.some((w,i)=>w?.kind==="gun"&&a.fire?.[i])&&!brain.info.gunGate)gateViolations++;if(brain.info.leadOffset>.01)lead++;if(brain.info.laser==="charge")charges++;if(brain.info.laser==="release")releases++;if(a.take!==undefined)takes++;const g=brain.info.safeGoal;if(Math.hypot(g[0]-o.zone.next_center[0],g[1]-o.zone.next_center[1])<=o.zone.next_radius+.01)zoneOk++;zoneN++}catch{exceptions++}}
// The official trace never equips a laser or reaches pickup radius. Reuse real trace states with only
// those missing preconditions injected, so the harness still proves both action sequences in-process.
const recorded=lines.filter(x=>x.type==="obs") as Observation[],pickupBase=recorded.find(o=>o.pickups.length)!;
const pickupCase=structuredClone(pickupBase);pickupCase.pickups[0].pos=[...pickupCase.self.pos];if(brain.act(pickupCase).take!==undefined)takes++
const laserBase=recorded.find(o=>o.mechs.some(m=>m.kind==="mech"&&Math.hypot(m.pos[0]-o.self.pos[0],m.pos[1]-o.self.pos[1])<250))!;
if(laserBase){const chargeCase=structuredClone(laserBase),stats={...hello.config.weapons.laser},foe=chargeCase.mechs.find(m=>m.kind==="mech"&&Math.hypot(m.pos[0]-chargeCase.self.pos[0],m.pos[1]-chargeCase.self.pos[1])<250)!;chargeCase.mechs=[foe];chargeCase.self.weapons=[{kind:"laser",cooldown:0,charge:0,stats},null];const laserBrain=new Brain(hello,world,nav),sol=laserBrain.solution(chargeCase,foe,chargeCase.self.weapons[0]!);chargeCase.self.aim=[...sol.aim];laserBrain.act(chargeCase);if(laserBrain.info.laser==="charge")charges++;const releaseCase=structuredClone(chargeCase);releaseCase.self.weapons[0]!.charge=stats.charge;laserBrain.act(releaseCase);if(laserBrain.info.laser==="release")releases++}
times.sort((a,b)=>a-b);const p99=times[Math.floor(times.length*.99)]??0,max=times.at(-1)??0
if(exceptions||gateViolations||!lead||!charges||!releases||!takes||zoneOk!==zoneN)throw Error(`replay invariant failure exceptions=${exceptions} gate=${gateViolations} lead=${lead} laser=${charges}/${releases} take=${takes} zone=${zoneOk}/${zoneN}`)
console.log(`PASS modes=${JSON.stringify(modes)} gateViolations=${gateViolations} lead=${lead} laser=${charges}/${releases} take=${takes} zone=${zoneOk}/${zoneN} exceptions=${exceptions} p99=${p99.toFixed(3)}ms max=${max.toFixed(3)}ms`)
