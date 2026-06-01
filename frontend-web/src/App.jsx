import React, { useState, useEffect } from 'react';
import { useHeartbeat } from './hooks/useHeartbeat';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './shared/hooks/useAuth';
import { useRole } from './context/RoleContext';
import { supabase, supabaseConfigError } from './shared/supabase';
import { ParsingProvider } from './context/ParsingContext';
import { UserProvider } from './context/UserContext';
import { DataProvider } from './context/DataContext';
//chatbot
import LedgerBuddy from './components/chatbot/LedgerBuddy';
// Pages & Components
import AuthPage from './components/AuthPage';
import Overview from './components/pages/Overview';
import Transactions from './components/pages/Transactions';
import Accounts from './components/pages/Accounts';
import Analytics from './components/pages/Analytics';
import Profile from './components/pages/Profile';
import CategoryTransactions from './components/pages/CategoryTransactions';
import WelcomeScreen from './components/WelcomeScreen';
import Settings from './components/pages/Settings';
import OnboardingCoaReview from './components/OnboardingCoaReview';
import QCPanel from './components/QCPanel';

// Parser Module Components
import ParsingPage from './pages/Parsing';
import ReviewPage from './pages/Review';

// Layouts & Protection
import AuthLayout from './layouts/AuthLayout';
import AppLayout from './layouts/AppLayout';
import QCLayout from './layouts/QCLayout';
import ProtectedRoute from './components/ProtectedRoute';

