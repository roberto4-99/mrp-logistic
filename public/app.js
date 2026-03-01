/* public/app.js
   MRP Logistic - Front helpers
   Fix: handle HTML responses when expecting JSON (Unexpected token '<')
*/

(function () {
  "use strict";

  // ---------- Utils ----------
  function qs(sel, root = document) { return root.querySelector(sel); }
  function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  function showToast(msg) {
    // إذا عندك toast فـ الصفحة غادي يستعملو
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
    // إلا كنا فـ login ما نديروش loop
    if (location.pathname !== "/login") {
      location.href = "/login";
    }
  }

  // ---------- API (FIXED) ----------
  async function api(url, options = {}) {
    const opts = {
      method: "GET",
      credentials: "include",
      headers: {},
      ...options
    };

    // إذا body object => JSON stringify
    if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
      opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, opts);

    // بعض الأحيان السيرفر كيرجع HTML (redirect لصفحة login) => content-type ماشي JSON
    const contentType = (res.headers.get("content-type") || "").toLowerCase();

    // لو كان redirect صريح
    if (res.redirected && res.url) {
      // غالباً مشى ل /login
      safeRedirectToLogin();
      throw new Error("Redirected");
    }

    // لو ماشي JSON
    if (!contentType.includes("application/json")) {
      // خذ شوية من النص باش نعرفو شنو رجع (debug)
      const txt = await res.text().catch(() => "");
      // إلى كان HTML واضح
      if (txt.trim().startsWith("<!DOCTYPE") || txt.trim().startsWith("<html")) {
        safeRedirectToLogin();
        throw new Error("Not JSON (HTML returned)");
      }
      // إذا شي حاجة أخرى
      throw new Error("Response is not JSON");
    }

    const data = await res.json();

    // إذا السيرفر رجع ok:false أو status ماشي 2xx
    if (!res.ok || data?.ok === false) {
      const msg = data?.message || "وقع خطأ فالسيرفر.";
      // إذا 401/403 غالباً session طاحت
      if (res.status === 401 || res.status === 403) safeRedirectToLogin();
      throw new Error(msg);
    }

    return data;
  }

  // نخلي api global حيت صفحاتك كتنادي عليها
  window.api = api;

  // ---------- Auth ----------
  async function handleLoginSubmit(e) {
    e.preventDefault();
    const emailOrPhone = (qs("#emailOrPhone")?.value || "").trim();
    const password = (qs("#password")?.value || "").trim();

    if (!emailOrPhone || !password) {
      showToast("عمر البريد/الهاتف وكلمة المرور.");
      return;
    }

    try {
      const data = await api("/api/login", {
        method: "POST",
        body: { emailOrPhone, password }
      });

      // إلى كان Admin يقدر يمشي /admin وإلا /home
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

    // ref from input or query ?ref=
    const urlRef = new URLSearchParams(location.search).get("ref") || "";
    const ref_code = (qs("#ref_code")?.value || "").trim() || urlRef;

    if (!password || password.length < 6) {
      showToast("كلمة المرور 6 أحرف على الأقل.");
      return;
    }
    if (!email && !phone) {
      showToast("دخل البريد أو الهاتف.");
      return;
    }

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
    // إلا ما كانتش عناصر home ما ندير والو
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

      // تحديث min dep/wd في shortcuts إذا كاينين
      const minDep = me?.settings?.min_deposit_usd ?? 5;
      const minWd = me?.settings?.min_withdraw_usd ?? 10;
      const scMinDep = qs("#scMinDep");
      const scMinWd = qs("#scMinWd");
      if (scMinDep) scMinDep.textContent = `أقل: ${minDep}$`;
      if (scMinWd) scMinWd.textContent = `أقل: ${minWd}$`;

      // Invite code label فقط (واجهة)
      const scInviteCode = qs("#scInviteCode");
      if (scInviteCode) {
        // إذا بغيت تستعمل API ديال referral
        try {
          const ref = await api("/api/referral/me");
          scInviteCode.textContent = ref.code || "رابط خاص";
          // وخلي الرابط يبان فالمودال إلى كاين
          const inviteLink = qs("#inviteLink");
          if (inviteLink) inviteLink.value = ref.link || "";
        } catch (_) {
          // ماشي مشكل
        }
      }

      // load ops count إذا كاين
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
      // إلا session طاحت api() غادي يدير redirect، هنا غير toast
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
        row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(255,255,255,.06);margin-bottom:8px;";
        row.innerHTML = `
          <div style="min-width:0">
            <b style="display:block;font-size:13px">${t.title}</b>
            <div style="opacity:.75;font-size:12px;margin-top:3px">مكافأة: ${t.reward_points} نقطة • انتظار: ${t.wait_seconds}s</div>
          </div>
          <div>${btn}</div>
        `;

        const startBtn = row.querySelector('[data-start="1"]');
        if (startBtn) {
          startBtn.addEventListener("click", async () => {
            try {
              const s = await api("/api/tasks/start", { method: "POST", body: {} });
              showToast(`بدأت المهمة ✅ انتظر ${s.wait_seconds}s`);

              // زر finish إذا عندك
              const runTokenEl = qs("#runToken");
              if (runTokenEl) runTokenEl.value = s.run_token;

              // reload list
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
      if (!run_token) {
        showToast("ماكايناش جلسة مهمة (run_token).");
        return;
      }
      try {
        const r = await api("/api/tasks/finish", { method: "POST", body: { run_token } });
        showToast(r.message || "تم ✅");
        await loadTasksIfExists();
      } catch (e) {
        showToast(e.message || "فشل إنهاء المهمة.");
      }
    });
  }

  // ---------- Wallet request (deposit/withdraw pages) ----------
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

        // إذا عندك مودال التواصل
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
    // login form
    const loginForm = qs("#loginForm");
    if (loginForm) loginForm.addEventListener("submit", handleLoginSubmit);

    // register form
    const registerForm = qs("#registerForm");
    if (registerForm) registerForm.addEventListener("submit", handleRegisterSubmit);

    // pages loaders
    loadHomeIfExists();
    loadTasksIfExists();
    handleFinishTaskIfExists();
    bindWalletButtonsIfExists();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();