import { World } from "../world.ts"
import { Nav } from "../nav.ts"
import type { Hello } from "../mechfight.ts"

const config={mech:{radius:2.5,step_up:1.2,max_slope_deg:50}} as unknown as Hello["config"]
const hello={map:{dir:"./kit/arena"},config} as Hello
const started=performance.now(),w=World.load(hello),nav=new Nav(w,3,1.2,50),built=performance.now()-started
const prism=w.data.prisms.find(p=>p.kind==="building"||p.kind==="stadium")!,cx=prism.ring.filter((_,i)=>i%2===0).reduce((a,b)=>a+b,0)/(prism.ring.length/2),cy=prism.ring.filter((_,i)=>i%2===1).reduce((a,b)=>a+b,0)/(prism.ring.length/2)
const blocked=!w.los([cx-30,cy,prism.base+1],[cx+30,cy,prism.base+1])
let clear=false;for(let y=w.data.bounds.minY+20;y<w.data.bounds.maxY&&!clear;y+=20)for(let x=w.data.bounds.minX+20;x<w.data.bounds.maxX&&!clear;x+=20)clear=w.los([x,y,w.groundZ(x,y)+20],[x+10,y,w.groundZ(x+10,y)+20])
const opens:number[]=[];for(let i=0;i<nav.component.length;i++)if(nav.component[i])opens.push(i);const a=opens[(opens.length*.45)|0],pa=nav.point(a%nav.nx,(a/nav.nx)|0);let b=opens[(opens.length*.55)|0];for(const q of opens){const p=nav.point(q%nav.nx,(q/nav.nx)|0),d=Math.hypot(p[0]-pa[0],p[1]-pa[1]);if(d>180&&d<260){b=q;break}}const pb=nav.point(b%nav.nx,(b/nav.nx)|0),t=performance.now(),path=nav.find(pa,pb,6000),pathMs=performance.now()-t,coverage=opens.length/nav.open.length
if(!blocked)throw Error("known building did not block LOS");if(!clear)throw Error("no clear open LOS");if(!path.length)throw Error("A* did not find path");if(pathMs>=10)throw Error(`A* ${pathMs.toFixed(2)}ms >= 10ms`);if(coverage<=.5)throw Error(`component coverage ${(coverage*100).toFixed(1)}%`)
console.log(`PASS world ${built.toFixed(1)}ms; LOS blocked=${blocked} clear=${clear}; A* ${pathMs.toFixed(2)}ms ${path.length} waypoints; component ${(coverage*100).toFixed(1)}%`)
