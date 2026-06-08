import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '../shared/supabase';
import { useUser } from './UserContext';

/**
 * DataContext — owns the two primary datasets for the app:
 *   • transactions  (uncategorized_transactions + nested joins)
 *   • accounts      (accounts table + account_identifiers map)
 *
 * Fetched once on mount after the user is available (DataProvider is only
 * rendered inside ModuleGuard when hasModules && hasIdentifiers are both true,
 * so these fetches will always succeed for fully-onboarded users).
 *
 * Exposes optimistic-update helpers so consumers never need to re-fetch the
 * whole list just to reflect a single field change.
 */
const DataContext = createContext(null);

// ─── Transactions query ────────────────────────────────────────────────────────
// Superset of both Transactions.jsx and Overview.jsx requirements:
//   • is_contra, accounts.account_type  → needed by Overview
//   • transaction_id, review_status, attention_level, … → needed by Transactions
const TRANSACTIONS_SELECT = `
  uncategorized_transaction_id,
  txn_date,
  details,
  debit,
  credit,
  document_id,
  account_id,
  group_id,
  source_account:account_id ( account_id, account_name, account_type ),
  source_document:document_id ( document_id, file_name ),
  transactions!uncategorized_transaction_id (
    transaction_id,
    review_status,
    attention_level,
    offset_account_id,
    categorised_by,
    is_uncategorised,
    is_contra,
    user_note,
    accounts:offset_account_id (
      account_name,
      account_type
    )
  )
`;

// ─── Accounts query ────────────────────────────────────────────────────────────
// Exact query from Accounts.jsx fetchAccounts.
const ACCOUNTS_SELECT =
  'account_id, account_name, account_type, balance_nature, parent_account_id, is_active, is_system_generated, include_in_llm';

export function DataProvider({ children }) {
  const user = useUser();

  // ── Transactions state ───────────────────────────────────────────────────
  const [transactions, setTransactions] = useState([]);
  const [transactionsLoading, setTransactionsLoading] = useState(true);
  const [hasMoreTransactions, setHasMoreTransactions] = useState(false);

  // ── Accounts state ───────────────────────────────────────────────────────
  const [accounts, setAccounts] = useState([]);
  const [identifiers, setIdentifiers] = useState({}); // keyed by account_id
  const [accountsLoading, setAccountsLoading] = useState(true);

  // ── Fetch functions ──────────────────────────────────────────────────────
  const fetchTransactions = useCallback(async () => {
    if (!user) return;
    setTransactionsLoading(true);
    try {
      const { data, error } = await supabase
        .from('uncategorized_transactions')
        .select(TRANSACTIONS_SELECT)
        .eq('user_id', user.id)
        .order('txn_date', { ascending: false })
        .range(0, 99);

      if (error) throw error;
      setTransactions(data || []);
      setHasMoreTransactions((data || []).length === 100);
    } catch (err) {
      console.error('[DataContext] fetchTransactions failed:', err);
    } finally {
      setTransactionsLoading(false);
    }
  }, [user]);

  const loadMoreTransactions = useCallback(async () => {
    if (!user) return;
    try {
      const currentCount = transactions.length;
      const { data, error } = await supabase
        .from('uncategorized_transactions')
        .select(TRANSACTIONS_SELECT)
        .eq('user_id', user.id)
        .order('txn_date', { ascending: false })
        .range(currentCount, currentCount + 99);

      if (error) throw error;

      setTransactions(prev => [...prev, ...(data || [])]);
      setHasMoreTransactions((data || []).length === 100);
    } catch (err) {
      console.error('[DataContext] loadMoreTransactions failed:', err);
      throw err;
    }
  }, [user, transactions.length]);

  const fetchAccounts = useCallback(async () => {
    if (!user) return;
    setAccountsLoading(true);
    try {
      const [{ data: accsData, error: accsErr }, { data: identData, error: identErr }] =
        await Promise.all([
          supabase.from('accounts').select(ACCOUNTS_SELECT).eq('user_id', user.id),
          supabase.from('account_identifiers').select('*').eq('user_id', user.id),
        ]);

      if (accsErr) throw accsErr;
      if (identErr) throw identErr;

      const identMap = {};
      (identData || []).forEach(ident => { identMap[ident.account_id] = ident; });

      setAccounts(accsData || []);
      setIdentifiers(identMap);
    } catch (err) {
      console.error('[DataContext] fetchAccounts failed:', err);
    } finally {
      setAccountsLoading(false);
    }
  }, [user]);

  // Mount: fetch both once user is available
  useEffect(() => {
    if (!user) return;
    fetchTransactions();
    fetchAccounts();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Optimistic updaters ──────────────────────────────────────────────────

  /**
   * Merge `patch` into the transaction row identified by `uncategorized_transaction_id`.
   * For complex updates (rollbacks, nested map) consumers can call `setTransactions` directly.
   */
  const updateTransaction = useCallback((uncatId, patch) => {
    setTransactions(prev =>
      prev.map(t =>
        t.uncategorized_transaction_id === uncatId ? { ...t, ...patch } : t
      )
    );
  }, []);

  /**
   * Merge `patch` into the account row identified by `account_id`.
   */
  const updateAccount = useCallback((accountId, patch) => {
    setAccounts(prev =>
      prev.map(a => a.account_id === accountId ? { ...a, ...patch } : a)
    );
  }, []);

  // ── Public refresh helpers ───────────────────────────────────────────────

  /** Full re-fetch of transactions (e.g. after pipeline completes, manual-add). */
  const refreshTransactions = useCallback(() => fetchTransactions(), [fetchTransactions]);

  /** Full re-fetch of accounts + identifiers (e.g. after AddAccountModal, EditIdentifier). */
  const refreshAccounts = useCallback(() => fetchAccounts(), [fetchAccounts]);

  // ── Context value ────────────────────────────────────────────────────────
  const value = {
    // Transactions
    transactions,
    setTransactions,
    transactionsLoading,
    refreshTransactions,
    updateTransaction,
    hasMoreTransactions,
    loadMoreTransactions,

    // Accounts
    accounts,
    setAccounts,
    identifiers,
    setIdentifiers,
    accountsLoading,
    refreshAccounts,
    updateAccount,
  };

  return (
    <DataContext.Provider value={value}>
      {children}
    </DataContext.Provider>
  );
}

/**
 * useData() — consume the shared data context.
 * Must be called inside a component descendant of <DataProvider>.
 */
export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) {
    throw new Error('useData() must be used inside a <DataProvider>');
  }
  return ctx;
}
