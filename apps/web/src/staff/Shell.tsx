import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';

export interface Me {
  userId: string;
  role: 'admin' | 'preparer' | 'reviewer';
  email: string;
  name: string;
}

export function StaffShell() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .get<{ user: Me }>('/api/auth/me')
      .then((r) => setMe(r.user))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) navigate('/login');
      })
      .finally(() => setLoading(false));
  }, [navigate]);

  if (loading) return <div className="main">Loading…</div>;
  if (!me) return null;

  const logout = async () => {
    await api.post('/api/auth/logout');
    navigate('/login');
  };

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">Vibe 1099</div>
        <div className="section">Season</div>
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/forms">Form entry</NavLink>
        <NavLink to="/review">Client review queue</NavLink>
        <NavLink to="/corrections">Corrections</NavLink>
        <div className="section">People</div>
        <NavLink to="/payers">Payers</NavLink>
        <NavLink to="/recipients">Recipients</NavLink>
        <NavLink to="/invites">Client invites</NavLink>
        <NavLink to="/w9">W-9 requests</NavLink>
        <div className="section">Filing & delivery</div>
        <NavLink to="/transmissions">IRS transmissions</NavLink>
        <NavLink to="/missouri">Missouri</NavLink>
        <NavLink to="/batches">Paper batches</NavLink>
        <NavLink to="/deliveries">Deliveries</NavLink>
        <div className="section">Admin</div>
        <NavLink to="/settings">Settings</NavLink>
        <div style={{ padding: '16px' }}>
          <div className="muted" style={{ color: '#94a3b8' }}>{me.name} ({me.role})</div>
          <button className="small secondary" style={{ marginTop: 6 }} onClick={logout}>Sign out</button>
        </div>
      </nav>
      <main className="main">
        <Outlet context={me} />
      </main>
    </div>
  );
}
