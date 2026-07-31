(function () {
  const params = new URLSearchParams(location.search);
  const errEl = document.getElementById("login-error");
  const setupPanel = document.getElementById("setup-panel");
  const redirectInput = document.getElementById("redirect-uri");
  const clientIdInput = document.getElementById("client-id");
  const secretInput = document.getElementById("client-secret");
  const saveBtn = document.getElementById("setup-save");
  const msgEl = document.getElementById("setup-msg");
  const msBtn = document.getElementById("ms-login-btn");

  function showError(text) {
    if (!errEl) return;
    if (!text) {
      errEl.hidden = true;
      errEl.textContent = "";
      return;
    }
    errEl.hidden = false;
    errEl.textContent = text;
  }

  const err = params.get("error");
  if (err) showError(err);
  if (params.get("need_setup") === "1" && setupPanel) {
    setupPanel.open = true;
  }

  async function boot() {
    try {
      const meRes = await fetch("/api/auth/me", { credentials: "same-origin" });
      const me = await meRes.json();
      if (me.authenticated) {
        location.replace("/");
        return;
      }

      const cfgRes = await fetch("/api/auth/config", { credentials: "same-origin" });
      const cfg = await cfgRes.json();
      const redirect =
        cfg.redirect_uri ||
        location.origin + "/api/auth/microsoft/callback";
      if (redirectInput) redirectInput.value = redirect;

      if (!cfg.oauth_configured) {
        if (setupPanel) setupPanel.hidden = false;
        if (setupPanel) setupPanel.open = true;
        if (msBtn) {
          msBtn.addEventListener("click", (e) => {
            if (!cfg.oauth_configured) {
              e.preventDefault();
              showError(
                "서버에 Microsoft 앱이 아직 연결되지 않았습니다. 관리자에게 문의하거나 아래에서 한 번만 설정하세요."
              );
              if (setupPanel) {
                setupPanel.hidden = false;
                setupPanel.open = true;
              }
              clientIdInput?.focus();
            }
          });
        }
      } else if (setupPanel) {
        setupPanel.hidden = true;
      }
    } catch {
      showError("서버에 연결할 수 없습니다.");
    }
  }

  saveBtn?.addEventListener("click", async () => {
    const clientId = (clientIdInput?.value || "").trim();
    const clientSecret = (secretInput?.value || "").trim();
    if (!clientId) {
      if (msgEl) msgEl.textContent = "클라이언트 ID를 넣어 주세요.";
      return;
    }
    saveBtn.disabled = true;
    if (msgEl) msgEl.textContent = "저장 중…";
    try {
      const res = await fetch("/api/auth/microsoft/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "저장 실패");
      }
      if (msgEl) msgEl.textContent = "연결됐습니다. Microsoft 로그인 버튼을 누르세요.";
      showError("");
      location.href = "/api/auth/microsoft";
    } catch (e) {
      if (msgEl) msgEl.textContent = e.message || "저장 실패";
    } finally {
      saveBtn.disabled = false;
    }
  });

  void boot();
})();
