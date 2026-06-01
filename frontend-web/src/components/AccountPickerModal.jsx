import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../shared/supabase';
import { useUser } from '../context/UserContext';
import AddAccountModal from './AddAccountModal';
import '../styles/AccountPickerModal.css';

const ACCOUNT_TYPE_ORDER = ['INCOME', 'EXPENSE', 'ASSET', 'LIABILITY', 'EQUITY'];

const AccountPickerModal = ({ 
  onSelect, 
  onClose, 
  currentAccountId, 
  transactionDirection = null,
  preloadedAccounts = null,
  allowedParentAccountNames = null,
  allowedAccountNames = null,
  onAccountCreated
}) => {
  const user = useUser();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const searchInputRef = useRef(null);

  // Determine which balance nature to show based on transaction direction
  // If transaction is DEBIT (money out), show DEBIT nature accounts (EXPENSE, ASSET)
  // If transaction is CREDIT (money in), show CREDIT nature accounts (INCOME, LIABILITY, EQUITY)
  const allowedBalanceNature = transactionDirection === 'DEBIT' ? 'DEBIT' : transactionDirection === 'CREDIT' ? 'CREDIT' : null;

  useEffect(() => {
    if (preloadedAccounts) {
      setAccounts(preloadedAccounts);
      setLoading(false);
      return;
    }

    const fetchAccounts = async () => {
      if (!supabase) {
        console.error('Supabase client is null — check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
        setLoading(false);
        return;
      }
      try {
        console.log('🔍 Fetching accounts for user:', user?.id);
        if (!user) return;

        let query = supabase
          .from('accounts')
          .select('account_id, account_name, account_type, balance_nature, parent_account_id, is_active')
          .eq('user_id', user.id)
          .eq('is_active', true);

        // Filter by balance nature if transaction direction is specified
        // TODO: temporarily disabled — re-enable when balance_nature data is reliable
        // if (allowedBalanceNature) {
        //   query = query.eq('balance_nature', allowedBalanceNature);
        // }

        const { data, error } = await query
          .order('account_type', { ascending: true })
          .order('account_name', { ascending: true });

        console.log('📦 Raw accounts data:', data, 'Error:', error);
        console.log('🔢 Count:', data?.length, 'is_active values:', data?.map(a => a.is_active));

        if (error) throw error;
        setAccounts(data || []);
      } catch (err) {
        console.error('Fetch accounts failed:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchAccounts();

    // Auto-focus search input
    setTimeout(() => {
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      }
    }, 0);
  }, [/* allowedBalanceNature, */ preloadedAccounts]);

  // Handle escape key
  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  // Group and filter accounts
  const groupedAccounts = () => {
    const grouped = {};
    let filteredList = accounts;

    if (allowedParentAccountNames && allowedParentAccountNames.length > 0) {
      const allowedParentIds = accounts
        .filter(a => allowedParentAccountNames.includes(a.account_name))
        .map(a => a.account_id);

      // Children of allowed parent groups
      filteredList = accounts.filter(a =>
        a.parent_account_id && allowedParentIds.includes(a.parent_account_id)
      );

      // Also include any directly-named accounts (e.g. 'Cash in Hand')
      if (allowedAccountNames && allowedAccountNames.length > 0) {
        const direct = accounts.filter(a => allowedAccountNames.includes(a.account_name));
        const directIds = new Set(filteredList.map(a => a.account_id));
        direct.forEach(a => { if (!directIds.has(a.account_id)) filteredList.push(a); });
      }
    } else if (allowedAccountNames && allowedAccountNames.length > 0) {
      filteredList = accounts.filter(a => allowedAccountNames.includes(a.account_name));
    }

    filteredList.forEach((account) => {
      if (!grouped[account.account_type]) {
        grouped[account.account_type] = [];
      }
      grouped[account.account_type].push(account);
    });

    // Filter by search term (case-insensitive)
    const filtered = {};
    ACCOUNT_TYPE_ORDER.forEach((type) => {
      if (grouped[type]) {
        filtered[type] = grouped[type].filter((acc) =>
          acc.account_name.toLowerCase().includes(searchTerm.toLowerCase())
        );
      }
    });

    return ACCOUNT_TYPE_ORDER.map((type) => ({
      type,
      accounts: filtered[type] || []
    })).filter((group) => group.accounts.length > 0);
  };

  const groups = groupedAccounts();

  const handleAccountCreated = (newAccount) => {
    // Notify parent so it can refresh its own account lists
    onAccountCreated?.(newAccount);
    // Auto-select the newly created account and close the picker
    onSelect(newAccount);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="account-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Select Account</h2>
          <button
            className="add-account-trigger-btn"
            onClick={() => setShowAddAccount(true)}
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" 
                 stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Add Account
          </button>
          <button
            className="modal-close-btn"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '24px',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
              padding: 0,
              width: '24px',
              height: '24px'
            }}
          >
            ✕
          </button>
        </div>

        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search accounts..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="account-search-input"
        />

        <div className="account-list-container">
          {loading ? (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <span className="spinner"></span>
              <p style={{ marginTop: '12px' }}>Loading accounts...</p>
            </div>
          ) : groups.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <p>No accounts found</p>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.type} className="account-group">
                <div className="account-group-header">{group.type}</div>
                {group.accounts.map((account) => (
                  <button
                    key={account.account_id}
                    className={`account-item ${
                      account.account_id === currentAccountId ? 'active' : ''
                    }`}
                    onClick={() => {
                      onSelect(account);
                      onClose();
                    }}
                  >
                    <span className="account-name">{account.account_name}</span>
                    {account.account_id === currentAccountId && (
                      <span className="checkmark">✓</span>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        {showAddAccount && (
          <AddAccountModal
            onClose={() => setShowAddAccount(false)}
            onCreated={handleAccountCreated}
          />
        )}
      </div>
    </div>
  );
};

export default AccountPickerModal;
