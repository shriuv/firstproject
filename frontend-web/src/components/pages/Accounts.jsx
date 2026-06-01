import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../shared/supabase';
import { useUser } from '../../context/UserContext';
import { useData } from '../../context/DataContext';
import AddAccountModal from '../AddAccountModal';
import '../../styles/Accounts.css';
import { motion } from 'framer-motion';

// ─────────────────────────────────────────────────────────────────────────────
// Edit Identifier Modal
// ─────────────────────────────────────────────────────────────────────────────
function identifierMode(identifier) {
  if (!identifier) return 'BANK';
  if (identifier.card_last4 != null) return 'CREDIT_CARD';
  if (identifier.wallet_id != null) return 'CASH_WALLET';
  return 'BANK';
}

const EditIdentifierModal = ({ account, onClose, onSuccess }) => {
  const user = useUser();
  const [identifier, setIdentifier] = useState(null);
  const [form, setForm] = useState({ institution_name: '', account_number_last4: '', ifsc_code: '', card_last4: '', card_network: 'VISA', wallet_id: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('account_identifiers')
          .select('*')
          .eq('account_id', account.account_id)
          .eq('user_id', user.id)
          .maybeSingle();
        if (error) throw error;
        setIdentifier(data);
        if (data) {
          setForm({
            institution_name: data.institution_name || '',
            account_number_last4: data.account_number_last4 || '',
            ifsc_code: data.ifsc_code || '',
            card_last4: data.card_last4 || '',
            card_network: data.card_network || 'VISA',
            wallet_id: data.wallet_id || '',
          });
        }
      } catch (err) {
        setError('Failed to load identifier data.');
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [account.account_id]);

  const mode = identifierMode(identifier);

  const handleSave = async () => {
    setError('');
    setSaving(true);
    try {
      const last4 = mode === 'CREDIT_CARD' ? form.card_last4 : form.account_number_last4;
      if ((mode === 'BANK' || mode === 'CREDIT_CARD') && last4 && last4.length !== 4) {
        setError('Last 4 digits must be exactly 4 characters.');
        setSaving(false);
        return;
      }

      const payload = {
        institution_name: form.institution_name.trim() || null,
        ...(mode === 'BANK' ? { account_number_last4: form.account_number_last4 || null, ifsc_code: form.ifsc_code.trim() || null } : {}),
        ...(mode === 'CREDIT_CARD' ? { card_last4: form.card_last4 || null, card_network: form.card_network || null } : {}),
        ...(mode === 'CASH_WALLET' ? { wallet_id: form.wallet_id.trim() || null } : {}),
      };

      if (identifier) {
        const { error } = await supabase.from('account_identifiers').update(payload)
          .eq('identifier_id', identifier.identifier_id).eq('user_id', user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('account_identifiers')
          .insert([{ ...payload, account_id: account.account_id, user_id: user.id }]);
        if (error) throw error;
      }

      onSuccess();
      onClose();
    } catch (err) {
      console.error('Save identifier failed:', err);
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="add-account-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Edit Identifier</h2>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>{account.account_name}</p>
          </div>
          <button className="close-modal-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {loading ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}><span className="spinner" style={{ display: 'inline-block' }}></span></div>
          ) : (
            <>
              {error && <div style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, padding: '10px 14px', color: '#F87171', fontSize: 13 }}>{error}</div>}

              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 20, background: 'rgba(42, 79, 122, 0.12)', border: '1px solid rgba(42, 79, 122, 0.25)', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                {mode === 'CREDIT_CARD' && '💳 Credit Card'}
                {mode === 'CASH_WALLET' && '👛 Cash / Wallet'}
                {mode === 'BANK' && '🏦 Bank Account'}
              </div>

              <div className="form-group">
                <label className="form-label">Institution / Bank Name</label>
                <input type="text" className="form-input"
                  placeholder={mode === 'CREDIT_CARD' ? 'e.g. HDFC, Amex' : mode === 'CASH_WALLET' ? 'e.g. PayTM, GPay' : 'e.g. HDFC, SBI'}
                  value={form.institution_name} onChange={e => setForm(p => ({ ...p, institution_name: e.target.value }))} disabled={saving} />
              </div>

              {mode === 'BANK' && (<>
                <div className="form-group">
                  <label className="form-label">Last 4 Digits of Account No.</label>
                  <input type="text" className="form-input" placeholder="e.g. 4321" maxLength={4}
                    value={form.account_number_last4}
                    onChange={e => setForm(p => ({ ...p, account_number_last4: e.target.value.replace(/\D/g, '') }))} disabled={saving} />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>Used to match uploaded bank statements to this account</span>
                </div>
                <div className="form-group">
                  <label className="form-label">IFSC Code</label>
                  <input type="text" className="form-input" placeholder="e.g. HDFC0001234"
                    value={form.ifsc_code} onChange={e => setForm(p => ({ ...p, ifsc_code: e.target.value.toUpperCase() }))} disabled={saving} />
                </div>
              </>)}

              {mode === 'CREDIT_CARD' && (<>
                <div className="form-group">
                  <label className="form-label">Last 4 Digits of Card</label>
                  <input type="text" className="form-input" placeholder="e.g. 9876" maxLength={4}
                    value={form.card_last4}
                    onChange={e => setForm(p => ({ ...p, card_last4: e.target.value.replace(/\D/g, '') }))} disabled={saving} />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>Used to match uploaded card statements to this account</span>
                </div>
                <div className="form-group">
                  <label className="form-label">Card Network</label>
                  <select className="form-select" value={form.card_network} onChange={e => setForm(p => ({ ...p, card_network: e.target.value }))} disabled={saving}>
                    <option value="VISA">VISA</option>
                    <option value="MASTERCARD">Mastercard</option>
                    <option value="AMEX">Amex</option>
                    <option value="RUPAY">RuPay</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
              </>)}

              {mode === 'CASH_WALLET' && (
                <div className="form-group">
                  <label className="form-label">Wallet ID / Phone</label>
                  <input type="text" className="form-input" placeholder="e.g. 9876543210@paytm"
                    value={form.wallet_id} onChange={e => setForm(p => ({ ...p, wallet_id: e.target.value }))} disabled={saving} />
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="cancel-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="submit-btn" onClick={handleSave} disabled={loading || saving}>
            {saving ? <span className="spinner"></span> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};


// ─────────────────────────────────────────────────────────────────────────────
// Account Actions Menu (⋯ popover)
// ─────────────────────────────────────────────────────────────────────────────
const POPUP_W = 210; // keep in sync with .acct-menu-popup min-width

const AccountActionsMenu = ({ node, onRename, onDeactivate, onEditIdentifier, onToggleLlm }) => {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [tooltipCoords, setTooltipCoords] = useState({ top: 0, left: 0 });
  const menuRef = React.useRef(null);
  const popupRef = React.useRef(null);
  const toggleRowRef = React.useRef(null);

  const toggleOpen = (e) => {
    e.stopPropagation();
    if (!open && menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const rawLeft = rect.right + window.scrollX - POPUP_W;
      const left = Math.max(window.scrollX + 8, Math.min(rawLeft, window.scrollX + window.innerWidth - POPUP_W - 8));
      setCoords({ top: rect.bottom + window.scrollY + 6, left });
    }
    setOpen(!open);
  };

  const handleToggleRowMouseEnter = () => {
    if (toggleRowRef.current) {
      const r = toggleRowRef.current.getBoundingClientRect();
      setTooltipCoords({ top: r.top, left: r.left + r.width / 2 });
      setTooltipVisible(true);
    }
  };
  const handleToggleRowMouseLeave = () => setTooltipVisible(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      if (popupRef.current && popupRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const scrollHandler = () => setOpen(false);

    document.addEventListener('mousedown', handler);
    window.addEventListener('scroll', scrollHandler, true); // Close on any scroll

    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('scroll', scrollHandler, true);
    };
  }, [open]);

  return (
    <div className="acct-menu-wrap" ref={menuRef}>
      <button
        className="node-action-btn acct-more-btn"
        onClick={toggleOpen}
        title="More actions"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
        </svg>
      </button>

      {open && createPortal(
        <div className="acct-menu-popup" ref={popupRef} style={{ top: coords.top, left: coords.left, right: 'auto', position: 'absolute' }} onClick={e => e.stopPropagation()}>
          {!node.is_system_generated && (
            <>
              <button className="acct-menu-item" onClick={() => { onRename(); setOpen(false); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                Rename
              </button>

              {node.identifier && (
                <button className="acct-menu-item" onClick={() => { onEditIdentifier(); setOpen(false); }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
                  </svg>
                  Edit Identifier
                </button>
              )}
            </>
          )}

          <div
            ref={toggleRowRef}
            className="acct-menu-item acct-menu-toggle-row"
            onMouseEnter={handleToggleRowMouseEnter}
            onMouseLeave={handleToggleRowMouseLeave}
          >
            <span className="acct-toggle-label">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              Include in AI categorisation
            </span>
            <label className="acct-toggle-switch" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={!!node.include_in_llm}
                onChange={() => onToggleLlm()}
              />
              <span className="acct-toggle-slider" />
            </label>
          </div>

          {tooltipVisible && createPortal(
            <div
              className="acct-llm-tooltip"
              style={{ top: tooltipCoords.top, left: tooltipCoords.left }}
            >
              When enabled, AI will suggest this account as a category when you're reviewing transactions
            </div>,
            document.body
          )}

          {node.is_system_generated ? (
            <div className="acct-menu-item acct-menu-locked">
              🔒 System account
            </div>
          ) : (
            <button className="acct-menu-item acct-menu-danger" onClick={() => { onDeactivate(); setOpen(false); }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6M14 11v6"/>
              </svg>
              Remove
            </button>
          )}
        </div>,
        document.body
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Account Node
// ─────────────────────────────────────────────────────────────────────────────
const AccountNode = ({ node, onRename, onDeactivate, onEditIdentifier, onToggleLlm, renamingId, setRenamingId, renameValue, setRenameValue, savingId, onViewTransactions, level = 0 }) => {
  const [isOpen, setIsOpen] = useState(false);
  const hasChildren = node.children && node.children.length > 0;
  const isRenaming = renamingId === node.account_id;

  const identifierLabel = node.identifier
    ? (node.identifier.account_number_last4 ? `····${node.identifier.account_number_last4}`
      : node.identifier.card_last4 ? `····${node.identifier.card_last4}`
      : node.identifier.institution_name || null)
    : null;

  return (
    <>
      <div 
        className="accounts-row"
        style={{ paddingLeft: `${24 + (level * 16)}px` }}
      >
        <div className="accounts-col-account" style={{ cursor: hasChildren && !isRenaming ? 'pointer' : 'default' }} onClick={() => hasChildren && !isRenaming && setIsOpen(!isOpen)}>
          {hasChildren ? (
            <span className="toggle-icon">{isOpen ? '▼' : '▶'}</span>
          ) : (
            <span style={{ width: '14px', display: 'inline-block' }}></span>
          )}

          {isRenaming ? (
            <input className="rename-input" value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') onRename(node.account_id, renameValue);
                if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
              }}
              onClick={e => e.stopPropagation()} autoFocus />
          ) : (
            <span className="node-name" style={{ fontWeight: hasChildren ? 600 : 400, color: hasChildren ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{node.account_name}</span>
          )}

          {!isRenaming && identifierLabel && (
            <span className="node-identifier">{identifierLabel}</span>
          )}
        </div>

        <div className="accounts-col-actions">
          {isRenaming ? (
            <div className="node-actions" style={{ margin: 0, opacity: 1 }}>
              <button className="node-action-btn save"
                onClick={e => { e.stopPropagation(); onRename(node.account_id, renameValue); }}
                disabled={savingId === node.account_id} title="Save new name">
                {savingId === node.account_id ? <span className="spinner-xs" /> : '✓'}
              </button>
              <button className="node-action-btn cancel"
                onClick={e => { e.stopPropagation(); setRenamingId(null); setRenameValue(''); }} title="Discard changes">✕</button>
            </div>
          ) : (
            <div className="node-actions" style={{ margin: 0 }}>
              <button
                className="node-action-btn"
                style={{ color: 'var(--primary-action, #7c6ff7)' }}
                onClick={e => { e.stopPropagation(); onViewTransactions(node.account_id); }}
                title="View transactions"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
              </button>
              <AccountActionsMenu
                node={node}
                onRename={() => { setRenamingId(node.account_id); setRenameValue(node.account_name); }}
                onDeactivate={() => onDeactivate(node)}
                onEditIdentifier={() => onEditIdentifier(node)}
                onToggleLlm={() => onToggleLlm(node)}
              />
            </div>
          )}
        </div>
      </div>

      {isOpen && hasChildren && node.children.map(child => (
        <AccountNode key={child.account_id} node={child}
          onRename={onRename} onDeactivate={onDeactivate} onEditIdentifier={onEditIdentifier}
          onToggleLlm={onToggleLlm}
          renamingId={renamingId} setRenamingId={setRenamingId}
          renameValue={renameValue} setRenameValue={setRenameValue}
          savingId={savingId} onViewTransactions={onViewTransactions} level={level + 1} />
      ))}
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Accounts Page
// ─────────────────────────────────────────────────────────────────────────────
const Accounts = () => {
  const navigate = useNavigate();
  const user = useUser();
  const { accounts, setAccounts, identifiers, accountsLoading: loading, updateAccount, refreshAccounts } = useData();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [savingId, setSavingId] = useState(null);
  const [identifierTarget, setIdentifierTarget] = useState(null);

  const types = [
    { key: 'ASSET',     label: 'Assets' },
    { key: 'LIABILITY', label: 'Liabilities' },
    { key: 'EQUITY',    label: 'Equity' },
    { key: 'INCOME',    label: 'Income' },
    { key: 'EXPENSE',   label: 'Expenses' },
  ];

  // accounts and identifiers are owned by DataContext; no local fetch needed.

  const buildTree = (allAccounts, type) => {
    const typed = allAccounts.filter(acc => acc.account_type === type && acc.is_active);
    const roots = typed.filter(acc => !acc.parent_account_id || !typed.some(p => p.account_id === acc.parent_account_id));
    const mapChildren = (nodes) => nodes.map(node => {
      const children = typed.filter(c => c.parent_account_id === node.account_id);
      return { ...node, identifier: identifiers[node.account_id] || null, children: children.length > 0 ? mapChildren(children) : [] };
    });
    return mapChildren(roots);
  };

  const handleRename = async (accountId, newName) => {
    if (!newName.trim()) return;
    setSavingId(accountId);
    try {
      const { data: acc } = await supabase.from('accounts').select('is_system_generated').eq('account_id', accountId).single();
      if (acc?.is_system_generated) { alert('System accounts cannot be renamed.'); setSavingId(null); return; }
      const { error } = await supabase.from('accounts').update({ account_name: newName.trim() }).eq('account_id', accountId).eq('user_id', user.id);
      if (error) throw error;
      setRenamingId(null);
      setRenameValue('');
      updateAccount(accountId, { account_name: newName.trim() });
    } catch (err) {
      console.error('Rename failed:', err);
      alert('Failed to rename account.');
    } finally {
      setSavingId(null);
    }
  };

  const handleDeactivate = async (node) => {
    if (node.is_system_generated) { alert('System accounts cannot be deactivated.'); return; }
    const { count: txnCount } = await supabase
      .from('transactions').select('*', { count: 'exact', head: true })
      .or(`base_account_id.eq.${node.account_id},offset_account_id.eq.${node.account_id}`)
      .eq('user_id', user.id);
    const hasChildren = node.children && node.children.length > 0;
    const parts = [];
    if (hasChildren) parts.push('all child accounts will also be deactivated');
    if (txnCount > 0) parts.push(`${txnCount} transaction(s) are linked to this account`);
    const msg = parts.length > 0 ? `Warning: ${parts.join(' and ')}. Proceed?` : `Deactivate "${node.account_name}"?`;
    if (!window.confirm(msg)) return;
    const collectIds = (n) => { const ids = [n.account_id]; if (n.children) n.children.forEach(c => ids.push(...collectIds(c))); return ids; };
    const { error } = await supabase.from('accounts').update({ is_active: false }).in('account_id', collectIds(node)).eq('user_id', user.id);
    if (error) { console.error('Deactivate failed:', error); alert('Failed to deactivate account.'); return; }
    // Patch all deactivated IDs in context state
    collectIds(node).forEach(id => updateAccount(id, { is_active: false }));
  };

  const handleToggleLlm = async (node) => {
    const newVal = !node.include_in_llm;
    const { error } = await supabase
      .from('accounts')
      .update({ include_in_llm: newVal })
      .eq('account_id', node.account_id)
      .eq('user_id', user.id);
    if (error) {
      console.error('Toggle LLM failed:', error);
      alert('Failed to update AI categorisation setting.');
      return;
    }
    // Optimistically update context state
    setAccounts(prev =>
      prev.map(a => a.account_id === node.account_id ? { ...a, include_in_llm: newVal } : a)
    );
  };

  // Navigate to Transactions page with correct filter pre-applied.
  // An account is a "source" (bank/CC) if it has an account_identifier.
  // For group accounts with no identifier, we check if any descendant has one.
  const handleViewTransactions = (accountId) => {
    const hasIdentifier = (id) => !!identifiers[id];
    const hasDescendantIdentifier = (id) => {
      if (hasIdentifier(id)) return true;
      return accounts.some(a => a.parent_account_id === id && hasDescendantIdentifier(a.account_id));
    };

    if (hasDescendantIdentifier(accountId)) {
      navigate('/transactions', { state: { srcAccId: accountId } });
    } else {
      navigate('/transactions', { state: { destAccId: accountId } });
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="accounts-container">
      <div className="page-header">
        <div className="header-title">
          <h1>Chart of Accounts</h1>
          <span className="header-separator">|</span>
          <p>Manage your account hierarchy.</p>
        </div>
        <button className="action-btn" onClick={() => setAddModalOpen(true)}>+ Add Account</button>
      </div>

      {addModalOpen && (
        <AddAccountModal
          onClose={() => setAddModalOpen(false)}
          onCreated={() => {
            setAddModalOpen(false);
            refreshAccounts();
          }}
        />
      )}

      {identifierTarget && (
        <EditIdentifierModal
          account={identifierTarget}
          onClose={() => setIdentifierTarget(null)}
          onSuccess={() => { setIdentifierTarget(null); refreshAccounts(); }}
        />
      )}

      {loading ? (
        <div className="loading-state">Loading accounts...</div>
      ) : (
        <div className="accounts-dashboard">
          {['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'EQUITY'].map((typeKey) => {
            const type = types.find(t => t.key === typeKey);
            const tree = buildTree(accounts, typeKey);
            return (
              <div key={typeKey} className={`accounts-table ${typeKey === 'EQUITY' ? 'equity-cell' : ''}`}>
                <div className="accounts-table-header">
                  <div className="accounts-col-account">{type.label}</div>
                  <div className="accounts-col-actions" style={{ paddingRight: '24px' }}>ACTIONS</div>
                </div>
                <div className="accounts-table-body">
                  {tree.length === 0 ? (
                    <div className="accounts-row-empty">No {type.label.toLowerCase()} added yet.</div>
                  ) : (
                    tree.map(node => (
                      <AccountNode key={node.account_id} node={node}
                        onRename={handleRename} onDeactivate={handleDeactivate}
                        onEditIdentifier={setIdentifierTarget}
                        onToggleLlm={handleToggleLlm}
                        renamingId={renamingId} setRenamingId={setRenamingId}
                        renameValue={renameValue} setRenameValue={setRenameValue}
                        savingId={savingId}
                        onViewTransactions={handleViewTransactions} />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
};

export default Accounts;
