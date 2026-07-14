// Cove ⇄ Harmony — account API as a Netlify Function (storage: Netlify Blobs)
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const hash=p=>crypto.createHash('sha256').update('cove·salt·'+p).digest('hex');
const token=()=>crypto.randomBytes(24).toString('hex');
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const json=(code,obj)=>new Response(JSON.stringify(obj),{status:code,headers:{'content-type':'application/json'}});

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
    return json(404,{error:'Not found.'});
  }catch(e){
    return json(500,{error:'Server error.'});
  }
};

export const config={ path:'/api/*' };