// Guard component to handle setup check redirects without breaking route matching
const ModuleGuard = ({ hasModules, hasIdentifiers, checkSetupStatus, user, toggleTheme, isDarkMode }) => {
  // null means the async setup check is still in flight — show a neutral
  // spinner so we never briefly flash the main app to a new user.
  if (hasModules === null || hasIdentifiers === null) {
    return (
      <div style={{
        height: '100vh', display: 'grid', placeItems: 'center',
        backgroundColor: 'var(--bg-primary, #0B1220)',
        color: 'var(--text-primary, #E6E8EC)', fontFamily: "'Outfit', sans-serif"
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: '36px', height: '36px', border: '3px solid var(--border-color)', borderTopColor: 'var(--primary-action)', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 1rem' }}></div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <div style={{ fontWeight: 600, letterSpacing: '0.5px', fontSize: '0.9rem' }}>Setting up your account...</div>
        </div>
      </div>
    );
  }
  // Step 1 — choose profile & module, insert COA template accounts
  if (hasModules === false) {
    return (
      <WelcomeScreen
        onSetupComplete={checkSetupStatus}
        toggleTheme={toggleTheme}
        isDarkMode={isDarkMode}
      />
    );
  }
  // Step 2 — add bank accounts + review/trim spending categories
  if (hasIdentifiers === false) {
    return <OnboardingCoaReview onSetupComplete={checkSetupStatus} />;
  }
  // Fully set up — enter the app (DataProvider only mounts here, for fully-onboarded users)
  return <DataProvider><AppLayout user={user} toggleTheme={toggleTheme} isDarkMode={isDarkMode} /></DataProvider>;
};

// ── 404 Not Found screen ──────────────────────────────────────────────────
const NotFound = () => {
  const navigate = useNavigate();
  return (
    <div style={{
      height: '100vh',
      display: 'grid',
      placeItems: 'center',
      backgroundColor: 'var(--bg-primary)',
      color: 'var(--text-primary)',
      fontFamily: "'Outfit', sans-serif",
    }}>
      <style>{`
        @keyframes notFoundFade {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div style={{ textAlign: 'center', animation: 'notFoundFade 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards' }}>
        <div style={{
          fontSize: 'clamp(80px, 15vw, 140px)',
          fontWeight: 800,
          lineHeight: 1,
          background: 'var(--accent-gradient)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          marginBottom: '16px',
        }}>404</div>
        <p style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 8px', color: 'var(--text-primary)' }}>
          Page not found
        </p>
        <p style={{ fontSize: '14px', color: 'var(--text-secondary)', margin: '0 0 32px' }}>
          The page you're looking for doesn't exist or has been moved.
        </p>
        <button
          id="not-found-go-home"
          onClick={() => navigate('/')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            padding: '12px 24px',
            borderRadius: '12px',
            border: '1px solid var(--glass-border)',
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            fontFamily: 'inherit',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--accent-color)';
            e.currentTarget.style.transform = 'translateY(-2px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--glass-border)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          ← Go home
        </button>
      </div>
    </div>
  );
};

function App() {
  const { user, loading: authLoading } = useAuth();
  // Keep Render free-tier services awake while the user is active.
  useHeartbeat();
  const { role, roleLoading } = useRole();
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [hasModules, setHasModules] = useState(null);
  const [hasIdentifiers, setHasIdentifiers] = useState(null);
  const [loading, setLoading] = useState(true);

  const toggleTheme = () => setIsDarkMode(!isDarkMode);

  useEffect(() => {
    if (isDarkMode) {
      document.body.classList.remove('light-mode');
    } else {
      document.body.classList.add('light-mode');
    }
  }, [isDarkMode]);

  const checkSetupStatus = async () => {
    if (!supabase) {
      setHasModules(false);
      setHasIdentifiers(false);
      setLoading(false);
      return;
    }

    if (!user) {
      setHasModules(null);
      setHasIdentifiers(null);
      setLoading(false);
      return;
    }

    try {
      if (role === 'QC' || role === 'ADMIN') {
         setLoading(false);
         return;
      }

      // Check Modules
      const { data: modules, error: modErr } = await supabase
        .from('user_modules')
        .select('module_id')
        .eq('user_id', user.id);

      if (modErr) throw modErr;
      const modulesExist = modules && modules.length > 0;
      setHasModules(modulesExist);

      if (modulesExist) {
        const { data: identifiers, error: idErr } = await supabase
          .from('account_identifiers')
          .select('identifier_id')
          .eq('user_id', user.id)
          .not('account_number_last4', 'is', null);

        if (idErr) throw idErr;
        setHasIdentifiers(identifiers && identifiers.length > 0);
      } else {
        setHasIdentifiers(false);
      }
    } catch (err) {
      console.error('Error checking setup status:', err);
      setHasModules(false);
      setHasIdentifiers(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user && role) checkSetupStatus();
    else if (!user) setLoading(false);
  }, [user, role]);

  if (supabaseConfigError) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', backgroundColor: '#0f172a', color: '#e2e8f0', fontFamily: 'Inter, sans-serif', padding: '24px' }}>
        <div style={{ maxWidth: '760px', width: '100%', lineHeight: 1.6 }}>
          <h1 style={{ margin: '0 0 8px 0', fontSize: '1.5rem' }}>Configuration Required</h1>
          <p style={{ margin: '0 0 12px 0', color: '#cbd5e1' }}>{supabaseConfigError}</p>
          <p style={{ margin: 0, color: '#94a3b8' }}>Update frontend-web/.env, then restart the Vite dev server.</p>
        </div>
      </div>
    );
  }

  // Wait for Auth AND Role to minimize transient "no-user" states during refresh
  // Optimized loading guard: Only show full-screen loader on initial mount.
  // If we already have a user and role, don't unmount the entire app just because a refresh is happening in the background.
  const isInitialLoading = (authLoading || roleLoading || loading) && (!user || !role);
  
  if (isInitialLoading) {
    return (
      <div style={{ 
        height: '100vh', 
        display: 'grid', 
        placeItems: 'center', 
        backgroundColor: 'var(--bg-primary, #0B1220)', 
        color: 'var(--text-primary, #E6E8EC)', 
        fontFamily: "'Outfit', sans-serif" 
      }}>
        <div style={{ textAlign: 'center' }}>
           <div style={{ width: '40px', height: '40px', border: '3px solid var(--border-color)', borderTopColor: 'var(--primary-action)', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 1rem' }}></div>
           <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
           <div style={{ fontWeight: 600, letterSpacing: '0.5px' }}>Initializing LedgerAI...</div>
        </div>
      </div>
    );
  }

  return (
    <UserProvider>
    <ParsingProvider>
      <Routes>
        <Route path="/auth" element={user && (window.location.pathname.startsWith('/auth')) ? <Navigate to={role === 'QC' ? "/qc" : "/"} replace /> : <AuthLayout />}>
           <Route index element={<AuthPage toggleTheme={toggleTheme} isDarkMode={isDarkMode} />} />
           <Route path="login" element={<AuthPage toggleTheme={toggleTheme} isDarkMode={isDarkMode} />} />
        </Route>

        <Route path="/qc" element={
            <ProtectedRoute allowedRoles={['QC', 'ADMIN']}>
               <QCLayout user={user} toggleTheme={toggleTheme} isDarkMode={isDarkMode} />
            </ProtectedRoute>
        }>
           <Route index element={<QCPanel user={user} toggleTheme={toggleTheme} isDarkMode={isDarkMode} />} />
        </Route>

        <Route path="/" element={
            <ProtectedRoute allowedRoles={['USER', 'ADMIN']}>
               <ModuleGuard 
                  hasModules={hasModules} 
                  hasIdentifiers={hasIdentifiers} 
                  checkSetupStatus={checkSetupStatus} 
                  user={user} 
                  toggleTheme={toggleTheme} 
                  isDarkMode={isDarkMode} 
               />
            </ProtectedRoute>
        }>
             <Route index element={<Overview />} />
             <Route path="overview" element={<Overview />} />
             <Route path="parsing" element={<ParsingPage />} />
             <Route path="transactions" element={<Transactions />} />
             <Route path="category/:categoryName" element={<CategoryTransactions />} />
             <Route path="accounts" element={<Accounts />} />
             <Route path="analytics" element={<Analytics />} />
             <Route path="profile" element={<Profile />} />
             <Route path="settings" element={<Settings toggleTheme={toggleTheme} isDarkMode={isDarkMode} />} />
             <Route path="review" element={<ReviewPage />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>

      {/* Chatbot - Hidden during setup/welcome screens */}
      {user && hasModules === true && hasIdentifiers === true && !roleLoading && role !== 'QC' && (
        <LedgerBuddy />
      )}
    </ParsingProvider>
    </UserProvider>
  );
}

export default App;
