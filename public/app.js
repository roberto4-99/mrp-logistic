/* =========================
   Simple API helper
   ========================= */

async function api(url, options = {}) {
  const opts = {
    credentials: "include", // مهم للسيسيون
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  };

  try {
    const res = await fetch(url, opts);

    // إذا كان غير مسموح (session سالات)
    if (res.status === 401 || res.status === 403) {
      window.location.href = "/login";
      return;
    }

    const data = await res.json();

    if (!data.ok && data.message) {
      throw new Error(data.message);
    }

    return data;
  } catch (err) {
    console.error("API error:", err);
    throw err;
  }
}

/* =========================
   Helpers
   ========================= */

function $(id) {
  return document.getElementById(id);
}

function showToast(msg) {
  const t = $("toast");
  if (!t) return;
  t.innerHTML = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}

/* =========================
   Auth forms (login / register)
   ========================= */

async function submitLogin(e) {
  e.preventDefault();

  const emailOrPhone = $("emailOrPhone").value.trim();
  const password = $("password").value;

  try {
    const r = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ emailOrPhone, password })
    });

    if (r.ok) {
      window.location.href = "/home";
    }
  } catch (err) {
    showToast(err.message || "خطأ في تسجيل الدخول");
  }
}

async function submitRegister(e) {
  e.preventDefault();

  const full_name = $("full_name").value.trim();
  const email = $("email")?.value.trim();
  const phone = $("phone")?.value.trim();
  const password = $("password").value;

  // ref من الرابط
  const params = new URLSearchParams(window.location.search);
  const ref_code = params.get("ref");

  try {
    const r = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({
        full_name,
        email,
        phone,
        password,
        ref_code
      })
    });

    if (r.ok) {
      window.location.href = "/login";
    }
  } catch (err) {
    showToast(err.message || "خطأ في التسجيل");
  }
}

/* =========================
   Wallet
   ========================= */

async function sendWalletRequest(type, amount) {
  try {
    const r = await api("/api/wallet/request", {
      method: "POST",
      body: JSON.stringify({
        type,
        amount_usd: amount
      })
    });

    if (r.ok) {
      showToast("تم إرسال الطلب ✅");
    }
  } catch (err) {
    showToast(err.message || "فشل الطلب");
  }
}

/* =========================
   Tasks
   ========================= */

async function startTask() {
  try {
    const r = await api("/api/tasks/start", {
      method: "POST"
    });

    if (r.ok) {
      showToast("بدأت المهمة ⏳");
    }
  } catch (err) {
    showToast(err.message);
  }
}

async function finishTask(run_token) {
  try {
    const r = await api("/api/tasks/finish", {
      method: "POST",
      body: JSON.stringify({ run_token })
    });

    if (r.ok) {
      showToast("تمت المهمة ✅");
      location.reload();
    }
  } catch (err) {
    showToast(err.message);
  }
}