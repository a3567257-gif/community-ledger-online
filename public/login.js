document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('login-error');
  const btn = document.getElementById('btn-login');
  err.textContent = '';
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ login: document.getElementById('login').value.trim(), password: document.getElementById('password').value }),
    });
    const r = await res.json();
    if (!r.ok) { err.textContent = r.error || '登入失敗'; return; }
    location.href = '/';
  } catch (ex) {
    err.textContent = '連不上伺服器，請確認網路連線後再試一次。';
  } finally {
    btn.disabled = false;
  }
});
