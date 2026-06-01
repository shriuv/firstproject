import React, { useState, useEffect } from 'react';
import { supabase } from '../shared/supabase';
import { useUser } from '../context/UserContext';
import '../styles/SetupAccounts.css';

const PARENT_NAMES = {
  BANK: 'Bank Accounts',
  CREDIT_CARD: 'Credit Cards',
  CASH_WALLET: 'Digital Wallets'
};

const SetupAccounts = ({ onSetupAccountsComplete }) => {
  const user = useUser();
  const [accounts, setAccounts] = useState([]); // Array of forms currently active
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setAccounts([{
      id: Date.now(),
      type: 'BANK',
      institution_name: '',
      account_name: '',
      last4: '',
      ifsc_code: '',
      card_network: 'VISA',
      balance: '',
    }]);
  }, []);

  const addAccountForm = (type) => {
    setError('');
    const newAccount = {
      id: Date.now(),
      type, // 'BANK', 'CREDIT_CARD', 'CASH_WALLET'
      institution_name: '',
      account_name: '',
      last4: '',
      ifsc_code: '',
      card_network: 'VISA', // VISA or MASTERCARD
      balance: '',
    };
    setAccounts([...accounts, newAccount]);
  };

  const removeAccountForm = (id) => {
    setAccounts(accounts.filter(acc => acc.id !== id));
  };

  const handleChange = (id, field, value) => {
    setAccounts(accounts.map(acc => {
      if (acc.id === id) {
        if ((field === 'last4') && value.length > 4) return acc; // Enforce max 4 digits
        return { ...acc, [field]: value };
      }
      return acc;
    }));
  };

  const handleFinishSetup = async () => {
    setLoading(true);
    setError('');

    try {
      if (!user) throw new Error("No authenticated user found.");

      // Validate that at least ONE Bank Account is added
      const hasBank = accounts.some(acc => acc.type === 'BANK');
      if (!hasBank) {
        throw new Error("You must add at least one Bank Account to finish setup.");
      }

      for (const account of accounts) {
        // 1. Validate fields
        const isBank = account.type === 'BANK';
        const isCredit = account.type === 'CREDIT_CARD';

        if ((isBank || isCredit) && account.last4.length !== 4) {
          throw new Error(`Last 4 digits must be exactly 4 numbers inside item ${account.institution_name || 'Accounts'}.`);
        }

        // Establish live name wrapper
        const fallbackName = isBank ? 'Bank Account' : isCredit ? 'Credit Card' : 'Cash/Wallet';
        const accName = account.account_name || account.institution_name || fallbackName;

        // Fetch parent_account_id from existing COA mapping via account_name lookup
        let parentAccountId = null;
        const parentName = PARENT_NAMES[account.type];
        if (parentName) {
          const { data: tmpl, error: tmplError } = await supabase
            .from('coa_templates')
            .select('template_id')
            .eq('account_name', parentName)
            .maybeSingle();

          if (tmplError) {
            console.error(`Error fetching template for ${parentName}:`, tmplError);
          }

          if (tmpl?.template_id) {
            const { data: parentAcc, error: parentError } = await supabase
              .from('accounts')
              .select('account_id')
              .eq('user_id', user.id)
              .eq('template_id', tmpl.template_id)
              .maybeSingle();

            if (parentError) {
              console.error(`Error fetching parent account for ${parentName}:`, parentError);
            }

            if (parentAcc) {
              parentAccountId = parentAcc.account_id;
            } else {
              console.warn(`Parent account not found for ${parentName}. Account will be created at root level.`);
            }
          }
        }

        // 2. Create Accounts table entry
        const { data: insertedAcc, error: accError } = await supabase
          .from('accounts')
          .insert([{
            user_id: user.id,
            account_name: accName,
            account_type: isCredit ? 'LIABILITY' : 'ASSET', // CCs are usually liability
            balance_nature: 'DEBIT',
            is_system_generated: false,
            parent_account_id: parentAccountId
          }])
          .select()
          .single();

        if (accError) throw accError;

        // 3. Create Account Identifier entry if applicable
        if (insertedAcc && (isBank || isCredit)) {
          const identifierData = {
            account_id: insertedAcc.account_id,
            user_id: user.id,
            institution_name: account.institution_name,
            is_primary: false,
            is_active: true
          };

          if (isBank) {
            identifierData.account_number_last4 = account.last4;
            identifierData.ifsc_code = account.ifsc_code;
          } else if (isCredit) {
            identifierData.card_last4 = account.last4;
            identifierData.card_network = account.card_network;
          }

          const { error: idError } = await supabase
            .from('account_identifiers')
            .insert([identifierData]);

          if (idError) throw idError;
        }
      }

      if (onSetupAccountsComplete) onSetupAccountsComplete();
    } catch (err) {
      console.error('Setup accounts failed:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const isFormValid = accounts.some(acc => 
    acc.type === 'BANK' && 
    acc.institution_name.trim() !== '' && 
    acc.last4.length === 4
  );

  return (
    <div className="setup-accounts-container">
      <div className="setup-accounts-content">
        <div className="setup-accounts-header">
          <h1>Connect Your Accounts</h1>
          <p>Let's add your primary bank accounts and credit cards to track transactions securely.</p>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {/* Dynamic List rendered Forms */}
        <div className="dynamic-forms-list">
          {accounts.map((acc) => (
            <div key={acc.id} className="account-form-card">
              <div className="card-header">
                <div className="card-title">
                  <div className="type-icon">
                    {acc.type === 'BANK' && <span>🏦</span>}
                    {acc.type === 'CREDIT_CARD' && <span>💳</span>}
                  </div>
                  <h3>
                    {acc.type === 'BANK' ? 'Bank Account' : 'Credit Card'}
                  </h3>
                </div>
                {!(acc.type === 'BANK' && accounts.filter(a => a.type === 'BANK').length <= 1) && (
                  <button className="remove-card-btn" onClick={() => removeAccountForm(acc.id)}>✕</button>
                )}
              </div>

              <div className="card-body">
                {acc.type === 'BANK' && (
                  <>
                    <div className="form-row">
                      <div className="input-group">
                        <label>Institution Name</label>
                        <input type="text" placeholder="e.g. Chase Bank" value={acc.institution_name} onChange={(e) => handleChange(acc.id, 'institution_name', e.target.value)} />
                      </div>
                      <div className="input-group">
                        <label>Last 4 Digits</label>
                        <input type="text" placeholder="e.g. 1234" value={acc.last4} onChange={(e) => handleChange(acc.id, 'last4', e.target.value)} />
                      </div>
                    </div>
                    <div className="input-group">
                      <label>IFSC Code / Routing (Optional)</label>
                      <input type="text" placeholder="e.g. HDFC0001234" value={acc.ifsc_code} onChange={(e) => handleChange(acc.id, 'ifsc_code', e.target.value)} />
                    </div>
                  </>
                )}

                {acc.type === 'CREDIT_CARD' && (
                  <>
                    <div className="form-row">
                      <div className="input-group">
                        <label>Institution Name</label>
                        <input type="text" placeholder="e.g. American Express" value={acc.institution_name} onChange={(e) => handleChange(acc.id, 'institution_name', e.target.value)} />
                      </div>
                      <div className="input-group">
                        <label>Last 4 Digits</label>
                        <input type="text" placeholder="e.g. 4321" value={acc.last4} onChange={(e) => handleChange(acc.id, 'last4', e.target.value)} />
                      </div>
                    </div>
                    <div className="input-group">
                      <label>Card Network</label>
                      <select value={acc.card_network} onChange={(e) => handleChange(acc.id, 'card_network', e.target.value)}>
                        <option value="VISA">Visa</option>
                        <option value="MASTERCARD">Mastercard</option>
                        <option value="AMEX">Amex</option>
                      </select>
                    </div>
                  </>
                )}

              </div>
            </div>
          ))}
        </div>

        {/* Action Button Adders */}
        <div className="add-buttons-grid">
          <button className="add-action-btn" onClick={() => addAccountForm('BANK')}>
            <span>+ Add Bank Account</span>
          </button>
          <button className="add-action-btn" onClick={() => addAccountForm('CREDIT_CARD')}>
            <span>+ Add Credit Card</span>
          </button>
        </div>

        <div className="setup-footer">
          <button className="finish-btn" onClick={handleFinishSetup} disabled={!isFormValid || loading}>
            {loading ? <span className="spinner"></span> : 'Finish Setup'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SetupAccounts;
