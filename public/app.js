// public/app.js
async function api(url, method = "GET", data) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
    // ✅ مهم باش session cookie تمشي مع الطلب
    credentials: "include"
  };

  if (data !== undefined) opts.body = JSON.stringify(data);

  const res = await fetch(url, opts);

  // ✅ كنحاولو نقراو الرد بطريقة آمنة
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const isJson = ct.includes("application/json");

  let payload = null;
  if (isJson) {
    payload = await res.json();
  } else {
    // إذا رجع HTML ولا Text
    const txt = await res.text();
    // خلي نص قصير باش ما يطولش
    payload = { ok: false, message: txt?.slice(0, 180) || "Invalid response" };
  }

  // ✅ تعامل واضح مع الأخطاء
  if (!res.ok) {
    const msg =
      payload?.message ||
      payload?.error ||
      `Request failed (${res.status})`;
    throw new Error(msg);
  }

  return payload;
}