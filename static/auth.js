// Login / signup helpers: email format check, password check, show/hide password.
(function () {
  const form = document.getElementById("auth-form");
  if (!form) return;

  const mode = form.dataset.mode; // "login" or "signup"
  const email = document.getElementById("email");
  const password = document.getElementById("password");
  const emailError = document.getElementById("email-error");
  const passwordError = document.getElementById("password-error");
  const submitBtn = document.getElementById("auth-submit");
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const submitLabel = submitBtn.textContent;

  function setError(input, box, message) {
    input.classList.add("invalid");
    box.textContent = message;
    box.hidden = false;
  }
  function clearError(input, box) {
    input.classList.remove("invalid");
    box.hidden = true;
  }

  function checkEmail() {
    const v = email.value.trim();
    if (!v) { setError(email, emailError, "Please enter your email."); return false; }
    if (!EMAIL_RE.test(v)) { setError(email, emailError, "That doesn't look like a valid email (example: name@school.com)."); return false; }
    clearError(email, emailError);
    return true;
  }
  function checkPassword() {
    const v = password.value;
    if (!v) { setError(password, passwordError, "Please enter your password."); return false; }
    if (mode === "signup" && v.length < 6) { setError(password, passwordError, "Password must be at least 6 characters."); return false; }
    clearError(password, passwordError);
    return true;
  }

  email.addEventListener("blur", () => { if (email.value) checkEmail(); });
  email.addEventListener("input", () => { clearError(email, emailError); dismissServerError(); });
  password.addEventListener("input", () => { clearError(password, passwordError); dismissServerError(); });

  function dismissServerError() {
    const box = document.getElementById("server-error");
    if (box) box.remove();
  }

  form.addEventListener("submit", (event) => {
    const okEmail = checkEmail();
    const okPassword = checkPassword();
    if (!okEmail || !okPassword) {
      event.preventDefault();
      form.classList.remove("shake");
      void form.offsetWidth; // restart animation
      form.classList.add("shake");
      (okEmail ? password : email).focus();
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = mode === "signup" ? "Creating account\u2026" : "Logging in\u2026";
  });

  // Show / hide password (eye icon)
  const toggle = form.querySelector(".toggle-password");
  if (toggle) {
    const open = toggle.querySelector(".eye-open");
    const closed = toggle.querySelector(".eye-closed");
    toggle.addEventListener("click", () => {
      const show = password.type === "password";
      password.type = show ? "text" : "password";
      open.hidden = show;
      closed.hidden = !show;
      toggle.setAttribute("aria-pressed", String(show));
      toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
      password.focus();
    });
  }

  // Restore the button if the browser returns to this page from history.
  window.addEventListener("pageshow", () => { submitBtn.disabled = false; submitBtn.textContent = submitLabel; });
})();
