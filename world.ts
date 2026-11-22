import type { Hello, Vec3 } from "./mechfight.ts"
import { existsSync, readFileSync } from "node:fs"

type Prism = { kind: string; base: number; top: number; ring: number[]; holes?: number[][] }
type WorldFile = { bounds: { minX:number; maxX:number; minY:number; maxY:number }; terrain: { file:string; minX:number; minY:number; step:number; nx:number; ny:number; scale:number }; prisms: Prism[] }

const inside = (x:number,y:number,r:number[]) => { let c=false; for(let i=0,j=r.length-2;i<r.length;j=i,i+=2) { const xi=r[i],yi=r[i+1],xj=r[j],yj=r[j+1]; if(((yi>y)!=(yj>y)) && x < (xj-xi)*(y-yi)/(yj-yi)+xi) c=!c } return c }
const inPrism = (x:number,y:number,p:Prism) => inside(x,y,p.ring) && !(p.holes??[]).some(h=>inside(x,y,h))

export class World {
  data: WorldFile
  terrain: Int16Array
  solids: Float32Array
  bridges: Prism[]
  constructor(data:WorldFile, terrain:Int16Array) {
    this.data=data; this.terrain=terrain; this.solids=new Float32Array(data.terrain.nx*data.terrain.ny); this.solids.fill(-Infinity)
    this.bridges=data.prisms.filter(p=>p.kind==="bridge")
    for(const p of data.prisms) if(p.kind!=="bridge") {
      let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity
      for(let k=0;k<p.ring.length;k+=2){minX=Math.min(minX,p.ring[k]);maxX=Math.max(maxX,p.ring[k]);minY=Math.min(minY,p.ring[k+1]);maxY=Math.max(maxY,p.ring[k+1])}
      const t=data.terrain, i0=Math.max(0,Math.floor((minX-t.minX)/t.step)), i1=Math.min(t.nx-1,Math.ceil((maxX-t.minX)/t.step)), j0=Math.max(0,Math.floor((minY-t.minY)/t.step)), j1=Math.min(t.ny-1,Math.ceil((maxY-t.minY)/t.step))
      for(let j=j0;j<=j1;j++) for(let i=i0;i<=i1;i++){const x=t.minX+i*t.step,y=t.minY+j*t.step;if(inPrism(x,y,p))this.solids[j*t.nx+i]=Math.max(this.solids[j*t.nx+i],p.top)}
    }
  }
  static load(hello:Hello) {
    let dir=hello.map.dir.replace(/\\/g,"/")
    if(!existsSync(`${dir}/v2/world.json`)) dir="./kit/arena"
    const data=JSON.parse(readFileSync(`${dir}/v2/world.json`,"utf8")) as WorldFile
    const raw=readFileSync(`${dir}/v2/${data.terrain.file}`)
    const terrain=new Int16Array(raw.buffer,raw.byteOffset,raw.byteLength/2)
    return new World(data,terrain)
  }
  groundZ(x:number,y:number) { const t=this.data.terrain,fx=(x-t.minX)/t.step,fy=(y-t.minY)/t.step,i=Math.floor(fx),j=Math.floor(fy); if(i<0||j<0||i>=t.nx-1||j>=t.ny-1)return -Infinity; const q=(ii:number,jj:number)=>this.terrain[jj*t.nx+ii]*t.scale, a=fx-i,b=fy-j; return (q(i,j)*(1-a)+q(i+1,j)*a)*(1-b)+(q(i,j+1)*(1-a)+q(i+1,j+1)*a)*b }
  solidTop(x:number,y:number){const t=this.data.terrain,i=Math.round((x-t.minX)/t.step),j=Math.round((y-t.minY)/t.step);return i<0||j<0||i>=t.nx||j>=t.ny?Infinity:this.solids[j*t.nx+i]}
  standZ(x:number,y:number){return Math.max(this.groundZ(x,y),this.solidTop(x,y))}
  los(a:Vec3,b:Vec3){const d=Math.hypot(b[0]-a[0],b[1]-a[1],b[2]-a[2]),n=Math.max(1,Math.ceil(d)); for(let k=1;k<n;k++){const f=k/n,x=a[0]+(b[0]-a[0])*f,y=a[1]+(b[1]-a[1])*f,z=a[2]+(b[2]-a[2])*f;if(z<this.groundZ(x,y)||z<this.solidTop(x,y))return false;for(const p of this.bridges)if(z>=p.base&&z<=p.top&&inPrism(x,y,p))return false}return true}
}
