import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../shared/supabase';
import { useUser } from '../context/UserContext';

const AddAccountModal = ({ onClose, onCreated, defaultValues = {} }) => {
  const user = useUser();
  const [form, setForm] = useState({
    account_name: '',
    account_type: 'EXPENSE',
    parent_account_id: null,
    balance_nature: 'DEBIT',
    include_in_llm: true,
    ...defaultValues,           // caller can seed account_type, parent_account_id, etc.
  });
  const [identifierForm, setIdentifierForm] = useState({ institution_name: '', account_number_last4: '', ifsc_code: '', card_last4: '', card_network: 'VISA', wallet_id: '' });
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState([]);

  useEffect(() => {
    const nature = { ASSET: 'DEBIT', EXPENSE: 'DEBIT', LIABILITY: 'CREDIT', EQUITY: 'CREDIT', INCOME: 'CREDIT' }[form.account_type] || 'DEBIT';
    setForm(prev => ({ ...prev, balance_nature: nature }));
  }, [form.account_type]);

  useEffect(() => {
    const fetchAccounts = async () => {
      if (!user) return;

      const { data } = await supabase
        .from('accounts')
        .select('account_id, account_name, account_type, is_active')
        .eq('user_id', user.id)
        .eq('is_active', true);

      setAccounts(data || []);
    };

    fetchAccounts();
  }, []);

  const handleReset = () => {
    setForm({ account_name: '', account_type: 'EXPENSE', parent_account_id: null, balance_nature: 'DEBIT', include_in_llm: true, ...defaultValues });
    setIdentifierForm({ institution_name: '', account_number_last4: '', ifsc_code: '', card_last4: '', card_network: 'VISA', wallet_id: '' });
  };
  const handleClose = () => { handleReset(); onClose(); };

  // Determine if current account type needs identifiers
  const needsIdentifier = () => {
    if (!form.parent_account_id) return false;
    const parent = accounts.find(a => a.account_id === parseInt(form.parent_account_id));
    if (!parent) return false;
    // Check if parent is Bank Accounts, Credit Cards, or Digital Wallets
    return ['Bank Accounts', 'Credit Cards', 'Digital Wallets'].includes(parent.account_name);
  };

  // Override balance_nature when Credit Cards is selected as parent
  useEffect(() => {
    if (!form.parent_account_id || accounts.length === 0) return;
    const parent = accounts.find(a => a.account_id === parseInt(form.parent_account_id));
    if (parent?.account_name === 'Credit Cards') {
      setForm(prev => ({ ...prev, balance_nature: 'DEBIT' }));
    }
  }, [form.parent_account_id, accounts]);

  const getIdentifierType = () => {
    if (!form.parent_account_id) return null;
    const parent = accounts.find(a => a.account_id === parseInt(form.parent_account_id));
    if (!parent) return null;
    if (parent.account_name === 'Credit Cards') return 'CREDIT_CARD';
    if (parent.account_name === 'Bank Accounts') return 'BANK';
    if (parent.account_name === 'Digital Wallets') return 'CASH_WALLET';
    return null;
  };

  const handleSubmit = async () => {
    if (!form.account_name.trim()) return;

    const identifierType = getIdentifierType();

    // Validate identifier fields if needed
    if (identifierType === 'BANK' && identifierForm.account_number_last4 && identifierForm.account_number_last4.length !== 4) {
      alert('Last 4 digits must be exactly 4 characters.');
      return;
    }
    if (identifierType === 'CREDIT_CARD' && identifierForm.card_last4 && identifierForm.card_last4.length !== 4) {
      alert('Last 4 digits must be exactly 4 characters.');
      return;
    }

    setLoading(true);
    try {
      if (!user) throw new Error('Not authenticated');

      // Create account
      const { data, error } = await supabase.from('accounts').insert([{
        user_id: user.id,
        account_name: form.account_name.trim(),
        account_type: form.account_type,
        balance_nature: form.balance_nature,
        parent_account_id: form.parent_account_id || null,
        is_active: true,
        is_system_generated: false,
        include_in_llm: form.include_in_llm
      }]).select().single();
      if (error) throw error;

      // Create identifier if applicable
      if (identifierType && data) {
        const identifierPayload = {
          account_id: data.account_id,
          user_id: user.id,
          institution_name: identifierForm.institution_name.trim() || null,
          is_primary: false,
          is_active: true
        };

        if (identifierType === 'BANK') {
          identifierPayload.account_number_last4 = identifierForm.account_number_last4 || null;
          identifierPayload.ifsc_code = identifierForm.ifsc_code.trim() || null;
        } else if (identifierType === 'CREDIT_CARD') {
          identifierPayload.card_last4 = identifierForm.card_last4 || null;
          identifierPayload.card_network = identifierForm.card_network || null;
        } else if (identifierType === 'CASH_WALLET') {
          identifierPayload.wallet_id = identifierForm.wallet_id.trim() || null;
        }

        const { error: idError } = await supabase.from('account_identifiers').insert([identifierPayload]);
        if (idError) throw idError;
      }

      handleReset();
      if (onCreated) onCreated(data);
      onClose();
    } catch (err) {
      console.error('Add account failed:', err);
      alert('Failed to add account.');
    } finally {
      setLoading(false);
    }
  };

  const sameTypeAccounts = accounts.filter(a => a.account_type === form.account_type && a.is_active);
  const identifierType = getIdentifierType();
  const showIdentifierFields = needsIdentifier();

  return createPortal(
    <div className="modal-overlay" onClick={handleClose} style={{ position: 'fixed', zIndex: 1100 }}>
      <div className="add-account-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add Account</h2>
          <button className="close-modal-btn" onClick={handleClose} title="Close without saving">✕</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Account Name *</label>
            <input type="text" className="form-input" placeholder="e.g., Operating Expenses"
              value={form.account_name} onChange={e => setForm(p => ({ ...p, account_name: e.target.value }))} disabled={loading} />
          </div>
          <div className="form-group">
            <label className="form-label">Account Type *</label>
            <select className="form-select" value={form.account_type} onChange={e => setForm(p => ({ ...p, account_type: e.target.value }))} disabled={loading}>
              <option value="ASSET">Asset</option>
              <option value="LIABILITY">Liability</option>
              <option value="EQUITY">Equity</option>
              <option value="INCOME">Income</option>
              <option value="EXPENSE">Expense</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Parent Account</label>
            <select className="form-select" value={form.parent_account_id || ''} onChange={e => setForm(p => ({ ...p, parent_account_id: e.target.value || null }))} disabled={loading}>
              <option value="">None (top level)</option>
              {sameTypeAccounts.map(acc => (<option key={acc.account_id} value={acc.account_id}>{acc.account_name}</option>))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Balance Nature *</label>
            <select className="form-select" value={form.balance_nature} onChange={e => setForm(p => ({ ...p, balance_nature: e.target.value }))} disabled={loading}>
              <option value="DEBIT">Debit</option>
              <option value="CREDIT">Credit</option>
            </select>
          </div>

          {/* ── AI Categorisation Checkbox ── */}
          <label
            htmlFor="add-account-include-in-llm"
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
              background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.18)',
              borderRadius: 10, cursor: loading ? 'not-allowed' : 'pointer', userSelect: 'none'
            }}
            title={form.include_in_llm ? 'AI will suggest this account — click to exclude it' : 'AI will not suggest this account — click to include it'}
          >
            <input
              type="checkbox"
              id="add-account-include-in-llm"
              checked={form.include_in_llm}
              onChange={() => setForm(p => ({ ...p, include_in_llm: !p.include_in_llm }))}
              disabled={loading}
              style={{ width: 16, height: 16, accentColor: 'var(--primary, #6366f1)', cursor: loading ? 'not-allowed' : 'pointer', flexShrink: 0 }}
            />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>🤖</span> Include in AI Categorisation
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                When enabled, AI will suggest this account as a category when you're reviewing transactions
              </div>
            </div>
          </label>

          {showIdentifierFields && (
            <>
              <div style={{ margin: '20px 0 12px', padding: '12px', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 16 }}>
                    {identifierType === 'BANK' && '🏦'}
                    {identifierType === 'CREDIT_CARD' && '💳'}
                    {identifierType === 'CASH_WALLET' && '👛'}
                  </span>
                  <strong style={{ fontSize: 14, color: 'var(--text-primary)' }}>Account Identifier</strong>
                </div>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
                  Add details to help match uploaded statements to this account
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">Institution / Bank Name</label>
                <input type="text" className="form-input"
                  placeholder={identifierType === 'CREDIT_CARD' ? 'e.g. HDFC, Amex' : identifierType === 'CASH_WALLET' ? 'e.g. PayTM, GPay' : 'e.g. HDFC, SBI'}
                  value={identifierForm.institution_name}
                  onChange={e => setIdentifierForm(p => ({ ...p, institution_name: e.target.value }))}
                  disabled={loading} />
              </div>

              {identifierType === 'BANK' && (
                <>
                  <div className="form-group">
                    <label className="form-label">Last 4 Digits of Account No.</label>
                    <input type="text" className="form-input" placeholder="e.g. 4321" maxLength={4}
                      value={identifierForm.account_number_last4}
                      onChange={e => setIdentifierForm(p => ({ ...p, account_number_last4: e.target.value.replace(/\D/g, '') }))}
                      disabled={loading} />
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, display: 'block' }}>
                      Used to match uploaded bank statements to this account
                    </span>
                  </div>
                  <div className="form-group">
                    <label className="form-label">IFSC Code</label>
                    <input type="text" className="form-input" placeholder="e.g. HDFC0001234"
                      value={identifierForm.ifsc_code}
                      onChange={e => setIdentifierForm(p => ({ ...p, ifsc_code: e.target.value.toUpperCase() }))}
                      disabled={loading} />
                  </div>
                </>
              )}

              {identifierType === 'CREDIT_CARD' && (
                <>
                  <div className="form-group">
                    <label className="form-label">Last 4 Digits of Card</label>
                    <input type="text" className="form-input" placeholder="e.g. 9876" maxLength={4}
                      value={identifierForm.card_last4}
                      onChange={e => setIdentifierForm(p => ({ ...p, card_last4: e.target.value.replace(/\D/g, '') }))}
                      disabled={loading} />
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, display: 'block' }}>
                      Used to match uploaded card statements to this account
                    </span>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Card Network</label>
                    <select className="form-select"
                      value={identifierForm.card_network}
                      onChange={e => setIdentifierForm(p => ({ ...p, card_network: e.target.value }))}
                      disabled={loading}>
                      <option value="VISA">VISA</option>
                      <option value="MASTERCARD">Mastercard</option>
                      <option value="AMEX">Amex</option>
                      <option value="RUPAY">RuPay</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </div>
                </>
              )}

              {identifierType === 'CASH_WALLET' && (
                <div className="form-group">
                  <label className="form-label">Wallet ID / Phone</label>
                  <input type="text" className="form-input" placeholder="e.g. 9876543210@paytm"
                    value={identifierForm.wallet_id}
                    onChange={e => setIdentifierForm(p => ({ ...p, wallet_id: e.target.value }))}
                    disabled={loading} />
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="cancel-btn" onClick={handleClose} disabled={loading} title="Discard and close">Cancel</button>
          <button className="submit-btn" onClick={handleSubmit} disabled={!form.account_name.trim() || loading} title={!form.account_name.trim() ? 'Enter an account name to continue' : 'Save and add this account'}>
            {loading ? <span className="spinner"></span> : 'Add Account'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default AddAccountModal;
