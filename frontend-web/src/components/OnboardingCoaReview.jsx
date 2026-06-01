import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../shared/supabase';
import { useUser } from '../context/UserContext';
import AddAccountModal from './AddAccountModal';
import '../styles/Accounts.css';
import '../styles/OnboardingCoaReview.css';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const POPUP_W = 210;

// ─────────────────────────────────────────────────────────────────────────────
// AccountActionsMenu — identical to Accounts.jsx
// ─────────────────────────────────────────────────────────────────────────────
const AccountActionsMenu = ({ node, onRename, onDeactivate, onToggleLlm }) => {
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
    window.addEventListener('scroll', scrollHandler, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('scroll', scrollHandler, true);
    };
  }, [open]);

  return (
    <div className="acct-menu-wrap" ref={menuRef}>
      <button className="node-action-btn acct-more-btn" onClick={toggleOpen} title="More actions">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
        </svg>
      </button>

      {open && createPortal(
        <div
          className="acct-menu-popup"
          ref={popupRef}
          style={{ top: coords.top, left: coords.left, right: 'auto', position: 'absolute' }}
          onClick={e => e.stopPropagation()}
        >
          {!node.is_system_generated && (
            <button className="acct-menu-item" onClick={() => { onRename(); setOpen(false); }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              Rename
            </button>
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
              <input type="checkbox" checked={!!node.include_in_llm} onChange={() => onToggleLlm()} />
              <span className="acct-toggle-slider" />
            </label>
          </div>

          {tooltipVisible && createPortal(
            <div className="acct-llm-tooltip" style={{ top: tooltipCoords.top, left: tooltipCoords.left }}>
              When enabled, AI will suggest this account as a category when you're reviewing transactions
            </div>,
            document.body
          )}

          {node.is_system_generated ? (
            <div className="acct-menu-item acct-menu-locked">🔒 System account</div>
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
// AccountNode — expanded by default, no "View Transactions" button
// ─────────────────────────────────────────────────────────────────────────────
const AccountNode = ({
  node, onRename, onDeactivate, onToggleLlm,
  renamingId, setRenamingId, renameValue, setRenameValue, savingId,
  level = 0,
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const hasChildren = node.children && node.children.length > 0;
  const isRenaming = renamingId === node.account_id;

  return (
    <>
      <div className="accounts-row" style={{ paddingLeft: `${24 + level * 16}px` }}>
        <div
          className="accounts-col-account"
          style={{ cursor: hasChildren && !isRenaming ? 'pointer' : 'default' }}
          onClick={() => hasChildren && !isRenaming && setIsOpen(!isOpen)}
        >
          {hasChildren
            ? <span className="toggle-icon">{isOpen ? '▼' : '▶'}</span>
            : <span style={{ width: '14px', display: 'inline-block' }} />}

          {isRenaming ? (
            <input
              className="rename-input"
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') onRename(node.account_id, renameValue);
                if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
              }}
              onClick={e => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span className="node-name" style={{
              fontWeight: hasChildren ? 600 : 400,
              color: hasChildren ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}>
              {node.account_name}
            </span>
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
                onClick={e => { e.stopPropagation(); setRenamingId(null); setRenameValue(''); }}
                title="Discard changes">✕</button>
            </div>
          ) : (
            <div className="node-actions" style={{ margin: 0 }}>
              <AccountActionsMenu
                node={node}
                onRename={() => { setRenamingId(node.account_id); setRenameValue(node.account_name); }}
                onDeactivate={() => onDeactivate(node)}
                onToggleLlm={() => onToggleLlm(node)}
              />
            </div>
          )}
        </div>
      </div>

      {isOpen && hasChildren && node.children.map(child => (
        <AccountNode key={child.account_id} node={child}
          onRename={onRename} onDeactivate={onDeactivate} onToggleLlm={onToggleLlm}
          renamingId={renamingId} setRenamingId={setRenamingId}
          renameValue={renameValue} setRenameValue={setRenameValue}
          savingId={savingId} level={level + 1} />
      ))}
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// OnboardingCoaReview — combined bank setup + category review
// ─────────────────────────────────────────────────────────────────────────────
const OnboardingCoaReview = ({ onSetupComplete }) => {
  const user = useUser();
  const [accounts, setAccounts]       = useState([]);
  const [identifiers, setIdentifiers] = useState({});      // account_id → identifier row
  const [loading, setLoading]         = useState(true);
  const [addModalFor, setAddModalFor] = useState(null);    // null | 'BANK' | 'CREDIT_CARD'
  const [bankParentId, setBankParentId]   = useState(null);
  const [cardParentId, setCardParentId]   = useState(null);
  const [renamingId, setRenamingId]   = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [savingId, setSavingId]       = useState(null);
  const [continueError, setContinueError] = useState('');
  const [continuing, setContinuing]   = useState(false);

  // Category tree sections — all types, excluding the three system bank/card parents
  // that already appear in Section 1.
  const EXCLUDED_SYSTEM_NAMES = new Set(['Bank Accounts', 'Credit Cards', 'Digital Wallets']);

  const categoryTypes = [
    { key: 'ASSET',     label: 'Assets' },
    { key: 'LIABILITY', label: 'Liabilities' },
    { key: 'INCOME',    label: 'Income' },
    { key: 'EXPENSE',   label: 'Expenses' },
    { key: 'EQUITY',    label: 'Equity' },
  ];

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      if (!user) return;

      const [{ data: accsData, error: accsErr }, { data: identData, error: identErr }] = await Promise.all([
        supabase
          .from('accounts')
          .select('account_id, account_name, account_type, balance_nature, parent_account_id, is_active, is_system_generated, include_in_llm')
          .eq('user_id', user.id),
        supabase
          .from('account_identifiers')
          .select('*')
          .eq('user_id', user.id),
      ]);
      if (accsErr) throw accsErr;
      if (identErr) throw identErr;

      const identMap = {};
      (identData || []).forEach(id => { identMap[id.account_id] = id; });

      setAccounts(accsData || []);
      setIdentifiers(identMap);

      // Find the IDs of the "Bank Accounts" and "Credit Cards" parent categories
      // so we can pre-scope AddAccountModal correctly.
      const bankParent = (accsData || []).find(a => a.account_name === 'Bank Accounts' && a.account_type === 'ASSET');
      const cardParent = (accsData || []).find(a => a.account_name === 'Credit Cards'  && a.account_type === 'ASSET');
      if (bankParent) setBankParentId(String(bankParent.account_id));
      if (cardParent) setCardParentId(String(cardParent.account_id));
    } catch (err) {
      console.error('Fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Derived: linked bank accounts ─────────────────────────────────────────
  // ASSET accounts that already have an account_identifier attached
  const linkedAccounts = accounts.filter(a =>
    a.account_type === 'ASSET' &&
    a.is_active &&
    !a.is_system_generated &&
    identifiers[a.account_id]
  );

  const hasBankAccount = linkedAccounts.some(a => {
    const ident = identifiers[a.account_id];
    return ident && ident.account_number_last4 != null;
  });

  // ── Build hierarchy for categories ───────────────────────────────────────
  // `type` is the account_type key. System nodes whose names are in
  // EXCLUDED_SYSTEM_NAMES are hidden (they live in Section 1 already).
  const buildTree = (type) => {
    const typed = accounts.filter(a =>
      a.account_type === type &&
      a.is_active &&
      !(a.is_system_generated && EXCLUDED_SYSTEM_NAMES.has(a.account_name))
    );
    const roots = typed.filter(
      a => !a.parent_account_id || !typed.some(p => p.account_id === a.parent_account_id)
    );
    const mapChildren = (nodes) => nodes.map(node => {
      const children = typed.filter(c => c.parent_account_id === node.account_id);
      return { ...node, children: children.length > 0 ? mapChildren(children) : [] };
    });
    return mapChildren(roots);
  };

  // ── Rename ─────────────────────────────────────────────────────────────────
  const handleRename = async (accountId, newName) => {
    if (!newName.trim()) return;
    setSavingId(accountId);
    try {
      const { data: acc } = await supabase.from('accounts').select('is_system_generated').eq('account_id', accountId).single();
      if (acc?.is_system_generated) { alert('System accounts cannot be renamed.'); setSavingId(null); return; }
      const { error } = await supabase.from('accounts').update({ account_name: newName.trim() }).eq('account_id', accountId).eq('user_id', user.id);
      if (error) throw error;
      setRenamingId(null); setRenameValue('');
      await fetchAll();
    } catch (err) {
      console.error('Rename failed:', err);
      alert('Failed to rename account.');
    } finally { setSavingId(null); }
  };

  // ── Deactivate — no confirm dialog ────────────────────────────────────────
  const handleDeactivate = async (node) => {
    if (node.is_system_generated) { alert('System accounts cannot be removed.'); return; }
    const collectIds = (n) => { const ids = [n.account_id]; if (n.children) n.children.forEach(c => ids.push(...collectIds(c))); return ids; };
    const { error } = await supabase.from('accounts').update({ is_active: false }).in('account_id', collectIds(node)).eq('user_id', user.id);
    if (error) { console.error('Deactivate failed:', error); alert('Failed to remove account.'); return; }
    await fetchAll();
  };

  // ── Toggle LLM ─────────────────────────────────────────────────────────────
  const handleToggleLlm = async (node) => {
    const newVal = !node.include_in_llm;
    const { error } = await supabase.from('accounts').update({ include_in_llm: newVal }).eq('account_id', node.account_id).eq('user_id', user.id);
    if (error) { console.error('Toggle LLM failed:', error); alert('Failed to update AI setting.'); return; }
    setAccounts(prev => prev.map(a => a.account_id === node.account_id ? { ...a, include_in_llm: newVal } : a));
  };

  // ── Continue ───────────────────────────────────────────────────────────────
  const handleContinue = async () => {
    setContinueError('');
    setContinuing(true);
    try {
      const { data: bankIdents } = await supabase
        .from('account_identifiers')
        .select('identifier_id')
        .eq('user_id', user.id)
        .not('account_number_last4', 'is', null)
        .limit(1);

      if (!bankIdents || bankIdents.length === 0) {
        setContinueError('Please add at least one bank account before continuing.');
        setContinuing(false);
        return;
      }
      if (onSetupComplete) onSetupComplete();
    } catch (err) {
      console.error('Continue failed:', err);
      setContinueError('Something went wrong. Please try again.');
      setContinuing(false);
    }
  };

  // ── Helper: label for a linked account ───────────────────────────────────
  const linkedAccountLabel = (acc) => {
    const ident = identifiers[acc.account_id];
    if (!ident) return acc.account_name;
    const institution = ident.institution_name || '';
    const last4 = ident.account_number_last4
      ? `····${ident.account_number_last4}`
      : ident.card_last4
        ? `····${ident.card_last4}`
        : '';
    return institution && last4 ? `${institution} ${last4}` : institution || last4 || acc.account_name;
  };

  const linkedAccountIcon = (acc) => {
    const ident = identifiers[acc.account_id];
    if (!ident) return '🏦';
    if (ident.card_last4) return '💳';
    if (ident.wallet_id) return '👛';
    return '🏦';
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="coa-review-wrapper">

      {/* ── Page header ── */}
      <div className="coa-review-header">
        <div className="coa-review-header-inner">
          <h1 className="coa-review-title">Set up your accounts</h1>
          <span className="coa-review-separator">|</span>
          <p className="coa-review-subtitle">
            Add your bank accounts and remove any spending categories that don't apply to you.
          </p>
        </div>
      </div>

      {/* ── Add account modal ── */}
      {addModalFor && (
        <AddAccountModal
          onClose={() => setAddModalFor(null)}
          onCreated={() => { setAddModalFor(null); fetchAll(); }}
          defaultValues={
            addModalFor === 'BANK'
              ? { account_type: 'ASSET', parent_account_id: bankParentId }
              : { account_type: 'ASSET', parent_account_id: cardParentId }
          }
        />
      )}

      <div className="coa-review-content">
        {loading ? (
          <div className="loading-state">Loading…</div>
        ) : (
          <>
            {/* ── Section 1: Your accounts ── */}
            <div className="onb-section">
              <div className="onb-section-header">
                <div className="onb-section-title-wrap">
                  <h2 className="onb-section-title">Your accounts</h2>
                  <span className="coa-review-separator">|</span>
                  <p className="onb-section-subtitle">
                    Add the bank accounts and credit cards you want to track.
                  </p>
                </div>
                <div className="onb-add-btns">
                  <button className="onb-add-btn" onClick={() => setAddModalFor('BANK')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Add Bank Account
                  </button>
                  <button className="onb-add-btn onb-add-btn--card" onClick={() => setAddModalFor('CREDIT_CARD')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Add Credit Card
                  </button>
                </div>
              </div>

              {linkedAccounts.length === 0 ? (
                <div className="onb-empty-prompt">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  Add at least one bank account to continue.
                </div>
              ) : (
                <div className="onb-accounts-list">
                  {linkedAccounts.map(acc => (
                    <div key={acc.account_id} className="onb-account-chip">
                      <span className="onb-account-icon">{linkedAccountIcon(acc)}</span>
                      <span className="onb-account-label">{linkedAccountLabel(acc)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Section 2: Spending categories ── */}
            <div className="onb-section">
              <div className="onb-section-header onb-section-header--nobtns">
                <div className="onb-section-title-wrap">
                  <h2 className="onb-section-title">Your spending categories</h2>
                  <span className="coa-review-separator">|</span>
                  <p className="onb-section-subtitle">
                    Remove any categories that don't apply to you. You can always change this later.
                  </p>
                </div>
              </div>

              <div className="accounts-dashboard">
                {categoryTypes.map(({ key, label }) => {
                  const tree = buildTree(key);
                  return (
                    <div key={key} className={`accounts-table ${key === 'EQUITY' ? 'equity-cell' : ''}`}>
                      <div className="accounts-table-header">
                        <div className="accounts-col-account">{label}</div>
                        <div className="accounts-col-actions" style={{ paddingRight: '24px' }}>ACTIONS</div>
                      </div>
                      <div className="accounts-table-body">
                        {tree.length === 0 ? (
                          <div className="accounts-row-empty">No {label.toLowerCase()} added yet.</div>
                        ) : (
                          tree.map(node => (
                            <AccountNode key={node.account_id} node={node}
                              onRename={handleRename} onDeactivate={handleDeactivate}
                              onToggleLlm={handleToggleLlm}
                              renamingId={renamingId} setRenamingId={setRenamingId}
                              renameValue={renameValue} setRenameValue={setRenameValue}
                              savingId={savingId} />
                          ))
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Sticky footer ── */}
      <div className="coa-review-footer">
        {continueError && (
          <div className="coa-review-error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {continueError}
          </div>
        )}
        <button
          className="coa-review-continue-btn"
          onClick={handleContinue}
          disabled={continuing}
        >
          {continuing
            ? <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
            : 'Continue →'}
        </button>
      </div>
    </div>
  );
};

export default OnboardingCoaReview;
