function $(id){ return document.getElementById(id); }

function toast(msg){
  const el = $("toast");
  if(!el) return alert(msg);
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(()=>el.classList.remove("show"), 2800);
}

async function api(url, method="GET", body=null){
  const opt = { method, headers: {} };
  if(body){
    opt.headers["Content-Type"]="application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(url, opt);
  const data = await r.json().catch(()=>({}));
  if(!r.ok){
    const m = data?.message || `Error ${r.status}`;
    throw new Error(m);
  }
  return data;
}

function formatUsd(n){
  const x = Number(n);
  if(!Number.isFinite(x)) return "$0.00";
  return "$" + x.toFixed(2);
}

function statusLabel(s){
  if(s==="completed") return { text:"مكتملة", cls:"good" };
  if(s==="available") return { text:"جاهزة", cls:"warn" };
  return { text:"مقفلة", cls:"bad" };
}