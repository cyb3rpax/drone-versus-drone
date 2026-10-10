// Cove ⇄ Harmony — account API as a Netlify Function (storage: Netlify Blobs)
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const hash=p=>crypto.createHash('sha256').update('cove·salt·'+p).digest('hex');
const token=()=>crypto.randomBytes(24).toString('hex');
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const json=(code,obj)=>new Response(JSON.stringify(obj),{status:code,headers:{'content-type':'application/json'}});

const R_EARTH_MI=3958.8;
export function haversineMi(la1,lo1,la2,lo2){
  const rad=x=>x*Math.PI/180, dLa=rad(la2-la1), dLo=rad(lo2-lo1);
  const h=Math.sin(dLa/2)**2+Math.cos(rad(la1))*Math.cos(rad(la2))*Math.sin(dLo/2)**2;
  return 2*R_EARTH_MI*Math.asin(Math.sqrt(h));
}
// A real flight is a GPS track: start near FROM, reach TO, come back to FROM. Speeds must be drone-plausible.
export function checkTrack(points,from,to){
  const NEAR=0.06;                                            // ~100 m — GPS on a phone is not surgical
  if(!Array.isArray(points)||points.length<6) return {error:'Not enough GPS points — keep the Fly page open for the whole flight.'};
  const pts=[];
  for(const p of points.slice(0,5000)){
    const lat=+p.lat, lon=+p.lon, t=+p.t;
    if(!isFinite(lat)||!isFinite(lon)||!isFinite(t)||Math.abs(lat)>90||Math.abs(lon)>180) return {error:'Bad GPS point in the track.'};
    pts.push({lat,lon,t});
  }
  pts.sort((x,y)=>x.t-y.t);
  const secs=Math.round((pts[pts.length-1].t-pts[0].t)/1000);
  if(secs<20) return {error:'That flight was too short to count.'};
  if(secs>3*3600) return {error:'That flight was too long to count (over 3 hours).'};
  const d=(p,q)=>haversineMi(p.lat,p.lon,q.lat,q.lon);
  if(d(pts[0],from)>NEAR) return {error:'The track doesn’t start at the mission’s start point.'};
  let reached=-1;
  for(let i=0;i<pts.length;i++){ if(d(pts[i],to)<=NEAR){ reached=i; break; } }
  if(reached<0) return {error:'The track never reached the destination.'};
  let back=false; for(let i=reached;i<pts.length;i++){ if(d(pts[i],from)<=NEAR){ back=true; break; } }
  if(!back) return {error:'You reached the destination but the track never came back to the start.'};
  let dist=0;
  for(let i=1;i<pts.length;i++){
    const leg=d(pts[i-1],pts[i]), dt=(pts[i].t-pts[i-1].t)/1000;
    if(dt>0&&leg/(dt/3600)>70) return {error:'Part of the track moved faster than any small drone (over 70 mph).'};
    dist+=leg;
  }
  const miles=+Math.max(d(from,to)*2,dist*0.9).toFixed(2);
  if(d(from,to)<0.03) return {error:'Start and destination are too close together for a real mission.'};
  return {secs,miles};
}
export function realPayout(mi,v){
  const CARGO=[1,1.15,1.45,1.6,1.75,2.2];
  const m=/^MRN-?([0-9A-Z]{1,6})$/.exec(String(mi.code||'').toUpperCase()); const val=m?parseInt(m[1],36):0;
  const cargo=(val>>5)&7, birds=(val>>3)&3, wind=(val>>1)&3, dusk=val&1;
  const hazard=1+birds*0.09+wind*0.08+(dusk?0.18:0);
  const base=60+v.miles/2*22;                                // same formula as the game, one-way miles
  return Math.min(5000,Math.round(base*(CARGO[cargo]||1)*hazard*10));   // real flights pay 10× the game
}
export default async (req)=>{
  const accounts=getStore('accounts');
  const sessions=getStore('sessions');
  const url=new URL(req.url);
  const route=url.pathname.split('/').pop();

  async function authed(){
    const m=(req.headers.get('authorization')||'').match(/^Bearer\s+(\w+)$/);
    if(!m) return null;
    const email=await sessions.get(m[1]);
    if(!email) return null;
    return await accounts.get(email,{type:'json'});
  }

  try{
    if(route==='register'&&req.method==='POST'){
      const b=await req.json();
      const user=String(b.user||'').trim(), email=String(b.email||'').trim().toLowerCase(), pass=String(b.pass||'');
      if(user.length<3) return json(400,{error:'Username needs at least 3 characters.'});
      if(!EMAIL_RE.test(email)) return json(400,{error:'That doesn’t look like a valid email.'});
      if(pass.length<4) return json(400,{error:'Password needs at least 4 characters.'});
      if(await accounts.get(email)) return json(409,{error:'An account with that email already exists — log in instead.'});
      const acc={user,email,pass:hash(pass),created:Date.now(),save:null};
      await accounts.setJSON(email,acc);
      const t=token(); await sessions.set(t,email);
      return json(200,{token:t,user,save:null});
    }
    if(route==='login'&&req.method==='POST'){
      const b=await req.json();
      const email=String(b.email||'').trim().toLowerCase(), pass=String(b.pass||'');
      const a=await accounts.get(email,{type:'json'});
      if(!a||a.pass!==hash(pass)) return json(401,{error:'Wrong email or password.'});
      const t=token(); await sessions.set(t,email);
      return json(200,{token:t,user:a.user,save:a.save});
    }
    if(route==='me'&&req.method==='GET'){
      const a=await authed();
      if(!a) return json(401,{error:'Not logged in.'});
      return json(200,{user:a.user,email:a.email,save:a.save});
    }
    if(route==='save'&&req.method==='POST'){
      const a=await authed();
      if(!a) return json(401,{error:'Not logged in.'});
      const b=await req.json();
      a.save=b.save||null;
      await accounts.setJSON(a.email,a);
      return json(200,{ok:true});
    }
    // --- public leaderboard: top pilots by trips, then coins ---
    if(route==='leaderboard'&&req.method==='GET'){
      const out=[];
      try{
        const {blobs}=await accounts.list();
        const keys=(blobs||[]).slice(0,300);
        for(const bl of keys){
          const acc=await accounts.get(bl.key,{type:'json'});
          if(!acc||!acc.save) continue;
          out.push({user:acc.user, trips:acc.save.trips||0, coins:Math.floor(acc.save.money||0), drone:acc.save.curDrone||'sparrow'});
        }
      }catch(e){}
      out.sort((x,y)=>y.trips-x.trips||y.coins-x.coins);
      return json(200,{pilots:out.slice(0,25), total:out.length});
    }
    // --- game-wide announcement: owner posts once, every pilot sees it ---
    if(route==='announce'&&req.method==='GET'){
      const msgs=getStore('broadcast');
      const cur=await msgs.get('current',{type:'json'});
      return json(200,cur||{});
    }
    if(route==='setannounce'&&req.method==='GET'){
      const secret=url.searchParams.get('secret')||'';
      if(!process.env.ADMIN_SECRET||secret!==process.env.ADMIN_SECRET){
        return json(403,{error:'Owner only. Call /api/setannounce?secret=YOURSECRET&msg=Your+message (add &clear=1 to remove).'});
      }
      const msgs=getStore('broadcast');
      if(url.searchParams.get('clear')){
        await msgs.setJSON('current',{});
        return json(200,{ok:true,cleared:true});
      }
      const text=(url.searchParams.get('msg')||'').slice(0,240);
      if(!text) return json(400,{error:'Add &msg=Your+message'});
      const payload={id:'b'+Date.now(), text, at:Date.now()};
      await msgs.setJSON('current',payload);
      return json(200,{ok:true,posted:payload});
    }

    // --- Stripe webhook: coins credit themselves the moment someone pays ---
    if(route==='stripe-webhook'&&req.method==='POST'){
      const secret=process.env.STRIPE_WEBHOOK_SECRET||'';
      if(!secret) return json(503,{error:'Set STRIPE_WEBHOOK_SECRET in Netlify environment variables.'});
      const payload=await req.text();
      const sig=req.headers.get('stripe-signature')||'';
      const t=(sig.match(/t=(\d+)/)||[])[1];
      const v1=(sig.match(/v1=([0-9a-f]+)/)||[])[1];
      if(!t||!v1) return json(400,{error:'bad signature'});
      const expected=crypto.createHmac('sha256',secret).update(t+'.'+payload).digest('hex');
      if(expected!==v1) return json(400,{error:'bad signature'});
      let ev; try{ ev=JSON.parse(payload); }catch(e){ return json(400,{error:'bad json'}); }
      if(ev.type==='checkout.session.completed'&&/^K-[0-9A-Z]{6}$/.test(String(((ev.data||{}).object||{}).client_reference_id||''))){
        const s=ev.data.object, id=s.client_reference_id;
        const orders=getStore('orders');
        const o=(await orders.get(id,{type:'json'}))||{id,qty:1,created:Date.now()};
        const ship=(s.collected_information&&s.collected_information.shipping_details)||s.shipping_details||{};
        const cd=s.customer_details||{};
        const unit=parseInt(process.env.KIT_PRICE_CENTS||'14900',10)||14900;
        const qty=Math.max(1,Math.round((s.amount_subtotal||s.amount_total||unit)/unit));
        Object.assign(o,{status:'paid',paidAt:Date.now(),amount:s.amount_total||0,qty,
          email:String(cd.email||o.email||'').toLowerCase(),name:ship.name||cd.name||o.name||'',
          address:ship.address||cd.address||null,phone:cd.phone||'',stripeSession:s.id||''});
        await orders.setJSON(id,o);
        return json(200,{received:true,order:id});
      }
      if(ev.type==='checkout.session.completed'){
        const s=(ev.data&&ev.data.object)||{};
        let email='';
        try{
          const ref=String(s.client_reference_id||'');
          if(ref) email=Buffer.from(ref.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8').toLowerCase();
        }catch(e){}
        if(!email&&s.customer_details&&s.customer_details.email) email=String(s.customer_details.email).toLowerCase();
        const amount=s.amount_total||0;                       // cents
        const coins=amount>=499?5000:amount>=199?1500:amount>=99?500:0;
        if(email&&coins){
          const a=await accounts.get(email,{type:'json'});
          if(a){ a.pending=(a.pending||0)+coins; await accounts.setJSON(email,a); }
        }
      }
      return json(200,{received:true});
    }
    // --- players collect webhook-credited coins here ---
    if(route==='claim'&&req.method==='POST'){
      const a=await authed();
      if(!a) return json(401,{error:'Not logged in.'});
      const p=a.pending||0;
      if(p>0){ a.pending=0; await accounts.setJSON(a.email,a); }
      return json(200,{coins:p});
    }
    // --- coin codes: sell packs, hand out a code, player redeems it here ---
    if(route==='redeem'&&req.method==='POST'){
      const a=await authed();
      if(!a) return json(401,{error:'Not logged in.'});
      const b=await req.json();
      const code=String(b.code||'').trim().toUpperCase();
      if(!code) return json(400,{error:'Enter a code.'});
      const codes=getStore('codes');
      const c=await codes.get(code,{type:'json'});
      if(!c) return json(404,{error:'That code isn’t valid.'});
      if(c.used) return json(409,{error:'That code was already redeemed.'});
      c.used=true; c.by=a.email; c.at=Date.now();
      await codes.setJSON(code,c);
      return json(200,{coins:c.coins});
    }
    if(route==='gencode'&&req.method==='GET'){
      const secret=url.searchParams.get('secret')||'';
      if(!process.env.ADMIN_SECRET||secret!==process.env.ADMIN_SECRET){
        return json(403,{error:'Owner only. Set an ADMIN_SECRET environment variable in Netlify, then call /api/gencode?secret=YOURSECRET&coins=500&n=5'});
      }
      const coins=Math.max(1,parseInt(url.searchParams.get('coins')||'500',10));
      const n=Math.min(20,Math.max(1,parseInt(url.searchParams.get('n')||'1',10)));
      const codes=getStore('codes');
      const out=[];
      for(let i=0;i<n;i++){
        const code='DC-'+crypto.randomBytes(4).toString('hex').toUpperCase();
        await codes.setJSON(code,{coins,used:false,created:Date.now()});
        out.push(code);
      }
      return json(200,{coins,codes:out});
    }
    // --- public mission board: any pilot posts a mission, every pilot can fly it ---
    const MISSION_RE=/^(?:MRN-?)?([0-9A-Z]{1,6})$/;
    const validCode=c=>{ const m=MISSION_RE.exec(String(c||'').trim().toUpperCase()); if(!m) return null;
      const v=parseInt(m[1],36); if(!isFinite(v)||v<=0) return null;
      const miles=(v>>8)/10, cargo=(v>>5)&7; if(miles<0.1||miles>51.1||cargo>5) return null;
      return 'MRN-'+v.toString(36).toUpperCase().padStart(4,'0'); };
    const clean=t=>String(t||'').replace(/[<>]/g,'').trim();
    if(route==='missions'&&req.method==='GET'){
      const board=getStore('missions');
      const out=[];
      try{
        const {blobs}=await board.list();
        for(const bl of (blobs||[]).slice(0,400)){ const mi=await board.get(bl.key,{type:'json'}); if(mi&&!mi.hidden) out.push(mi); }
      }catch(e){}
      out.sort((x,y)=>(y.at||0)-(x.at||0));
      return json(200,{missions:out.slice(0,80), total:out.length});
    }
    if(route==='postmission'&&req.method==='POST'){
      const a=await authed();
      if(!a) return json(401,{error:'Log in to post a mission.'});
      const b=await req.json();
      const code=validCode(b.code);
      if(!code) return json(400,{error:'That mission code isn’t valid.'});
      const name=clean(b.name).slice(0,22)||'Custom run';
      const brief=clean(b.brief).slice(0,140);
      const board=getStore('missions');
      const cur=await board.get(code,{type:'json'});
      if(cur&&cur.byEmail!==a.email) return json(409,{error:'Someone already posted that exact mission — fly it from the board instead.'});
      const pt=o=>{ if(!o||typeof o!=='object') return null; const lat=+o.lat, lon=+o.lon;
        if(!isFinite(lat)||!isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180) return null;
        return {name:clean(o.name).slice(0,60)||'Pin',lat:+lat.toFixed(5),lon:+lon.toFixed(5)}; };
      const from=pt(b.from), to=pt(b.to);
      let miles=+b.miles; miles=(from&&isFinite(miles)&&miles>=0.1&&miles<=60)?+miles.toFixed(1):null;
      const mi=Object.assign({code,flights:0,best:null,bestBy:null,at:Date.now()},cur||{},{name,brief,from,to,miles,by:a.user,byEmail:a.email});
      await board.setJSON(code,mi);
      const pub=Object.assign({},mi); delete pub.byEmail;
      return json(200,{mission:pub});
    }
    if(route==='flown'&&req.method==='POST'){
      const a=await authed();
      if(!a) return json(401,{error:'Not logged in.'});
      const b=await req.json();
      const code=validCode(b.code), secs=Math.max(1,Math.min(36000,Math.round(+b.secs||0)));
      if(!code) return json(400,{error:'bad code'});
      const board=getStore('missions');
      const mi=await board.get(code,{type:'json'});
      if(!mi) return json(404,{error:'That mission isn’t on the board.'});
      mi.flights=(mi.flights||0)+1;
      let record=false;
      if(!mi.best||secs<mi.best){ mi.best=secs; mi.bestBy=a.user; record=true; }
      await board.setJSON(code,mi);
      return json(200,{flights:mi.flights,best:mi.best,bestBy:mi.bestBy,record});
    }
    if(route==='delmission'&&req.method==='GET'){
      const secret=url.searchParams.get('secret')||'';
      if(!process.env.ADMIN_SECRET||secret!==process.env.ADMIN_SECRET) return json(403,{error:'Owner only. Call /api/delmission?secret=YOURSECRET&code=MRN-XXXX'});
      const code=validCode(url.searchParams.get('code')); if(!code) return json(400,{error:'bad code'});
      const board=getStore('missions'); const mi=await board.get(code,{type:'json'});
      if(mi){ mi.hidden=true; await board.setJSON(code,mi); }
      return json(200,{ok:true,hidden:code});
    }
    // --- kit shop: order → pay → we ship → it arrives ---
    const newOrderId=()=>'K-'+crypto.randomBytes(4).readUInt32BE(0).toString(36).toUpperCase().padStart(6,'0').slice(-6);
    if(route==='order'&&req.method==='POST'){
      const link=process.env.KIT_PAYMENT_LINK||'';
      if(!link) return json(503,{error:'Checkout isn’t switched on yet — the shop owner needs to add the payment link.'});
      const b=await req.json();
      const qty=Math.max(1,Math.min(10,parseInt(b.qty||'1',10)||1));
      const email=String(b.email||'').trim().toLowerCase();
      if(email&&!EMAIL_RE.test(email)) return json(400,{error:'That doesn’t look like a valid email.'});
      const orders=getStore('orders');
      let id=newOrderId(); for(let k=0;k<4&&(await orders.get(id));k++) id=newOrderId();
      await orders.setJSON(id,{id,qty,email,status:'awaiting payment',created:Date.now()});
      const u=new URL(link); u.searchParams.set('client_reference_id',id); if(email) u.searchParams.set('prefilled_email',email);
      return json(200,{id,url:u.toString()});
    }
    if(route==='orderstatus'&&req.method==='GET'){
      const id=String(url.searchParams.get('id')||'').trim().toUpperCase(), email=String(url.searchParams.get('email')||'').trim().toLowerCase();
      const o=/^K-[0-9A-Z]{6}$/.test(id)?await getStore('orders').get(id,{type:'json'}):null;
      if(!o) return json(404,{error:'No order with that number.'});
      if(o.email&&email&&o.email!==email) return json(404,{error:'No order with that number and email.'});
      return json(200,{id:o.id,status:o.status,qty:o.qty,created:o.created,paidAt:o.paidAt||null,shippedAt:o.shippedAt||null,deliveredAt:o.deliveredAt||null,carrier:o.carrier||'',tracking:o.tracking||'',city:o.address?o.address.city:''});
    }
    if(route==='orders'&&req.method==='GET'){
      if(!(await isAdmin())) return json(403,{error:'Admins only.'});
      const orders=getStore('orders'); const out=[];
      try{ const {blobs}=await orders.list(); for(const bl of blobs||[]){ const o=await orders.get(bl.key,{type:'json'}); if(o) out.push(o); } }catch(e){}
      const rank={'paid':0,'shipped':1,'delivered':2,'awaiting payment':3};
      out.sort((x,y)=>(rank[x.status]??9)-(rank[y.status]??9)||(x.created||0)-(y.created||0));
      return json(200,{orders:out.filter(o=>o.status!=='awaiting payment'||Date.now()-o.created<7*864e5)});
    }
    if(route==='orderupdate'&&req.method==='POST'){
      if(!(await isAdmin())) return json(403,{error:'Admins only.'});
      const b=await req.json(); const orders=getStore('orders');
      const o=await orders.get(String(b.id||''),{type:'json'}); if(!o) return json(404,{error:'No such order.'});
      if(b.action==='ship'){ o.status='shipped'; o.shippedAt=Date.now(); o.carrier=clean(b.carrier).slice(0,20)||'USPS'; o.tracking=clean(b.tracking).replace(/\s+/g,'').slice(0,40); }
      else if(b.action==='deliver'){ o.status='delivered'; o.deliveredAt=Date.now(); }
      else if(b.action==='paid'){ o.status='paid'; o.paidAt=o.paidAt||Date.now(); }
      else return json(400,{error:'bad action'});
      await orders.setJSON(o.id,o); return json(200,{order:o});
    }
    // --- kit shop: pre-orders / waitlist (name + email + how many) ---
    if(route==='preorder'&&req.method==='POST'){
      const b=await req.json();
      const email=String(b.email||'').trim().toLowerCase(), name=clean(b.name).slice(0,60), qty=Math.max(1,Math.min(20,parseInt(b.qty||'1',10)||1));
      if(!EMAIL_RE.test(email)) return json(400,{error:'That doesn’t look like a valid email.'});
      const pre=getStore('preorders');
      const cur=(await pre.get(email,{type:'json'}))||{email,created:Date.now()};
      Object.assign(cur,{name,qty,note:clean(b.note).slice(0,200),updated:Date.now()});
      await pre.setJSON(email,cur);
      let count=0; try{ const {blobs}=await pre.list(); count=(blobs||[]).length; }catch(e){}
      return json(200,{ok:true,position:count});
    }
    if(route==='preorders'&&req.method==='GET'){
      const secret=url.searchParams.get('secret')||'';
      if(!process.env.ADMIN_SECRET||secret!==process.env.ADMIN_SECRET) return json(403,{error:'Owner only. Call /api/preorders?secret=YOURSECRET'});
      const pre=getStore('preorders'); const out=[];
      try{ const {blobs}=await pre.list(); for(const bl of blobs||[]){ const o=await pre.get(bl.key,{type:'json'}); if(o) out.push(o); } }catch(e){}
      out.sort((x,y)=>(x.created||0)-(y.created||0));
      return json(200,{count:out.length,units:out.reduce((n,o)=>n+(o.qty||1),0),preorders:out});
    }
    // --- real-world missions: a phone logs a GPS track, the server checks it and pays coins into the game ---
    if(route==='realflight'&&req.method==='POST'){
      const a=await authed();
      if(!a) return json(401,{error:'Not logged in.'});
      const b=await req.json();
      const code=validCode(b.code); if(!code) return json(400,{error:'bad code'});
      const board=getStore('missions'); const mi=await board.get(code,{type:'json'});
      if(!mi||mi.hidden) return json(404,{error:'That mission isn’t on the board.'});
      const home=(a.save&&a.save.route&&isFinite(+a.save.route.lat))?{lat:+a.save.route.lat,lon:+a.save.route.lon}:null;
      const from=mi.from||home, to=mi.to||{lat:37.89431,lon:-122.49288};
      if(!from) return json(400,{error:'Set your home base in the game first — that’s where this mission starts.'});
      const v=checkTrack(b.points,from,to);
      if(v.error) return json(400,{error:v.error});
      const pay=realPayout(mi,v);
      a.pending=(a.pending||0)+pay;
      a.real=(a.real||0)+1;
      await accounts.setJSON(a.email,a);
      mi.real=(mi.real||0)+1;
      let record=false;
      if(!mi.realBest||v.secs<mi.realBest){ mi.realBest=v.secs; mi.realBestBy=a.user; record=true; }
      await board.setJSON(code,mi);
      const flights=getStore('realflights');
      await flights.setJSON(a.email+'·'+code+'·'+Date.now(),{user:a.user,code,secs:v.secs,miles:v.miles,pay,at:Date.now(),n:(b.points||[]).length});
      return json(200,{ok:true,pay,secs:v.secs,miles:v.miles,record,real:mi.real});
    }
    // --- global chat: anyone logged in can say anything, everyone sees it with their name ---
    if(route==='chat'&&req.method==='GET'){
      const chat=getStore('chat');
      const log=(await chat.get('log',{type:'json'}))||[];
      const since=parseInt(url.searchParams.get('since')||'0',10)||0;
      return json(200,{messages:log.filter(m=>m.id>since&&m.kind!=='event').slice(-120), latest:log.length?log[log.length-1].id:0});
    }
    if(route==='chatsend'&&req.method==='POST'){
      const a=await authed();
      if(!a) return json(401,{error:'Log in to chat.'});
      const b=await req.json();
      const text=clean(b.text).replace(/\s+/g,' ').slice(0,200);
      if(!text) return json(400,{error:'Say something first.'});
      if(a.muted) return json(403,{error:'You’ve been muted by the owner.'});
      const now=Date.now();
      if(a.lastChat&&now-a.lastChat<1500) return json(429,{error:'Slow down a little.'});
      a.lastChat=now; await accounts.setJSON(a.email,a);
      const chat=getStore('chat');
      const log=(await chat.get('log',{type:'json'}))||[];
      const id=(log.length?log[log.length-1].id:0)+1;
      const msg={id,user:a.user,text,at:now};
      log.push(msg); while(log.length>300) log.shift();
      await chat.setJSON('log',log);
      return json(200,{ok:true,message:msg});
    }
    // --- admin sign-in (password = ADMIN_SECRET env var) + bulletin board everyone sees ---
    async function isAdmin(){
      const m=(req.headers.get('authorization')||'').match(/^Bearer\s+(\w+)$/);
      if(!m) return false;
      return (await sessions.get('admin:'+m[1]))==='1';
    }
    if(route==='adminlogin'&&req.method==='POST'){
      const b=await req.json();
      if(!process.env.ADMIN_SECRET) return json(503,{error:'Set ADMIN_SECRET in Netlify environment variables first.'});
      if(String(b.secret||'')!==process.env.ADMIN_SECRET){ await new Promise(r=>setTimeout(r,800)); return json(403,{error:'Wrong admin password.'}); }
      const t=token(); await sessions.set('admin:'+t,'1');
      return json(200,{token:t});
    }
    if(route==='bulletin'&&req.method==='GET'){
      const bb=getStore('bulletin');
      const posts=(await bb.get('posts',{type:'json'}))||[];
      return json(200,{posts:posts.slice().sort((x,y)=>(y.pinned?1:0)-(x.pinned?1:0)||y.id-x.id)});
    }
    if(route==='bulletinpost'&&req.method==='POST'){
      if(!(await isAdmin())) return json(403,{error:'Admins only — sign in as admin.'});
      const b=await req.json();
      const title=clean(b.title).slice(0,80), text=clean(b.text).slice(0,1200);
      if(!title&&!text) return json(400,{error:'Write something first.'});
      const bb=getStore('bulletin');
      const posts=(await bb.get('posts',{type:'json'}))||[];
      const id=(posts.reduce((n,p)=>Math.max(n,p.id),0))+1;
      const post={id,title,text,pinned:!!b.pinned,at:Date.now()};
      posts.push(post); while(posts.length>60) posts.shift();
      await bb.setJSON('posts',posts);
      return json(200,{post});
    }
    if(route==='bulletindel'&&req.method==='POST'){
      if(!(await isAdmin())) return json(403,{error:'Admins only.'});
      const b=await req.json(); const id=parseInt(b.id,10);
      const bb=getStore('bulletin');
      const posts=((await bb.get('posts',{type:'json'}))||[]).filter(p=>p.id!==id);
      await bb.setJSON('posts',posts);
      return json(200,{ok:true});
    }
    if(route==='chatmod'&&req.method==='GET'){
      const secret=url.searchParams.get('secret')||'';
      if(!process.env.ADMIN_SECRET||secret!==process.env.ADMIN_SECRET) return json(403,{error:'Owner only. /api/chatmod?secret=S&clear=1  or  &mute=EMAIL  or  &unmute=EMAIL  or  &del=ID'});
      const chat=getStore('chat');
      if(url.searchParams.get('clear')){ await chat.setJSON('log',[]); return json(200,{ok:true,cleared:true}); }
      const del=parseInt(url.searchParams.get('del')||'0',10);
      if(del){ const log=(await chat.get('log',{type:'json'}))||[]; await chat.setJSON('log',log.filter(m=>m.id!==del)); return json(200,{ok:true,deleted:del}); }
      for(const k of ['mute','unmute']){ const em=(url.searchParams.get(k)||'').toLowerCase(); if(em){ const acc=await accounts.get(em,{type:'json'}); if(!acc) return json(404,{error:'no such pilot'}); acc.muted=(k==='mute'); await accounts.setJSON(em,acc); return json(200,{ok:true,[k]:em}); } }
      return json(400,{error:'nothing to do'});
    }
    return json(404,{error:'Not found.'});
  }catch(e){
    return json(500,{error:'Server error.'});
  }
};

export const config={ path:'/api/*' };
