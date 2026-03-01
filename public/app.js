// public/app.js

async function api(url, opts = {}) {
  const isBodyObject =
    opts.body &&
    typeof opts.body === "object" &&
    !(opts.body instanceof FormData) &&
    !(opts.body instanceof URLSearchParams);

  const headers = Object.assign(
    { Accept: "application/json" },
    isBodyObject ? { "Content-Type": "application/json" } : {},
    opts.headers || {}
  );

  const res = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: isBodyObject ? JSON.stringify(opts.body) : (opts.body || undefined),

    // ✅ أهم سطر: باش session cookie تمشي مع الطلب
    // إذا نفس الدومين: same-origin (أفضل)
    // إذا front فـ دومين مختلف: بدّلها لـ "include"
    credentials: "same-origin"
  });

  const ct = (res.headers.get("content-type") || "").toLowerCase();

  // حاول نقرا JSON إلا كان
  let data = null;
  if (ct.includes("application/json")) {
    data = await res.json().catch(() => null);
  } else {
    // إلا رجع HTML (مثلا redirect/login) كنقرّاه نص باش نعرفو شنو وقع
    const txt = await res.text().catch(() => "");
    data = { ok: false, message: "Unexpected response (not JSON)", _text: txt };
  }

  if (!res.ok || (data && data.ok === false)) {
    // إذا API رجع 401 => رجّع المستخدم للـ login
    if (res.status === 401) {
      // من الأفضل نرجعو للـ login مباشرة
      window.location.href = "/login";
      throw new Error("UNAUTH");
    }

    const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return data;
}

// Helpers
async function apiPost(url, body) {
  return api(url, { method: "POST", body });
}