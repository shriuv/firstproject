import React, { useState, useEffect } from 'react';
import { ICONS } from '../Icons';
import { useAuth } from '../../shared/hooks/useAuth';
import '../../styles/Settings.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

const Settings = ({ toggleTheme, isDarkMode }) => {
  const { user } = useAuth();
  const email = user?.email || '—';

  const [isZohoConnected, setIsZohoConnected] = useState(false);
  const [isZohoLoading, setIsZohoLoading] = useState(true);
  const [zohoInfo, setZohoInfo] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  useEffect(() => {
    // Clean up ?connected= param from URL after OAuth redirect
    const urlParams = new URLSearchParams(window.location.search);
    const connected = urlParams.get('connected');
    if (connected !== null) {
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);
    }

    if (user?.id) {
      fetch(`${API_BASE_URL}/api/zoho/status?userId=${user.id}`)
        .then(res => res.json())
        .then(data => {
          setIsZohoConnected(data.connected);
          if (data.connected) {
            setZohoInfo({
              orgName: data.organizationName,
              orgId: data.organizationId,
              zohoEmail: data.zohoUserEmail,
            });
          }
          setIsZohoLoading(false);
        })
        .catch(err => {
          console.error("Failed to fetch Zoho status", err);
          setIsZohoLoading(false);
        });
    } else {
      setIsZohoLoading(false);
    }
  }, [user]);

  const handleZohoToggle = async () => {
    if (isZohoConnected) {
      // Disconnect
      setIsZohoLoading(true);
      setSyncResult(null);
      try {
        await fetch(`${API_BASE_URL}/api/zoho/disconnect?userId=${user.id}`, { method: 'DELETE' });
        setIsZohoConnected(false);
        setZohoInfo(null);
      } catch (err) {
        console.error("Failed to disconnect Zoho", err);
      } finally {
        setIsZohoLoading(false);
      }
    } else {
      // Connect -> redirect to Zoho OAuth
      window.location.href = `${API_BASE_URL}/api/zoho/connect?userId=${user.id}`;
    }
  };

  const handleSync = async () => {
    setIsSyncing(true);
    setSyncResult(null);
    try {
      // Step 1: Migrate (Stages Zoho data to DB)
      const resMigrate = await fetch(`${API_BASE_URL}/api/zoho/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      const dataMigrate = await resMigrate.json();
      if (!dataMigrate.success) {
        throw new Error(dataMigrate.error || 'Migration/Staging stage failed');
      }

      // Step 2: Process (Converts staged data into LedgerAI transactions)
      const resProcess = await fetch(`${API_BASE_URL}/api/zoho/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      const dataProcess = await resProcess.json();
      if (!dataProcess.success) {
        throw new Error(dataProcess.error || 'Processing stage failed');
      }

      setSyncResult({
        ok: true,
        summary: {
          ...dataMigrate.summary,
          ...dataProcess.summary,
        },
      });
    } catch (err) {
      setSyncResult({ ok: false, message: err.message });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleProcessOnly = async () => {
    setIsProcessing(true);
    setSyncResult(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/zoho/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await res.json();
      if (data.success) {
        setSyncResult({
          ok: true,
          summary: data.summary,
        });
      } else {
        setSyncResult({ ok: false, message: data.error || 'Processing failed' });
      }
    } catch (err) {
      setSyncResult({ ok: false, message: err.message });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="settings-container">
      <div className="page-header">
        <div className="header-title">
          <h1>Settings</h1>
          <p>Manage your account and app preferences.</p>
        </div>
      </div>

      <div className="settings-content">
        {/* ── Account Information ── */}
        <div className="settings-card">
          <div className="card-header">
            <h2>Account Informations</h2>
          </div>
          <div className="card-body">
            <div className="settings-row">
              <div className="row-info">
                <h3>Email address</h3>
              </div>
              <div className="static-value-text">{email}</div>
            </div>
          </div>
        </div>

        {/* ── Security Settings ── */}
        <div className="settings-card">
          <div className="card-header">
            <h2>Security Settings</h2>
          </div>
          <div className="card-body">
            <div className="settings-row">
              <div className="row-info">
                <h3>Google Authenticator (2FA)</h3>
                <p>Use the Authenticator to get verification codes for better security.</p>
              </div>
              <label className="switch">
                <input type="checkbox" defaultChecked />
                <span className="slider round"></span>
              </label>
            </div>
            
            <div className="settings-row" style={{ marginTop: '24px', paddingTop: '24px', borderTop: '1px solid var(--glass-border)' }}>
              <div className="row-info">
                <h3>Password</h3>
                <p>Last Changed {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
              </div>
              <button className="theme-toggle-btn">Set password</button>
            </div>
          </div>
        </div>

        {/* ── Appearance ── */}
        <div className="settings-card">
          <div className="card-header">
            <h2>Appearance</h2>
          </div>
          <div className="card-body">
            <div className="settings-row">
              <div className="row-info">
                <h3>Theme</h3>
                <p>{isDarkMode ? 'Dark mode is currently active' : 'Light mode is currently active'}</p>
              </div>
              <button 
                className="theme-toggle-btn" 
                onClick={toggleTheme}
              >
                {isDarkMode ? <ICONS.Sun /> : <ICONS.Moon />}
                {isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              </button>
            </div>
          </div>
        </div>

        {/* ── Integrations ── */}
        <div className="settings-card">
          <div className="card-header">
            <h2>Integrations</h2>
          </div>
          <div className="card-body">
            <div className="settings-row">
              <div className="row-info">
                <h3>Zoho Books</h3>
                <p>Sync your Chart of Accounts and Journal Entries.</p>
              </div>
              {isZohoLoading ? (
                <span className="static-value-text">Loading...</span>
              ) : (
                <label className="switch">
                  <input type="checkbox" checked={isZohoConnected} onChange={handleZohoToggle} />
                  <span className="slider round"></span>
                </label>
              )}
            </div>
            {isZohoConnected && zohoInfo && (
              <div className="zoho-connected-info">
                <span className="zoho-connected-badge">✓ Connected</span>
                <div className="zoho-org-details">
                  <span className="zoho-org-name">{zohoInfo.orgName}</span>
                  {zohoInfo.zohoEmail
                    ? <span className="zoho-org-id">Zoho Account: {zohoInfo.zohoEmail}</span>
                    : <span className="zoho-org-id">Organization ID: {zohoInfo.orgId}</span>
                  }
                </div>
                <div className="zoho-actions">
                  <button
                    className="zoho-sync-btn"
                    onClick={handleSync}
                    disabled={isSyncing || isProcessing}
                  >
                    {isSyncing ? '⟳ Syncing...' : '↻ Sync Data'}
                  </button>
                  <button
                    className="zoho-process-btn"
                    onClick={handleProcessOnly}
                    disabled={isSyncing || isProcessing}
                  >
                    {isProcessing ? '⟳ Processing...' : '⚙ Process Staged Data'}
                  </button>
                </div>
              </div>
            )}
            {syncResult && (
              <div className={`zoho-sync-result ${syncResult.ok ? 'sync-success' : 'sync-error'}`}>
                {syncResult.ok ? (
                  <>
                    <span>✓ Operation complete!</span>
                    {syncResult.summary.accountsImported !== undefined ? (
                      <span style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span><strong>Staged:</strong> {syncResult.summary.accountsImported} accounts · {syncResult.summary.journalsStaged} journals · {syncResult.summary.invoicesStaged} invoices · {syncResult.summary.billsStaged} bills · {syncResult.summary.bankTransactionsStaged} bank txns</span>
                        <span><strong>Processed:</strong> {syncResult.summary.journalLinesProcessed} journals · {syncResult.summary.invoicesProcessed} invoices · {syncResult.summary.billsProcessed} bills · {syncResult.summary.bankTxnsProcessed} bank txns</span>
                      </span>
                    ) : (
                      <span><strong>Processed:</strong> {syncResult.summary.journalLinesProcessed} journals · {syncResult.summary.invoicesProcessed} invoices · {syncResult.summary.billsProcessed} bills · {syncResult.summary.bankTxnsProcessed} bank txns</span>
                    )}
                  </>
                ) : (
                  <span>✕ {syncResult.message}</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Account ── */}
        <div className="settings-card">
          <div className="card-header">
            <h2>Account</h2>
          </div>
          <div className="card-body">
            <div className="settings-row">
              <div className="row-info">
                <h3>Sign out</h3>
                <p>You will be returned to the login screen. Your session will be cleared.</p>
              </div>
              <button 
                className="logout-action-btn"
                onClick={() => window.dispatchEvent(new CustomEvent('ledgerai:logout'))}
              >
                <ICONS.Logout />
                Log out
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
