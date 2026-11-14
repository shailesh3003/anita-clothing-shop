import { useLanguage, LanguageSelector } from './language.jsx'
import { createElement, useEffect, useState } from 'react'
import { ChartNoAxesCombined, Eye, EyeOff, LayoutDashboard, LogOut, Package, ShieldCheck, Store, UserPlus, UsersRound, WalletCards } from 'lucide-react'
import Sales from './Sales.jsx'
import { Dashboard, Reports } from './Insights.jsx'
import Inventory from './Inventory.jsx'

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...options.headers }, ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.')
  return data
}

function Login({ onLogin }) {
  const { t } = useLanguage()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setError('')
    setLoading(true)
    try { onLogin(await request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })) }
    catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  return <main className="login-page">
    <div className="login-language"><LanguageSelector /></div>
    <section className="login-card" aria-labelledby="welcome-title">
      <div className="login-brand-panel">
        <div className="login-brand-top"><span className="brand-mark"><Store size={21} strokeWidth={1.7} /></span><div className="login-brand-name">{t("Anita Clothing Shop")}<span>{t("Shop workspace")}</span></div></div>
        <div className="login-brand-message"><p className="eyebrow">{t("A WARM WELCOME")}</p><h2>{t("Every day,")}<br />{t("in good order.")}</h2><p>{t("A calm, clear place to take care of your shop’s daily sales.")}</p></div>
        <div className="login-brand-bottom"><ShieldCheck size={15} /><span>{t("Private access for your shop team")}</span></div>
      </div>
      <div className="login-form-panel">
        <p className="eyebrow">{t("YOUR WORKSPACE")}</p>
        <h1 id="welcome-title">{t("Welcome back")}</h1>
        <p className="intro">{t("Sign in with your assigned shop account.")}</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor="email">{t("Email address")}</label>
          <input id="email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required maxLength={254} />
          <div className="password-label"><label htmlFor="password">{t("Password")}</label></div>
          <div className="password-field"><input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder={t("Enter your password")} required maxLength={128} /><button type="button" className="visibility-button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? t("Hide password") : t("Show password")}>{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></div>
          {error && <p className="form-error" role="alert">{t(error)}</p>}
          <button className="submit-button" type="submit" disabled={loading}>{loading ? <><span className="spinner" /> {t("Signing in…")}</> : t("Sign in")}</button>
        </form>
        <div className="secure-note"><ShieldCheck size={15} /><span>{t("Your account is protected and private")}</span></div>
      </div>
    </section>
    <p className="page-footnote">{t("A little care in every detail.")}</p>
  </main>
}

