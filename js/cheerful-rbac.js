(function () {
  'use strict';

  const ROLE_LABELS = {
    ceo: 'CEO',
    finance: '财务',
    ar: 'A&R',
    hr: 'HR',
    copyright: '版权',
    distribution: '发行',
    marketing: '推广',
    legal: '法务',
    admin: '管理员',
    member: '成员',
    viewer: '只读'
  };

  const ROLE_MODULES = Object.freeze({
    ceo: ['dashboard', 'finance', 'copyright', 'release', 'ar', 'marketing', 'hr', 'legal', 'ceo'],
    finance: ['dashboard', 'finance'],
    ar: ['dashboard', 'ar'],
    hr: ['dashboard', 'hr'],
    copyright: ['dashboard', 'copyright'],
    distribution: ['dashboard', 'release'],
    marketing: ['dashboard', 'marketing'],
    legal: ['dashboard', 'legal'],
    admin: ['dashboard'],
    member: ['dashboard'],
    viewer: ['dashboard']
  });

  let loginPending = false;

  function roleLabel(role) {
    return ROLE_LABELS[role] || role || '成员';
  }

  function escapeText(value) {
    return String(value || '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function updateIdentity(user) {
    window.cheerfulCurrentUser = user || null;
    if (!user) return;
    const userNode = document.querySelector('.sidebar-bottom .user');
    const roleNode = document.querySelector('.sidebar-bottom .role');
    const avatarNode = document.querySelector('.topbar .avatar');
    if (userNode) userNode.textContent = user.name || user.email || 'Cheerful User';
    if (roleNode) roleNode.textContent = `${roleLabel(user.role)} · 安全身份`;
    if (avatarNode) avatarNode.textContent = String(user.name || user.email || 'C').slice(0, 1).toUpperCase();
  }

  function canOpenModule(moduleId) {
    if (moduleId === 'cheerful-gpt') return true;
    const role = window.cheerfulCurrentUser && window.cheerfulCurrentUser.role || 'viewer';
    return (ROLE_MODULES[role] || ROLE_MODULES.viewer).includes(moduleId);
  }

  const originalBuildNav = window.buildNav;
  window.buildNav = function () {
    originalBuildNav();
    document.querySelectorAll('#nav [data-id]').forEach(button => {
      if (!canOpenModule(button.dataset.id)) button.remove();
    });
  };

  const originalOpenSection = window.openSection;
  window.openSection = function (id) {
    if (!canOpenModule(id)) {
      if (typeof window.showToastMessage === 'function') window.showToastMessage('当前账号没有此模块权限');
      return;
    }
    return originalOpenSection(id);
  };

  function enterSystem(user) {
    updateIdentity(user);
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('osView').classList.remove('hidden');
    window.buildNav();
    window.openSection('dashboard');
  }

  function showLogin() {
    window.cheerfulCurrentUser = null;
    document.getElementById('osView').classList.add('hidden');
    document.getElementById('loginView').classList.remove('hidden');
  }

  async function secureLogin() {
    if (loginPending) return;
    const emailNode = document.getElementById('email');
    const passwordNode = document.getElementById('password');
    const errorNode = document.getElementById('loginError');
    const button = document.getElementById('loginBtn');
    const email = emailNode.value.trim().toLowerCase();
    const password = passwordNode.value;
    errorNode.textContent = '';
    if (!email || !password) {
      errorNode.textContent = document.getElementById('enBtn').classList.contains('active') ? 'Enter your email and password' : '请输入工作邮箱和密码';
      return;
    }
    loginPending = true;
    button.disabled = true;
    button.textContent = document.getElementById('enBtn').classList.contains('active') ? 'Signing in…' : '正在验证…';
    try {
      const response = await fetch('/api/gpt-session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.authenticated) throw new Error(data.error || '登录失败');
      if (document.getElementById('remember').checked) localStorage.setItem('cm_ai_os_user', email);
      else localStorage.removeItem('cm_ai_os_user');
      passwordNode.value = '';
      enterSystem(data.user);
      document.dispatchEvent(new CustomEvent('cheerful:session', { detail: data.user }));
    } catch (error) {
      errorNode.textContent = error.message;
    } finally {
      loginPending = false;
      button.disabled = false;
      button.textContent = document.getElementById('enBtn').classList.contains('active') ? 'Enter system' : '进入系统';
    }
  }

  async function secureLogout() {
    await fetch('/api/gpt-session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => null);
    window.cheerfulCurrentUser = null;
    document.getElementById('password').value = '';
    showLogin();
    document.dispatchEvent(new CustomEvent('cheerful:session', { detail: null }));
  }

  async function restoreSession() {
    try {
      const response = await fetch('/api/gpt-session', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (response.ok && data.authenticated && data.user) {
        enterSystem(data.user);
        document.dispatchEvent(new CustomEvent('cheerful:session', { detail: data.user }));
        return;
      }
    } catch (_) {}
    showLogin();
  }

  const originalDashboard = window.dashboard;
  window.dashboard = function () {
    const html = originalDashboard();
    const user = window.cheerfulCurrentUser;
    return user ? html.replace('欢迎回来，Snow', `欢迎回来，${escapeText(user.name || user.email)}`) : html;
  };

  window.login = secureLogin;
  window.logout = secureLogout;
  document.getElementById('loginBtn').onclick = secureLogin;
  document.getElementById('logoutBtn').onclick = secureLogout;
  restoreSession();
})();
