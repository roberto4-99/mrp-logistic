/* public/app.js
   MRP Logistic - Front helpers
   FIXED: robust JSON parsing + handle HTML/redirect responses safely
*/

(function () {
  "use strict";

  // ---------- Utils ----------
  function qs(sel, root = document) { return root.querySelector(sel); }
  function showToast(msg) {
    const t = qs("#toast");
    if (t) {
      t.innerHTML = msg;
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), 2600);
      return;
    }
    alert(msg);
  }

  function safeRedirectToLogin() {
    // بلا loop
    if (location.pathname !== "/login") location.href = "/login";
  }

  // Detect HTML (login page / error page)
  function looksLikeHTML(text) {
    const s = String(text || "").trim().toLowerCase();
    return (
      s.startsWith("<!doctype") ||
      s.startsWith("<html") ||
      s.includes("<head") ||
      s.includes("<body")
    );
  }

  // ---------- API (VERY ROBUST) ----------
  async function api(url, options = {}) {
    const opts = {
      method: "GET",
      credentials: "include",
      headers: { ...(options.headers || {}) },
      ...options
    };

    // body object => JSON
    if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
      opts.headers["Content-Type"] = opts.headers["Content-Type"] || "application/json";
      opts.body = JSON.stringify(opts.body);
    }

    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      // Network error
      throw new Error("مشكل فالاتصال بالأنترنت/السيرفر.");
    }

    // fetch كيتبع redirect تلقائيا، وغالبا كيولي /login
    if (res.redirected && res.url) {
      // إذا مشى لصفحة login
      if (res.url.includes("/login")) {
        safeRedirectToLogin();
        throw new Error("تم تسجيل الخروج. عاود دخل.");
      }
    }

    // قرا النص ديما، ومن بعد حاول parse
    const text = await res.text().catch(() => "");

    // إذا رجع HTML غالبا راه redirect ل login ولا page error
    if (looksLikeHTML(text)) {
      // Debug صغير
      console.error("API returned HTML instead of JSON:", {
        url,
        status: res.status,
        redirected: res.redirected,
        finalUrl: res.url,
        preview: text.slice(0, 200)
      });

      // إذا غير مسجّل
      if (res.status === 401 || res.status === 403 || res.url.includes("/login")) {
        safeRedirectToLogin();
        throw new Error("خصك تدير تسجيل الدخول.");
      }

      throw new Error("السيرفر رجّع HTML بدل JSON.");
    }

    // حاول parse JSON حتى إلا header غلط
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      console.error("Not valid JSON:", { url, status: res.status, preview: text.slice(0, 200) });
      throw new Error("الرد ديال السيرفر ماشي JSON.");
    }

    // إذا status ماشي مزيان
    if (!res.ok || data?.ok === false) {
      const msg = data?.message || "وقع خطأ فالسيرفر.";
      if (res.status === 401 || res.status === 403) safeRedirectToLogin();
      throw new Error(msg);
    }

    return data;
  }

  // نخلي api global حيث صفحاتك كتستعملها
  window.api = api;

  // ---------- Auth ----------
  async function handleLoginSubmit(e) {
    e.preventDefault();

    const emailOrPhone = (qs("#emailOrPhone")?.value || "").trim();
    const password = (qs("#password")?.value || "").trim();

    if (!emailOrPhone || !password) return showToast("عمر البريد/الهاتف وكلمة المرور.");

    try {
      const data = await api("/api/login", {
        method: "POST",
        body: { emailOrPhone, password }
      });

      if (data?.is_admin) location.href = "/admin";
      else location.href = "/home";
    } catch (err) {
      showToast(err.message || "فشل تسجيل الدخول.");
    }
  }

  async function handleRegisterSubmit(e) {
    e.preventDefault();

    const full_name = (qs("#full_name")?.value || "").trim();
    const email = (qs("#email")?.value || "").trim();
    const phone = (qs("#phone")?.value || "").trim();
    const password = (qs("#password")?.value || "").trim();

    const urlRef = new URLSearchParams(location.search).get("ref") || "";
    const ref_code = (qs("#ref_code")?.value || "").trim() || urlRef;

    if (!password || password.length < 6) return showToast("كلمة المرور 6 أحرف على الأقل.");
    if (!email && !phone) return showToast("دخل البريد أو الهاتف.");

    try {
      await api("/api/register", {
        method: "POST",
        body: { full_name, email, phone, password, ref_code }
      });
      showToast("تم إنشاء الحساب ✅");
      location.href = "/login";
    } catch (err) {
      showToast(err.message || "فشل إنشاء الحساب.");
    }
  }

  // ---------- Home helpers ----------
  async function loadHomeIfExists() {
    const appNameEl = qs("#appName");
    const helloEl = qs("#hello");
    const pointsEl = qs("#points");
    const roleEl = qs("#role");
    const statusTxt = qs("#statusTxt");

    if (!appNameEl && !helloEl && !pointsEl) return;

    try {
      const me = await api("/api/me");

      const name = me?.app?.name || "MRP Logistic";
      const full = me?.user?.full_name || "";
      const points = me?.user?.points_balance ?? 0;
      const isAdmin = !!me?.user?.is_admin;

      if (appNameEl) appNameEl.textContent = name;
      if (helloEl) helloEl.textContent = full ? `مرحباً ${full}` : "مرحباً";
      if (pointsEl) pointsEl.textContent = String(points);
      if (roleEl) roleEl.textContent = isAdmin ? "Admin" : "User";
      if (statusTxt) statusTxt.textContent = "متصل ✅";

      const minDep = me?.settings?.min_deposit_usd ?? 5;
      const minWd = me?.settings?.min_withdraw_usd ?? 10;
      const scMinDep = qs("#scMinDep");
      const scMinWd = qs("#scMinWd");
      if (scMinDep) scMinDep.textContent = `أقل: ${minDep}$`;
      if (scMinWd) scMinWd.textContent = `أقل: ${minWd}$`;

      // Referral (اختياري)
      const scInviteCode = qs("#scInviteCode");
      if (scInviteCode) {
        try {
          const ref = await api("/api/referral/me");
          scInviteCode.textContent = ref.code || "رابط خاص";
          const inviteLink = qs("#inviteLink");
          if (inviteLink) inviteLink.value = ref.link || "";
        } catch (_) {
          // ignore
        }
      }

      // Ops count
      const scOpsCount = qs("#scOpsCount");
      if (scOpsCount) {
        try {
          const h = await api("/api/wallet/my");
          const rows = h?.rows || [];
          scOpsCount.textContent = `${rows.length || 0} عملية`;
        } catch (_) {
          scOpsCount.textContent = "0 عملية";
        }
      }
    } catch (err) {
      if (statusTxt) statusTxt.textContent = "غير متصل ❗";
      showToast(err.message || "وقع مشكل فـ /api/me");
    }
  }

  // ---------- Tasks ----------
  async function loadTasksIfExists() {
    const list = qs("#tasksList");
    if (!list) return;

    try {
      const data = await api("/api/tasks");
      const rows = data?.rows || [];
      list.innerHTML = "";

      if (!rows.length) {
        list.innerHTML = `<div style="opacity:.8">ماكايناش مهام.</div>`;
        return;
      }

      for (const t of rows) {
        const status = t.status || "locked";
        const btn =
          status === "available"
            ? `<button class="pill" data-start="1">بدء</button>`
            : status === "completed"
              ? `<span style="opacity:.8">مكتملة ✅</span>`
              : `<span style="opacity:.6">مقفولة 🔒</span>`;

        const row = document.createElement("div");
        row.style.cssText =
          "display:flex;align-items:center;justify-content:space-between;gap:10px;" +
          "padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:16px;" +
          "background:rgba(255,255,255,.06);margin-bottom:8px;";

        row.innerHTML = `
          <div style="min-width:0">
            <b style="display:block;font-size:13px">${t.title}</b>
            <div style="opacity:.75;font-size:12px;margin-top:3px">
              مكافأة: ${t.reward_points} نقطة • انتظار: ${t.wait_seconds}s
            </div>
          </div>
          <div>${btn}</div>
        `;

        const startBtn = row.querySelector('[data-start="1"]');
        if (startBtn) {
          startBtn.addEventListener("click", async () => {
            try {
              const s = await api("/api/tasks/start", { method: "POST", body: {} });
              showToast(`بدأت المهمة ✅ انتظر ${s.wait_seconds}s`);
              const runTokenEl = qs("#runToken");
              if (runTokenEl) runTokenEl.value = s.run_token;
              await loadTasksIfExists();
            } catch (e) {
              showToast(e.message || "ماقدرتش نبدأ المهمة.");
            }
          });
        }

        list.appendChild(row);
      }
    } catch (err) {
      showToast(err.message || "مشكل فـ /api/tasks");
    }
  }

  async function handleFinishTaskIfExists() {
    const btn = qs("#finishTaskBtn");
    if (!btn) return;

    btn.addEventListener("click", async () => {
      const run_token = (qs("#runToken")?.value || "").trim();
      if (!run_token) return showToast("ماكايناش جلسة مهمة (run_token).");

      try {
        const r = await api("/api/tasks/finish", { method: "POST", body: { run_token } });
        showToast(r.message || "تم ✅");
        await loadTasksIfExists();
      } catch (e) {
        showToast(e.message || "فشل إنهاء المهمة.");
      }
    });
  }

  // ---------- Wallet (deposit/withdraw) ----------
  function bindWalletButtonsIfExists() {
    const depBtn = qs("#depositBtn");
    const wdBtn = qs("#withdrawBtn");
    const amountEl = qs("#amount_usd");

    async function send(type) {
      const amount_usd = (amountEl?.value || "").trim();
      if (!amount_usd) return showToast("دخل المبلغ بالدولار.");

      try {
        const r = await api("/api/wallet/request", { method: "POST", body: { type, amount_usd } });
        showToast(r.message || "تم إرسال الطلب ✅");

        if (typeof window.openContact === "function") {
          const title = type === "deposit" ? "إيداع" : "سحب";
          window.openContact(title, "تواصل مع المدير لإتمام العملية.", amount_usd);
        }
      } catch (e) {
        showToast(e.message || "فشل إرسال الطلب.");
      }
    }

    if (depBtn) depBtn.addEventListener("click", () => send("deposit"));
    if (wdBtn) wdBtn.addEventListener("click", () => send("withdraw"));
  }

  // ---------- Boot ----------
  function boot() {
    const loginForm = qs("#loginForm");
    if (loginForm) loginForm.addEventListener("submit", handleLoginSubmit);

    const registerForm = qs("#registerForm");
    if (registerForm) registerForm.addEventListener("submit", handleRegisterSubmit);

    loadHomeIfExists();
    loadTasksIfExists();
    handleFinishTaskIfExists();
    bindWalletButtonsIfExists();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();