function AdminUsers() {
  const { t } = useLanguage()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState({ displayName: '', email: '', password: '', role: 'STAFF' })

  async function refreshUsers() {
    setLoading(true)
    try { setUsers((await request('/admin/users')).users); setError('') }
    catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { refreshUsers() }, [])

  async function createUser(event) {
    event.preventDefault()
    setSaving(true); setError(''); setNotice('')
    try {
      await request('/admin/users', { method: 'POST', body: JSON.stringify(form) })
      setForm({ displayName: '', email: '', password: '', role: 'STAFF' })
      setNotice('Account created successfully.')
      await refreshUsers()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  async function toggleActive(account) {
    setError(''); setNotice('')
    try {
      await request(`/admin/users/${account.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !account.isActive }) })
      setNotice({ key: '{name}’s account is now {status}.', name: account.displayName, status: account.isActive ? 'inactive' : 'active' })
      await refreshUsers()
    } catch (err) { setError(err.message) }
  }

  return <section className="users-panel" aria-labelledby="users-title">
    <div className="section-heading"><div><p className="eyebrow">{t("ADMINISTRATION")}</p><h2 id="users-title">{t("Staff accounts")}</h2></div><span className="user-count">{users.length} {users.length === 1 ? t("account") : t("accounts")}</span></div>
    <form className="user-create-form" onSubmit={createUser}>
      <label>{t("Display name")}<input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} maxLength={100} required /></label>
      <label>{t("Email address")}<input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} maxLength={254} required /></label>
      <label>{t("Temporary password")}<input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} minLength={12} maxLength={128} autoComplete="new-password" required /></label>
      <label>{t("Role")}<select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}><option value="STAFF">{t("Staff")}</option><option value="ADMIN">{t("Admin")}</option></select></label>
      <button className="create-user-button" disabled={saving}><UserPlus size={16} />{saving ? t("Creating…") : t("Create account")}</button>
    </form>
    {(error || notice) && <p className={error ? 'form-error admin-message' : 'form-success'} role={error ? 'alert' : 'status'}>{error ? t(error) : typeof notice === 'object' ? t(notice.key, { name: notice.name, status: t(notice.status) }) : t(notice)}</p>}
    {loading ? <p className="list-status">{t("Loading accounts…")}</p> : users.length === 0 ? <p className="list-status">{t("No accounts found.")}</p> : <div className="user-list">{users.map(account => <div className="user-row" key={account.id}><div><strong>{account.displayName}</strong><span>{account.email}</span></div><span className="role-tag">{t(account.role)}</span><span className={account.isActive ? 'account-status active' : 'account-status'}>{account.isActive ? t("Active") : t("Inactive")}</span><button className="account-action" onClick={() => toggleActive(account)}>{account.isActive ? t("Deactivate") : t("Activate")}</button></div>)}</div>}
  </section>
}

function Workspace({ user, onLogout }) {
  const { t } = useLanguage()
  const [page, setPage] = useState('dashboard')
  const navigation = [
    { id: 'dashboard', label: 'Overview', icon: LayoutDashboard },
    { id: 'sales', label: 'Sales', icon: WalletCards },
    { id: 'inventory', label: 'Inventory', icon: Package },
    ...(user.role === 'ADMIN' ? [
      { id: 'reports', label: 'Reports', icon: ChartNoAxesCombined },
      { id: 'staff', label: 'Team access', icon: UsersRound },
    ] : []),
  ]
  const activePage = navigation.find(item => item.id === page) || navigation[0]
  return <div className="app-shell">
    <aside className="app-sidebar">
      <a className="sidebar-brand" href="#home" onClick={event => { event.preventDefault(); setPage('dashboard') }}>
        <span className="small-mark"><Store size={20} strokeWidth={1.8} /></span>
        <span className="brand-copy"><strong>{t("Anita")}</strong><small>{t("Clothing Shop")}</small></span>
      </a>
      <div className="sidebar-label">{t("WORKSPACE")}</div>
      <nav className="workspace-nav" aria-label={t("Workspace")}>
        {navigation.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? 'selected' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>{createElement(Icon, { size: 18, strokeWidth: 1.8 })}<span>{t(label)}</span></button>)}
      </nav>
      <LanguageSelector />
      <div className="sidebar-footer"><span className="sidebar-footer-mark"><Store size={15} /></span><span>{t("Made for your shop")}</span></div>
    </aside>
    <div className="app-main">
      <header className="topbar">
        <div className="topbar-heading"><p className="eyebrow">{t("ANITA CLOTHING SHOP")}</p><h1>{t(activePage.label)}</h1></div>
        <div className="user-menu"><span className="user-avatar" aria-hidden="true">{user.displayName.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase()}</span><div className="user-identity"><span className="user-name">{user.displayName}</span><span className="role-tag">{t(user.role)}</span></div><button className="logout-button" onClick={onLogout} aria-label={t('Sign out')}><LogOut size={17} /><span>{t("Sign out")}</span></button></div>
      </header>
      <main className="workspace-content">
      {page === 'dashboard' && <Dashboard user={user} />}
      {page === 'sales' && <Sales user={user} />}
      {page === 'inventory' && <Inventory user={user} />}
      {user.role === 'ADMIN' && page === 'reports' && <Reports />}
      {user.role === 'ADMIN' && page === 'staff' && <><section className="admin-panel"><div className="panel-icon"><ShieldCheck size={20} /></div><div><h2>{t("Administrator access")}</h2><p>{t("Manage staff accounts from your protected admin workspace.")}</p></div><span className="role-tag">{t("ADMIN")}</span></section><AdminUsers /></>}
      </main>
    </div>
  </div>
}

export default function App() {
  const { t } = useLanguage()
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(true)
  useEffect(() => { request('/auth/me').then(data => setUser(data.user)).catch(() => setUser(null)).finally(() => setChecking(false)) }, [])
  async function logout() { try { await request('/auth/logout', { method: 'POST' }) } finally { setUser(null) } }
  if (checking) return <div className="loading-screen"><span className="spinner dark" /> {t("Checking your session…")}</div>
  return user ? <Workspace user={user} onLogout={logout} /> : <Login onLogin={data => setUser(data.user)} />
}
