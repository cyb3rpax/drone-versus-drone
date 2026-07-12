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
    return json(404,{error:'Not found.'});
  }catch(e){
    return json(500,{error:'Server error.'});
  }
};

export const config={ path:'/api/*' };
