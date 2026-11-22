import { draw, run } from "./mechfight.ts"
import { World } from "./world.ts"
import { Nav } from "./nav.ts"
import { Brain } from "./brain.ts"

run(hello => {
  const world=World.load(hello), nav=new Nav(world,hello.config.mech.radius+.5,hello.config.mech.step_up,hello.config.mech.max_slope_deg), brain=new Brain(hello,world,nav)
  return {name:"royale-v18",act(obs){try{const a=brain.act(obs);draw.label(`${brain.info.mode} t:${brain.info.target??"-"} hp:${obs.self.hp.toFixed(0)}`);return a}catch(e){console.error("brain act failed",e);return brain.safeAct(obs)}}}
})
