import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '../../shared/supabase';
import { useUser } from '../../context/UserContext';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import '../../styles/Analytics.css';
import { formatDate } from '../../utils/dateUtils';
import { motion } from 'framer-motion';



/**
 * Format currency value for P&L table — show as number with 2 decimal places
 */
const formatPLAmount = (amount) => {
  if (amount === undefined || amount === null || amount === 0) return '0.00';
  return Math.abs(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/**
 * Format currency value as ₹ with proper formatting
 */
const formatCurrency = (amount) => {
  if (amount === undefined || amount === null) return '₹0';
  const isNegative = amount < 0;
  return `${isNegative ? '-' : ''}₹${Math.abs(amount).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};



/**
 * Known COGS-type root account name patterns
 * Only users who selected business/farm modules will have these
 */
const COGS_KEYWORDS = [
  'cost of goods sold', 'cogs',
  'direct farming costs', 'direct material costs', 'direct cost',
];
const Analytics = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useUser();
  const initialTab = new URLSearchParams(location.search).get('tab');
  const [view, setView] = useState(initialTab === 'balance' ? 'balance' : initialTab === 'ledger' ? 'ledger' : 'pl');  // 'pl' | 'balance' | 'ledger'
  // Date Range State
  const datePopupRef = React.useRef(null);
  const downloadPopupRef = React.useRef(null);
  const exportFns = React.useRef({ pl: {}, balance: {}, ledger: {} });
  const [isDatePopupOpen, setIsDatePopupOpen] = useState(false);
  const [showDownload, setShowDownload] = useState(false);
  
  const [loading, setLoading] = useState(true);
  const [plData, setPlData] = useState(null);
  const [balanceData, setBalanceData] = useState(null);
  const [ledgerData, setLedgerData] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('ALL');
  const [bankAccounts, setBankAccounts] = useState([]);
  const [includePending, setIncludePending] = useState(false);
  const [showPLDownload, setShowPLDownload] = useState(false);
  const [showBSDownload, setShowBSDownload] = useState(false);
  const [showLedgerDownload, setShowLedgerDownload] = useState(false);
  
  const [dateRange, setDateRange] = useState({ start: '', end: '' });

  const setQuickDate = (option) => {
    const today = new Date();
    const tzoffset = today.getTimezoneOffset() * 60000;
    const toLocalISO = (d) => new Date(d - tzoffset).toISOString().split('T')[0];
    
    let start = '';
    let end = toLocalISO(today);

    if (option === '7D') {
      const d = new Date(today);
      d.setDate(today.getDate() - 7);
      start = toLocalISO(d);
    } else if (option === '30D') {
      const d = new Date(today);
      d.setDate(today.getDate() - 30);
      start = toLocalISO(d);
    } else if (option === 'THIS_MONTH') {
      const d = new Date(today.getFullYear(), today.getMonth(), 1);
      start = toLocalISO(d);
    } else if (option === 'LAST_MONTH') {
      const dStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const dEnd = new Date(today.getFullYear(), today.getMonth(), 0);
      start = toLocalISO(dStart);
      end = toLocalISO(dEnd);
    } else if (option === 'THIS_YEAR') {
      const d = new Date(today.getFullYear(), 0, 1);
      start = toLocalISO(d);
    } else if (option === 'LAST_FY') {
      const currentYear = today.getFullYear();
      let startYear = currentYear - 1;
      let endYear = currentYear;
      if (today.getMonth() < 3) { 
          startYear = currentYear - 2;
          endYear = currentYear - 1;
      }
      const dStart = new Date(startYear, 3, 1); 
      const dEnd = new Date(endYear, 2, 31); 
      start = toLocalISO(dStart);
      end = toLocalISO(dEnd);
    }
    setDateRange({ start, end });
  };

  useEffect(() => {
    if (!isDatePopupOpen) return;
    const handleClickOutside = (e) => {
      if (datePopupRef.current && !datePopupRef.current.contains(e.target)) {
        setIsDatePopupOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isDatePopupOpen]);

  useEffect(() => {
    const fetchAccounts = async () => {
      if (!user) return;
      const { data } = await supabase
        .from('accounts')
        .select('account_id, account_name')
        .eq('user_id', user.id)
        .in('account_type', ['ASSET', 'LIABILITY']);
      if (data) setBankAccounts(data);
    };
    fetchAccounts();
  }, []);

  /**
   * Fetch data based on current view and period
   */
  const fetchData = async () => {
    setLoading(true);
    try {
      if (!user) {
        setLoading(false);
        return;
      }

      const range = {
        from: dateRange.start || '2000-01-01',
        to: dateRange.end || new Date().toISOString().split('T')[0]
      };

      console.log('Analytics fetch:', { range, view });

      // Fetch entire accounts hierarchy for this user (needed by both P&L and Balance Sheet)
      const { data: allAccounts } = await supabase
        .from('accounts')
        .select('account_id, account_name, account_type, parent_account_id, balance_nature')
        .eq('user_id', user.id);

      // Build a quick lookup by account_id
      const acctMap = {};
      (allAccounts || []).forEach(a => { acctMap[a.account_id] = a; });

      // Helper: get root parent name for an account (the top-level parent with no parent)
      const getRootParentName = (accountId) => {
        let current = acctMap[accountId];
        if (!current) return null;
        while (current.parent_account_id && acctMap[current.parent_account_id]) {
          // Only walk up if parent is same type
          const parent = acctMap[current.parent_account_id];
          if (parent.account_type !== current.account_type) break;
          current = parent;
        }
        return current.account_name;
      };

      // Determine which root EXPENSE parents the user has that are COGS-type
      const userHasCogs = (allAccounts || []).some(a =>
        a.account_type === 'EXPENSE' &&
        !a.parent_account_id &&
        COGS_KEYWORDS.some(kw => a.account_name.toLowerCase().includes(kw))
      );

      const fetchPL = async () => {        // Step 2: Fetch P&L transactions
        let query = supabase
          .from('transactions')
          .select(`
            transaction_id,
            amount,
            transaction_type,
            transaction_date,
            details,
            base_account_id,
            offset_account:offset_account_id (
              account_id,
              account_name,
              account_type
            )
          `)
          .eq('user_id', user.id)
          .eq('review_status', 'APPROVED')
          .eq('posting_status', 'POSTED')
          .gte('transaction_date', range.from)
          .lte('transaction_date', range.to);

        if (selectedAccountId !== 'ALL') {
          query = query.eq('base_account_id', selectedAccountId);
        }

        const { data, error } = await query;
        if (error) throw error;

        // Step 3: Initialize groups with all COA accounts so all categories show
        const incomeGroups = {};
        const expenseGroups = {};
        const cogsGroup = {};

        (allAccounts || []).forEach(account => {
          const type = account.account_type;
          const accountName = account.account_name || '';
          const nameLower = accountName.toLowerCase();
          
          if (nameLower.includes('uncategor') || nameLower.includes('unclassifi')) return;

          if (type === 'INCOME' || type === 'EXPENSE') {
            const rootParent = getRootParentName(account.account_id) || accountName;
            if (rootParent.toLowerCase().includes('uncategor') || rootParent.toLowerCase().includes('unclassifi')) return;
            
            if (type === 'INCOME') {
              if (!incomeGroups[rootParent]) incomeGroups[rootParent] = {};
              incomeGroups[rootParent][accountName] = { amount: 0, txns: [] };
            } else if (type === 'EXPENSE') {
              const isCogs = COGS_KEYWORDS.some(kw => rootParent.toLowerCase().includes(kw));
              if (isCogs) {
                cogsGroup[accountName] = { amount: 0, txns: [] };
              } else {
                if (!expenseGroups[rootParent]) expenseGroups[rootParent] = {};
                expenseGroups[rootParent][accountName] = { amount: 0, txns: [] };
              }
            }
          }
        });

        // Add amounts from actual transactions
        (data || []).forEach((txn) => {
          if (!txn.offset_account) return;
          const accountName = txn.offset_account.account_name || '';
          const nameLower = accountName.toLowerCase();
          // Skip catch-all
          if (nameLower.includes('uncategor') || nameLower.includes('unclassifi')) return;

          const amt = txn.amount || 0;
          let type = txn.offset_account.account_type;
          const rootParent = getRootParentName(txn.offset_account.account_id) || accountName;
          
          if (rootParent.toLowerCase().includes('uncategor') || rootParent.toLowerCase().includes('unclassifi')) return;

          const baseAccount = acctMap[txn.base_account_id];
          if (baseAccount && baseAccount.account_type === 'ASSET') {
             if (txn.transaction_type === 'CREDIT') {
                 type = 'INCOME';
             } else if (txn.transaction_type === 'DEBIT') {
                 type = 'EXPENSE';
             }
          }

          const formattedTxn = {
             uncategorized_transaction_id: txn.transaction_id,
             txn_date: txn.transaction_date,
             details: txn.details,
             debit: txn.transaction_type === 'DEBIT' ? amt : 0,
             credit: txn.transaction_type === 'CREDIT' ? amt : 0
          };

          if (type === 'INCOME') {
            if (!incomeGroups[rootParent]) incomeGroups[rootParent] = {};
            if (!incomeGroups[rootParent][accountName]) incomeGroups[rootParent][accountName] = { amount: 0, txns: [] };
            incomeGroups[rootParent][accountName].amount += amt;
            incomeGroups[rootParent][accountName].txns.push(formattedTxn);
          } else if (type === 'EXPENSE') {
            // Skip CC payments — these are liability transfers, not real expenses
            const rootParentLower = rootParent.toLowerCase();
            if (
              rootParentLower.includes('credit card payment') ||
              rootParentLower.includes('cc payment') ||
              rootParentLower.includes('card payment')
            ) return;

            const isCogs = COGS_KEYWORDS.some(kw => rootParent.toLowerCase().includes(kw));
            if (isCogs) {
              if (!cogsGroup[accountName]) cogsGroup[accountName] = { amount: 0, txns: [] };
              cogsGroup[accountName].amount += amt;
              cogsGroup[accountName].txns.push(formattedTxn);
            } else {
              if (!expenseGroups[rootParent]) expenseGroups[rootParent] = {};
              if (!expenseGroups[rootParent][accountName]) expenseGroups[rootParent][accountName] = { amount: 0, txns: [] };
              expenseGroups[rootParent][accountName].amount += amt;
              expenseGroups[rootParent][accountName].txns.push(formattedTxn);
            }
          }
        });

        // If toggle is ON, also fetch raw uncategorized (pending) transactions
        if (includePending) {
          let pendingQuery = supabase
            .from('uncategorized_transactions')
            .select('debit, credit, details, txn_date, account_id, transactions!left(offset_account_id, accounts!transactions_offset_account_id_fkey(account_name, account_type))')
            .eq('user_id', user.id)
            .gte('txn_date', range.from)
            .lte('txn_date', range.to);

          if (selectedAccountId !== 'ALL') {
            pendingQuery = pendingQuery.eq('account_id', selectedAccountId);
          }

          const { data: pendingData } = await pendingQuery;

          (pendingData || []).forEach(txn => {
            const credit = parseFloat(txn.credit) || 0;
            const debit = parseFloat(txn.debit) || 0;
            const linkedTxn = txn.transactions && txn.transactions.length > 0 ? txn.transactions[0] : null;
            const offsetAcc = linkedTxn?.accounts;

            if (credit > 0) {
              const catName = (offsetAcc?.account_type === 'INCOME') ? offsetAcc.account_name : 'Pending Income';
              if (!incomeGroups['Pending']) incomeGroups['Pending'] = {};
              if (!incomeGroups['Pending'][catName]) incomeGroups['Pending'][catName] = { amount: 0, txns: [] };
              incomeGroups['Pending'][catName].amount += credit;
              incomeGroups['Pending'][catName].txns.push(txn);
            }
            if (debit > 0) {
              const catName = (offsetAcc?.account_type === 'EXPENSE') ? offsetAcc.account_name : 'Pending Expense';
              if (!expenseGroups['Pending']) expenseGroups['Pending'] = {};
              if (!expenseGroups['Pending'][catName]) expenseGroups['Pending'][catName] = { amount: 0, txns: [] };
              expenseGroups['Pending'][catName].amount += debit;
              expenseGroups['Pending'][catName].txns.push(txn);
            }
          });
        }

        // Step 4: Compute totals
        const toSorted = (obj) =>
          Object.entries(obj)
            .map(([name, data]) => ({ name, amount: data.amount, txns: data.txns }))
            .sort((a, b) => b.amount - a.amount);
        const sumGroup = (obj) => Object.values(obj).reduce((s, v) => s + v.amount, 0);

        const incomeGroupsArray = Object.entries(incomeGroups)
          .map(([groupName, items]) => ({
            groupName,
            items: toSorted(items),
            total: sumGroup(items)
          }))
          .sort((a, b) => b.total - a.total);

        const expenseGroupsArray = Object.entries(expenseGroups)
          .map(([groupName, items]) => ({
            groupName,
            items: toSorted(items),
            total: sumGroup(items)
          }))
          .sort((a, b) => b.total - a.total);

        const cogsItems = toSorted(cogsGroup);
        const totalCogs = sumGroup(cogsGroup);

        const totalIncome = incomeGroupsArray.reduce((s, g) => s + g.total, 0);
        const totalExpense = expenseGroupsArray.reduce((s, g) => s + g.total, 0);
        
        const grossProfit = totalIncome - totalCogs;
        const netPL = userHasCogs 
          ? grossProfit - totalExpense 
          : totalIncome - totalExpense;

        setPlData({
          incomeGroups: incomeGroupsArray,
          expenseGroups: expenseGroupsArray,
          cogsItems,
          totalIncome,
          totalCogs,
          grossProfit,
          totalExpense,
          netPL,
          hasCogs: userHasCogs || totalCogs > 0,
          isPending: includePending,
          dateRange: range,
        });
      };

      const fetchBalance = async () => {
        // Fetch Balance Sheet data
        let bsQuery = supabase
          .from('journal_entries')
          .select(`
            debit_amount,
            credit_amount,
            account:account_id (
              account_id,
              account_name,
              account_type,
              balance_nature,
              parent_account:parent_account_id (
                account_name
              )
            )
          `)
          .eq('user_id', user.id)
          .lte('entry_date', range.to);

        if (selectedAccountId !== 'ALL') {
          bsQuery = bsQuery.eq('account_id', selectedAccountId);
        }

        const { data, error } = await bsQuery;

        console.log('Balance Sheet Query:', { user_id: user.id, range, data, error });
        if (error) throw error;

        // Compute balances from ledger entries
        const accountMap = {};
        
        // Initialize all Balance Sheet accounts from COA so all categories show
        (allAccounts || []).forEach(account => {
          if (['ASSET', 'LIABILITY', 'EQUITY'].includes(account.account_type)) {
            const parent = allAccounts.find(a => a.account_id === account.parent_account_id);
            accountMap[account.account_id] = {
              account_id: account.account_id,
              account_name: account.account_name,
              account_type: account.account_type,
              balance_nature: account.balance_nature,
              parent_name: parent ? parent.account_name : (account.account_type === 'ASSET' ? 'Other Assets' : (account.account_type === 'LIABILITY' ? 'Other Liabilities' : 'Equities')),
              totalDebit: 0,
              totalCredit: 0
            };
          }
        });

        (data || []).forEach(entry => {
          if (!entry.account) return;
          const { account_id, account_type } = entry.account;
          if (!['ASSET', 'LIABILITY', 'EQUITY'].includes(account_type)) return;

          // If somehow the account wasn't in our initial map (e.g., deleted from COA but exists in ledger), we gracefully add it
          if (!accountMap[account_id]) {
            const { account_name, balance_nature, parent_account } = entry.account;
            accountMap[account_id] = {
              account_id,
              account_name,
              account_type,
              balance_nature,
              parent_name: parent_account ? parent_account.account_name : (account_type === 'ASSET' ? 'Other Assets' : (account_type === 'LIABILITY' ? 'Other Liabilities' : 'Equities')),
              totalDebit: 0,
              totalCredit: 0
            };
          }
          accountMap[account_id].totalDebit += entry.debit_amount || 0;
          accountMap[account_id].totalCredit += entry.credit_amount || 0;
        });

        const accounts = Object.values(accountMap).map(acc => {
          let balance = 0;
          if (acc.account_type === 'ASSET') {
            balance = acc.totalDebit - acc.totalCredit;
          } else if (acc.account_type === 'LIABILITY') {
            balance = acc.totalCredit - acc.totalDebit;
          } else {
             // Equity
            balance = acc.totalCredit - acc.totalDebit;
          }
          return { ...acc, balance };
        });

        const assetsGroups = {};
        const liabilitiesEquitiesGroups = {};

        accounts.forEach(a => {
            const groupName = a.parent_name;
            if (a.account_type === 'ASSET') {
               if(!assetsGroups[groupName]) assetsGroups[groupName] = [];
               assetsGroups[groupName].push({ name: a.account_name, amount: a.balance });
            } else {
               if(!liabilitiesEquitiesGroups[groupName]) liabilitiesEquitiesGroups[groupName] = [];
               liabilitiesEquitiesGroups[groupName].push({ name: a.account_name, amount: a.balance });
            }
        });

        const toSortedSummary = (groupObj) => {
            return Object.entries(groupObj).map(([groupName, items]) => {
                const total = items.reduce((s, i) => s + i.amount, 0);
                return { groupName, items: items.sort((a,b) => b.amount - a.amount), total };
            }).sort((a,b) => b.total - a.total);
        }

        const assetsArr = toSortedSummary(assetsGroups);
        const liabEqArr = toSortedSummary(liabilitiesEquitiesGroups);

        const totalAssets = assetsArr.reduce((s, g) => s + g.total, 0);
        const totalLiabilitiesEquities = liabEqArr.reduce((s, g) => s + g.total, 0);

        setBalanceData({ 
            assetsGroups: assetsArr, 
            liabilitiesEquitiesGroups: liabEqArr, 
            totalAssets, 
            totalLiabilitiesEquities,
            dateRange: range
        });
      };

      const fetchLedger = async () => {
        // Fetch Ledger data
        const { data, error } = await supabase
          .from('journal_entries')
          .select(`
            journal_entry_id,
            debit_amount,
            credit_amount,
            entry_date,
            account:account_id (
              account_name,
              account_type
            ),
            transaction:transaction_id (
              details,
              transaction_id
            )
          `)
          .eq('user_id', user.id)
          .gte('entry_date', range.from)
          .lte('entry_date', range.to)
          .order('entry_date', { ascending: false })
          .order('transaction_id', { ascending: false });

        console.log('Ledger Query:', { user_id: user.id, range, data, error });
        if (error) throw error;

        setLedgerData(data || []);
      };

      await Promise.all([fetchPL(), fetchBalance(), fetchLedger()]);
    } catch (err) {
      console.error('Error fetching analytics data:', err);
      setPlData(null);
      setBalanceData(null);
      setLedgerData([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [dateRange, selectedAccountId, includePending]);

  const handleItemClick = (item) => {
    if (item.amount !== 0 && item.txns && item.txns.length > 0) {
      navigate('/category/' + encodeURIComponent(item.name), { state: { txns: item.txns, backTo: '/analytics' } });
    }
  };

  /**
   * Render P&L View — Zoho Books style table format
   */
  const renderPLView = () => {
    if (loading) {
      return (
        <div className="placeholder-rows" style={{ justifyContent: 'center' }}>
          <div className="empty-state">
            <div className="spinner"></div>
            <p>Loading P&L data...</p>
          </div>
        </div>
      );
    }

    if (!plData) {
      return (
        <div className="placeholder-rows" style={{ justifyContent: 'center' }}>
          <div className="empty-state">
            <div className="empty-icon">📊</div>
            <p>No data available</p>
          </div>
        </div>
      );
    }

    const {
      incomeGroups, expenseGroups,
      cogsItems, hasCogs,
      totalIncome, totalCogs, grossProfit, totalExpense,
      netPL, isPending, dateRange
    } = plData;

    // Format date range for header
    const fmtDate = (d) => formatDate(d);

    const exportPLToCSV = () => {
      const rows = [];
      const escape = (str) => `"${String(str).replace(/"/g, '""')}"`;
      
      // Title and Meta
      rows.push(['Profit and Loss'].map(escape).join(','));
      rows.push([`From ${dateRange ? fmtDate(dateRange.from) : ''} To ${dateRange ? fmtDate(dateRange.to) : ''}`].map(escape).join(','));
      rows.push('');
      
      // Header
      rows.push(['ACCOUNT', 'TOTAL'].map(escape).join(','));
      
      // Income Groups
      incomeGroups.forEach(group => {
        rows.push([group.groupName, ''].map(escape).join(','));
        group.items.forEach(item => {
          rows.push([`  ${item.name}`, item.amount].map(escape).join(','));
        });
        rows.push([`Total for ${group.groupName}`, group.total].map(escape).join(','));
        rows.push('');
      });
      
      rows.push(['Total Income', totalIncome].map(escape).join(','));
      rows.push('');
      
      // COGS
      if (hasCogs) {
        rows.push(['Cost of Goods Sold', ''].map(escape).join(','));
        cogsItems.forEach(item => {
          rows.push([`  ${item.name}`, item.amount].map(escape).join(','));
        });
        rows.push(['Total for Cost of Goods Sold', totalCogs].map(escape).join(','));
        rows.push('');
        rows.push(['Gross Profit', grossProfit].map(escape).join(','));
        rows.push('');
      }
      
      // Expense Groups
      expenseGroups.forEach(group => {
        rows.push([group.groupName, ''].map(escape).join(','));
        group.items.forEach(item => {
          rows.push([`  ${item.name}`, item.amount].map(escape).join(','));
        });
        rows.push([`Total for ${group.groupName}`, group.total].map(escape).join(','));
        rows.push('');
      });
      
      rows.push(['Total Expenses', totalExpense].map(escape).join(','));
      rows.push('');
      rows.push(['Net Profit/Loss', netPL].map(escape).join(','));

      const csvContent = "data:text/csv;charset=utf-8," + rows.join('\n');
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `Profit_and_Loss_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    const exportPLToPDF = () => {
      const doc = new jsPDF();
      const title = "Profit and Loss";
      const meta = `From ${dateRange ? fmtDate(dateRange.from) : ''} To ${dateRange ? fmtDate(dateRange.to) : ''}`;
      
      doc.setFontSize(20);
      doc.text(title, 14, 22);
      doc.setFontSize(10);
      doc.setTextColor(100);
      doc.text(meta, 14, 30);
      doc.text("Basis: Accrual", 14, 35);

      const tableRows = [];
      
      // Income
      incomeGroups.forEach(group => {
        tableRows.push([{ content: group.groupName, styles: { fontStyle: 'bold', fillColor: [240, 240, 240] } }, '']);
        group.items.forEach(item => {
          tableRows.push([`    ${item.name}`, formatPLAmount(item.amount)]);
        });
        tableRows.push([{ content: `Total for ${group.groupName}`, styles: { fontStyle: 'bold' } }, { content: formatPLAmount(group.total), styles: { fontStyle: 'bold' } }]);
      });
      
      tableRows.push([{ content: 'Total Income', styles: { fontStyle: 'bold', fillColor: [230, 230, 230] } }, { content: formatPLAmount(totalIncome), styles: { fontStyle: 'bold', fillColor: [230, 230, 230] } }]);
      tableRows.push(['', '']);

      // COGS
      if (hasCogs) {
        tableRows.push([{ content: 'Cost of Goods Sold', styles: { fontStyle: 'bold', fillColor: [240, 240, 240] } }, '']);
        cogsItems.forEach(item => {
          tableRows.push([`    ${item.name}`, formatPLAmount(item.amount)]);
        });
        tableRows.push([{ content: 'Total Cost of Goods Sold', styles: { fontStyle: 'bold' } }, { content: formatPLAmount(totalCogs), styles: { fontStyle: 'bold' } }]);
        tableRows.push([{ content: 'Gross Profit', styles: { fontStyle: 'bold', fillColor: [230, 230, 230] } }, { content: formatPLAmount(grossProfit), styles: { fontStyle: 'bold', fillColor: [230, 230, 230] } }]);
        tableRows.push(['', '']);
      }

      // Expenses
      expenseGroups.forEach(group => {
        tableRows.push([{ content: group.groupName, styles: { fontStyle: 'bold', fillColor: [240, 240, 240] } }, '']);
        group.items.forEach(item => {
          tableRows.push([`    ${item.name}`, formatPLAmount(item.amount)]);
        });
        tableRows.push([{ content: `Total for ${group.groupName}`, styles: { fontStyle: 'bold' } }, { content: formatPLAmount(group.total), styles: { fontStyle: 'bold' } }]);
      });

      tableRows.push([{ content: 'Total Expenses', styles: { fontStyle: 'bold', fillColor: [230, 230, 230] } }, { content: formatPLAmount(totalExpense), styles: { fontStyle: 'bold', fillColor: [230, 230, 230] } }]);
      tableRows.push(['', '']);
      
      // Net Profit
      tableRows.push([{ content: 'Net Profit/Loss', styles: { fontStyle: 'bold', fillColor: [200, 200, 200], fontSize: 12 } }, { content: formatPLAmount(netPL), styles: { fontStyle: 'bold', fillColor: [200, 200, 200], fontSize: 12 } }]);

      autoTable(doc, {
        startY: 45,
        head: [['ACCOUNT', 'TOTAL']],
        body: tableRows,
        theme: 'plain',
        headStyles: { fillColor: [59, 130, 246], textColor: [255, 255, 255] },
        styles: { fontSize: 9, cellPadding: 3 },
      });

      exportFns.current.pl.pdf = exportPLToPDF;
      exportFns.current.pl.csv = exportPLToCSV;

      doc.save(`Profit_and_Loss_${new Date().toISOString().split('T')[0]}.pdf`);
    };

    return (
      <div className="pl-report-container">


        {/* P&L Table */}
        <div className="pl-table">
          {/* Table Header */}
          <div className="pl-table-header">
            <div className="pl-col-account">ACCOUNT</div>
            <div className="pl-col-total">TOTAL</div>
          </div>

          {/* Dynamic Income Sections */}
          {incomeGroups.map((group, gIdx) => (
            <React.Fragment key={`inc-group-${gIdx}`}>
              <div className="pl-section-heading">{group.groupName}</div>
              {group.items.map((item, idx) => (
                <div key={`inc-item-${gIdx}-${idx}`} className="pl-row" onClick={() => handleItemClick(item)} style={{ cursor: item.amount !== 0 && item.txns?.length > 0 ? 'pointer' : 'default' }}>
                  <div className="pl-col-account pl-indent" style={item.amount !== 0 && item.txns?.length > 0 ? { color: 'var(--primary-action)', textDecoration: 'underline' } : {}}>{item.name}</div>
                  <div className="pl-col-total">{formatPLAmount(item.amount)}</div>
                </div>
              ))}
              <div className="pl-row pl-row-subtotal">
                <div className="pl-col-account"><strong>Total for {group.groupName}</strong></div>
                <div className="pl-col-total"><strong>{formatPLAmount(group.total)}</strong></div>
              </div>
            </React.Fragment>
          ))}

          {incomeGroups.length === 0 && (
            <>
               <div className="pl-section-heading">Income</div>
               <div className="pl-row pl-row-empty">
                 <div className="pl-col-account pl-indent pl-text-muted">—</div>
                 <div className="pl-col-total pl-text-muted">—</div>
               </div>
            </>
          )}

          <div className="pl-row pl-row-highlight" style={{ backgroundColor: 'var(--bg-card)', borderBottom: '2px solid var(--border-color)', borderTop: 'none' }}>
            <div className="pl-col-account"><strong>Total Income</strong></div>
            <div className="pl-col-total"><strong>{formatPLAmount(totalIncome)}</strong></div>
          </div>

          {/* Conditionally Render COGS and Gross Profit */}
          {hasCogs && (
            <>
              <div className="pl-section-heading">Cost of Goods Sold</div>
              {cogsItems.length === 0 ? (
                <div className="pl-row pl-row-empty">
                  <div className="pl-col-account pl-indent pl-text-muted">—</div>
                  <div className="pl-col-total pl-text-muted">—</div>
                </div>
              ) : (
                cogsItems.map((item, idx) => (
                  <div key={`cogs-${idx}`} className="pl-row" onClick={() => handleItemClick(item)} style={{ cursor: item.amount !== 0 && item.txns?.length > 0 ? 'pointer' : 'default' }}>
                    <div className="pl-col-account pl-indent" style={item.amount !== 0 && item.txns?.length > 0 ? { color: 'var(--primary-action)', textDecoration: 'underline' } : {}}>{item.name}</div>
                    <div className="pl-col-total">{formatPLAmount(item.amount)}</div>
                  </div>
                ))
              )}
              <div className="pl-row pl-row-subtotal">
                <div className="pl-col-account"><strong>Total for Cost of Goods Sold</strong></div>
                <div className="pl-col-total"><strong>{formatPLAmount(totalCogs)}</strong></div>
              </div>

              {/* Gross Profit */}
              <div className="pl-row pl-row-highlight" style={{ backgroundColor: 'var(--bg-card)', borderBottom: '2px solid var(--border-color)', borderTop: 'none' }}>
                <div className="pl-col-account"><strong>Gross Profit</strong></div>
                <div className="pl-col-total"><strong>{formatPLAmount(grossProfit)}</strong></div>
              </div>
            </>
          )}

          {/* Dynamic Expense Sections */}
          {expenseGroups.map((group, gIdx) => (
             <React.Fragment key={`exp-group-${gIdx}`}>
               <div className="pl-section-heading">{group.groupName}</div>
               {group.items.map((item, idx) => (
                 <div key={`exp-item-${gIdx}-${idx}`} className="pl-row" onClick={() => handleItemClick(item)} style={{ cursor: item.amount !== 0 && item.txns?.length > 0 ? 'pointer' : 'default' }}>
                   <div className="pl-col-account pl-indent" style={item.amount !== 0 && item.txns?.length > 0 ? { color: 'var(--primary-action)', textDecoration: 'underline' } : {}}>{item.name}</div>
                   <div className="pl-col-total">{formatPLAmount(item.amount)}</div>
                 </div>
               ))}
               <div className="pl-row pl-row-subtotal">
                 <div className="pl-col-account"><strong>Total for {group.groupName}</strong></div>
                 <div className="pl-col-total"><strong>{formatPLAmount(group.total)}</strong></div>
               </div>
             </React.Fragment>
          ))}

          {expenseGroups.length === 0 && (
            <>
              <div className="pl-section-heading">Expenses</div>
              <div className="pl-row pl-row-empty">
                <div className="pl-col-account pl-indent pl-text-muted">—</div>
                <div className="pl-col-total pl-text-muted">—</div>
              </div>
            </>
          )}

          <div className="pl-row pl-row-highlight" style={{ backgroundColor: 'var(--bg-card)', borderBottom: '2px solid var(--border-color)', borderTop: 'none' }}>
            <div className="pl-col-account"><strong>Total Expenses</strong></div>
            <div className="pl-col-total"><strong>{formatPLAmount(totalExpense)}</strong></div>
          </div>

          {/* Net Profit/Loss */}
          <div className="pl-row pl-row-net" style={{ marginTop: '15px' }}>
            <div className="pl-col-account"><strong>Net Profit/Loss</strong></div>
            <div className={`pl-col-total pl-net-value ${netPL >= 0 ? 'pl-positive' : 'pl-negative'}`}>
              <strong>
                {netPL < 0 ? '-' : ''}₹{Math.abs(netPL).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </strong>
            </div>
          </div>
        </div>

        {/* Currency Note */}
        <div className="pl-currency-note">
          **Amount is displayed in your base currency <span className="pl-currency-badge">INR</span>
        </div>
      </div>
    );
  };

  /**
   * Render Balance Sheet View
   */
  const renderBalanceView = () => {
    if (loading) {
      return (
        <div className="placeholder-rows" style={{ justifyContent: 'center' }}>
          <div className="empty-state">
            <div className="spinner"></div>
            <p>Loading balance sheet data...</p>
          </div>
        </div>
      );
    }

    if (!balanceData) {
      return (
        <div className="placeholder-rows" style={{ justifyContent: 'center' }}>
          <div className="empty-state">
            <div className="empty-icon">📊</div>
            <p>No data available</p>
          </div>
        </div>
      );
    }

    const { assetsGroups, liabilitiesEquitiesGroups, totalAssets, totalLiabilitiesEquities, dateRange } = balanceData;

    const fmtDate = (d) => formatDate(d);

    const exportBalanceToCSV = () => {
      const rows = [];
      const escape = (str) => `"${String(str).replace(/"/g, '""')}"`;
      
      rows.push(['Balance Sheet'].map(escape).join(','));
      rows.push([`As of ${dateRange ? fmtDate(dateRange.to) : ''}`].map(escape).join(','));
      rows.push('');
      rows.push(['ACCOUNT', 'TOTAL'].map(escape).join(','));
      
      rows.push(['Assets', ''].map(escape).join(','));
      assetsGroups.forEach(group => {
        rows.push([group.groupName, ''].map(escape).join(','));
        group.items.forEach(item => {
          rows.push([`  ${item.name}`, item.amount].map(escape).join(','));
        });
        rows.push([`Total for ${group.groupName}`, group.total].map(escape).join(','));
        rows.push('');
      });
      rows.push(['Total for Assets', totalAssets].map(escape).join(','));
      rows.push('');
      
      rows.push(['Liabilities & Equities', ''].map(escape).join(','));
      liabilitiesEquitiesGroups.forEach(group => {
        rows.push([group.groupName, ''].map(escape).join(','));
        group.items.forEach(item => {
          rows.push([`  ${item.name}`, item.amount].map(escape).join(','));
        });
        rows.push([`Total for ${group.groupName}`, group.total].map(escape).join(','));
        rows.push('');
      });
      rows.push(['Total for Liabilities & Equities', totalLiabilitiesEquities].map(escape).join(','));

      const csvContent = "data:text/csv;charset=utf-8," + rows.join('\n');
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `Balance_Sheet_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    const exportBalanceToPDF = () => {
      const doc = new jsPDF();
      const title = "Balance Sheet";
      const meta = `As of ${dateRange ? fmtDate(dateRange.to) : ''}`;
      
      doc.setFontSize(20);
      doc.text(title, 14, 22);
      doc.setFontSize(10);
      doc.setTextColor(100);
      doc.text(meta, 14, 30);
      doc.text("Basis: Accrual", 14, 35);

      const tableRows = [];
      
      // Assets
      tableRows.push([{ content: 'Assets', styles: { fontStyle: 'bold', fillColor: [59, 130, 246], textColor: [255, 255, 255] } }, '']);
      assetsGroups.forEach(group => {
        tableRows.push([{ content: group.groupName, styles: { fontStyle: 'bold', fillColor: [240, 240, 240] } }, '']);
        group.items.forEach(item => {
          tableRows.push([`    ${item.name}`, formatPLAmount(item.amount)]);
        });
        tableRows.push([{ content: `Total for ${group.groupName}`, styles: { fontStyle: 'bold' } }, { content: formatPLAmount(group.total), styles: { fontStyle: 'bold' } }]);
      });
      tableRows.push([{ content: 'Total Assets', styles: { fontStyle: 'bold', fillColor: [230, 230, 230] } }, { content: formatPLAmount(totalAssets), styles: { fontStyle: 'bold', fillColor: [230, 230, 230] } }]);
      tableRows.push(['', '']);

      // Liabilities
      tableRows.push([{ content: 'Liabilities & Equities', styles: { fontStyle: 'bold', fillColor: [59, 130, 246], textColor: [255, 255, 255] } }, '']);
      liabilitiesEquitiesGroups.forEach(group => {
        tableRows.push([{ content: group.groupName, styles: { fontStyle: 'bold', fillColor: [240, 240, 240] } }, '']);
        group.items.forEach(item => {
          tableRows.push([`    ${item.name}`, formatPLAmount(item.amount)]);
        });
        tableRows.push([{ content: `Total for ${group.groupName}`, styles: { fontStyle: 'bold' } }, { content: formatPLAmount(group.total), styles: { fontStyle: 'bold' } }]);
      });
      tableRows.push([{ content: 'Total Liabilities & Equities', styles: { fontStyle: 'bold', fillColor: [230, 230, 230] } }, { content: formatPLAmount(totalLiabilitiesEquities), styles: { fontStyle: 'bold', fillColor: [230, 230, 230] } }]);

      autoTable(doc, {
        startY: 45,
        head: [['ACCOUNT', 'TOTAL']],
        body: tableRows,
        theme: 'plain',
        headStyles: { fillColor: [59, 130, 246], textColor: [255, 255, 255] },
        styles: { fontSize: 9, cellPadding: 3 },
      });

      exportFns.current.balance.pdf = exportBalanceToPDF;
      exportFns.current.balance.csv = exportBalanceToCSV;

      doc.save(`Balance_Sheet_${new Date().toISOString().split('T')[0]}.pdf`);
    };

    return (
      <div className="pl-report-container">


        {/* Balance Sheet Table */}
        <div className="pl-table">
          {/* Table Header */}
          <div className="pl-table-header">
            <div className="pl-col-account">ACCOUNT</div>
            <div className="pl-col-total">TOTAL</div>
          </div>

          <div className="pl-section-heading" style={{ fontSize:'15px', fontWeight:'700', padding:'12px 16px', background:'var(--bg-primary)' }}>Assets</div>
          
          {assetsGroups.map((group, gIdx) => (
             <React.Fragment key={`ast-grp-${gIdx}`}>
               <div className="pl-section-heading" style={{ paddingLeft: '24px', background:'transparent', borderTop: 'none', borderBottom: 'none' }}>{group.groupName}</div>
               {group.items.map((item, idx) => (
                 <div key={`ast-item-${gIdx}-${idx}`} className="pl-row">
                   <div className="pl-col-account pl-indent" style={{ paddingLeft: '48px' }}>{item.name}</div>
                   <div className="pl-col-total">{formatPLAmount(item.amount)}</div>
                 </div>
               ))}
               <div className="pl-row pl-row-subtotal">
                 <div className="pl-col-account" style={{ paddingLeft: '24px' }}><strong>Total for {group.groupName}</strong></div>
                 <div className="pl-col-total"><strong>{formatPLAmount(group.total)}</strong></div>
               </div>
             </React.Fragment>
          ))}
          
          <div className="pl-row pl-row-highlight" style={{ backgroundColor: 'var(--bg-card)', borderBottom: '2px solid var(--border-color)', borderTop: 'none' }}>
            <div className="pl-col-account"><strong>Total for Assets</strong></div>
            <div className="pl-col-total"><strong>{formatPLAmount(totalAssets)}</strong></div>
          </div>

          <div className="pl-section-heading" style={{ fontSize:'15px', fontWeight:'700', padding:'12px 16px', background:'var(--bg-primary)' }}>Liabilities & Equities</div>
          
          {liabilitiesEquitiesGroups.map((group, gIdx) => (
             <React.Fragment key={`leq-grp-${gIdx}`}>
               <div className="pl-section-heading" style={{ paddingLeft: '24px', background:'transparent', borderTop: 'none', borderBottom: 'none' }}>{group.groupName}</div>
               {group.items.map((item, idx) => (
                 <div key={`leq-item-${gIdx}-${idx}`} className="pl-row">
                   <div className="pl-col-account pl-indent" style={{ paddingLeft: '48px' }}>{item.name}</div>
                   <div className="pl-col-total">{formatPLAmount(item.amount)}</div>
                 </div>
               ))}
               <div className="pl-row pl-row-subtotal">
                 <div className="pl-col-account" style={{ paddingLeft: '24px' }}><strong>Total for {group.groupName}</strong></div>
                 <div className="pl-col-total"><strong>{formatPLAmount(group.total)}</strong></div>
               </div>
             </React.Fragment>
          ))}
          
          <div className="pl-row pl-row-highlight" style={{ backgroundColor: 'var(--bg-card)', borderBottom: '2px solid var(--border-color)', borderTop: 'none' }}>
            <div className="pl-col-account"><strong>Total for Liabilities & Equities</strong></div>
            <div className="pl-col-total"><strong>{formatPLAmount(totalLiabilitiesEquities)}</strong></div>
          </div>

        </div>

        {/* Currency Note */}
        <div className="pl-currency-note">
          **Amount is displayed in your base currency <span className="pl-currency-badge">INR</span>
        </div>
      </div>
    );
  };

  /**
   * Render Ledger View — Color-coded, grouped double-entry ledger
   */
  const renderLedgerView = () => {
    if (loading) {
      return (
        <div className="placeholder-rows" style={{ justifyContent: 'center' }}>
          <div className="empty-state">
            <div className="spinner"></div>
            <p>Loading ledger data...</p>
          </div>
        </div>
      );
    }

    if (ledgerData.length === 0) {
      return (
        <div className="placeholder-rows" style={{ justifyContent: 'center' }}>
          <div className="empty-state">
            <div className="empty-icon">📖</div>
            <p>No ledger entries for this period</p>
          </div>
        </div>
      );
    }

    // Group entries by transaction_id into transaction pairs
    const groups = [];
    let i = 0;
    while (i < ledgerData.length) {
      const current = ledgerData[i];
      const next = ledgerData[i + 1];
      const sameTransaction = next && next.transaction?.transaction_id === current.transaction?.transaction_id;
      if (sameTransaction) {
        groups.push([current, next]);
        i += 2;
      } else {
        groups.push([current]);
        i += 1;
      }
    }

    const acctTypeColor = (type) => {
      if (type === 'INCOME')    return { bg: 'rgba(16,185,129,0.12)', color: '#059669' };
      if (type === 'EXPENSE')   return { bg: 'rgba(239,68,68,0.12)',  color: '#dc2626' };
      if (type === 'ASSET')     return { bg: 'rgba(59,130,246,0.12)', color: '#2563eb' };
      if (type === 'LIABILITY') return { bg: 'rgba(245,158,11,0.12)', color: '#d97706' };
      return { bg: 'rgba(156,163,175,0.12)', color: '#6b7280' };
    };

    const exportLedgerToCSV = () => {
      const rows = [['DATE', 'DESCRIPTION', 'ACCOUNT', 'TYPE', 'DEBIT', 'CREDIT']];
      ledgerData.forEach(entry => {
        rows.push([
          entry.entry_date,
          entry.transaction?.details || '',
          entry.account?.account_name || '',
          entry.account?.account_type || '',
          entry.debit_amount || 0,
          entry.credit_amount || 0
        ]);
      });
      const csvContent = "data:text/csv;charset=utf-8," + rows.map(r => r.join(',')).join('\n');
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `Journal_Entries_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    const exportLedgerToPDF = () => {
      const doc = new jsPDF();
      doc.setFontSize(20);
      doc.text("Journal Entries", 14, 22);
      
      const tableRows = [];
      ledgerData.forEach(entry => {
        tableRows.push([
          formatDate(entry.entry_date),
          entry.transaction?.details || '',
          entry.account?.account_name || '',
          entry.debit_amount > 0 ? formatCurrency(entry.debit_amount) : '',
          entry.credit_amount > 0 ? formatCurrency(entry.credit_amount) : ''
        ]);
      });

      autoTable(doc, {
        startY: 30,
        head: [['DATE', 'DESCRIPTION', 'ACCOUNT', 'DEBIT', 'CREDIT']],
        body: tableRows,
        theme: 'striped',
        headStyles: { fillColor: [59, 130, 246] },
        styles: { fontSize: 8 },
      });

      exportFns.current.ledger.pdf = exportLedgerToPDF;
      exportFns.current.ledger.csv = exportLedgerToCSV;

      doc.save(`Journal_Entries_${new Date().toISOString().split('T')[0]}.pdf`);
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {/* Header */}
        <div style={{
          display: 'grid', gridTemplateColumns: '110px 1fr 160px 120px 120px',
          padding: '8px 16px', borderRadius: '8px',
          background: 'var(--bg-secondary)',
          fontSize: '11px', fontWeight: '700', letterSpacing: '0.08em',
          color: 'var(--text-secondary)', textTransform: 'uppercase'
        }}>
          <div>Date</div>
          <div>Description</div>
          <div>Account</div>
          <div style={{ textAlign: 'right' }}>Debit</div>
          <div style={{ textAlign: 'right' }}>Credit</div>
        </div>

        {groups.map((group, gIdx) => {
          const firstEntry = group[0];
          const txnDate = formatDate(firstEntry.entry_date);
          const txnDesc = firstEntry.transaction?.details || '—';
          const isEven = gIdx % 2 === 0;

          return (
            <div key={gIdx} style={{
              borderRadius: '10px',
              border: '1px solid var(--border-color)',
              background: isEven ? 'var(--bg-card)' : 'var(--bg-secondary)',
              overflow: 'hidden',
              borderLeft: `3px solid ${firstEntry.debit_amount > 0 ? '#ef4444' : '#10b981'}`
            }}>
              {group.map((entry, eIdx) => {
                const isDebit  = entry.debit_amount  > 0;
                const isCredit = entry.credit_amount > 0;
                const accType  = entry.account?.account_type;
                const badge    = acctTypeColor(accType);

                return (
                  <div key={entry.journal_entry_id} style={{
                    display: 'grid',
                    gridTemplateColumns: '110px 1fr 160px 120px 120px',
                    padding: '11px 16px',
                    alignItems: 'center',
                    borderTop: eIdx > 0 ? '1px dashed var(--border-color)' : 'none',
                    fontSize: '13px',
                  }}>
                    {/* Date — only first row shows it */}
                    <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                      {eIdx === 0 ? txnDate : ''}
                    </div>

                    {/* Description — only first row shows it */}
                    <div style={{
                      fontWeight: eIdx === 0 ? '500' : '400',
                      color: eIdx === 0 ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontSize: '13px', paddingRight: '8px',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                    }}>
                      {eIdx === 0 ? txnDesc : (
                        <span style={{ fontSize: '11px', fontStyle: 'italic', color: 'var(--text-secondary)' }}>
                          offset entry
                        </span>
                      )}
                    </div>

                    {/* Account name + type badge */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
                        {entry.account?.account_name || '—'}
                      </span>
                      {accType && (
                        <span style={{
                          fontSize: '9px', fontWeight: '700', letterSpacing: '0.05em',
                          padding: '1px 5px', borderRadius: '4px',
                          background: badge.bg, color: badge.color
                        }}>
                          {accType}
                        </span>
                      )}
                    </div>

                    {/* Debit */}
                    <div style={{
                      textAlign: 'right', fontWeight: '600',
                      color: isDebit ? '#ef4444' : 'var(--text-secondary)',
                      fontSize: isDebit ? '13px' : '12px'
                    }}>
                      {isDebit ? formatCurrency(entry.debit_amount) : '—'}
                    </div>

                    {/* Credit */}
                    <div style={{
                      textAlign: 'right', fontWeight: '600',
                      color: isCredit ? '#10b981' : 'var(--text-secondary)',
                      fontSize: isCredit ? '13px' : '12px'
                    }}>
                      {isCredit ? formatCurrency(entry.credit_amount) : '—'}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  const renderPLSidebar = () => {
    if (!plData) return null;
    return (
      <>
        <div className="summary-card">
          <div className="summary-title">Total Income</div>
          <div className="summary-value positive">{formatCurrency(plData.totalIncome)}</div>
          <div className="summary-subtitle">All time</div>
        </div>
        <div className="summary-card">
          <div className="summary-title">Total Expenses</div>
          <div className="summary-value negative">{formatCurrency(Math.abs(plData.totalExpense))}</div>
        </div>
        <div className="summary-card">
          <div className="summary-title">Net Profit/Loss</div>
          <div className={`summary-value ${plData.netPL >= 0 ? 'positive' : 'negative'}`}>
            {formatCurrency(plData.netPL)}
          </div>
        </div>
        <div className="analytics-metadata">
          <span>Basis: Accrual</span>
          <span>
            {(dateRange.start || dateRange.end)
              ? `${dateRange.start ? formatDate(dateRange.start) : 'Start'} - ${dateRange.end ? formatDate(dateRange.end) : 'End'}`
              : 'All time'}
          </span>
        </div>
      </>
    );
  };

  const renderBalanceSidebar = () => {
    if (!balanceData) return null;
    return (
      <>
        <div className="summary-card">
          <div className="summary-title">Total Assets</div>
          <div className="summary-value positive">{formatCurrency(balanceData.totalAssets)}</div>
        </div>
        <div className="summary-card">
          <div className="summary-title">Total Liabilities</div>
          <div className="summary-value negative">{formatCurrency(balanceData.totalLiabilities)}</div>
        </div>
        <div className="summary-card">
          <div className="summary-title">Total Equity</div>
          <div className={`summary-value ${balanceData.netAssets >= 0 ? 'positive' : 'negative'}`}>
            {formatCurrency(balanceData.netAssets)}
          </div>
        </div>
        <div className="analytics-metadata">
          <span>Basis: Accrual</span>
          <span>
            {(dateRange.start || dateRange.end)
              ? `As of ${dateRange.end ? formatDate(dateRange.end) : formatDate(new Date())}`
              : `As of ${formatDate(new Date())}`}
          </span>
        </div>
      </>
    );
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="analytics-container">
      {/* Top Header */}
      <div className="analytics-topbar">
        <div className="segmented-control">
          <button className={`segmented-tab ${view === 'pl' ? 'active' : ''}`} onClick={() => setView('pl')}>P&L</button>
          <button className={`segmented-tab ${view === 'balance' ? 'active' : ''}`} onClick={() => setView('balance')}>Balance sheet</button>
          <button className={`segmented-tab ${view === 'ledger' ? 'active' : ''}`} onClick={() => setView('ledger')}>Journal entries</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {view === 'pl' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer', userSelect: 'none', fontSize: '13px', color: 'var(--text-secondary)' }}>
              <div
                onClick={() => setIncludePending(p => !p)}
                style={{
                  width: '36px', height: '20px', borderRadius: '10px', position: 'relative', cursor: 'pointer',
                  background: includePending ? '#f59e0b' : 'var(--border-color)',
                  transition: 'background 0.2s ease', flexShrink: 0
                }}
              >
                <div style={{
                  position: 'absolute', top: '2px',
                  left: includePending ? '18px' : '2px',
                  width: '16px', height: '16px', borderRadius: '50%',
                  background: '#fff', transition: 'left 0.2s ease',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
                }} />
              </div>
              Include pending
            </label>
          )}

          {/* Date Picker Button */}
          <div className="filter-popup-wrapper" ref={datePopupRef}>
            <button
              className={`filter-tab ${(dateRange.start || dateRange.end) ? 'filter-tab-active' : ''}`}
              onClick={() => setIsDatePopupOpen(v => !v)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              {(dateRange.start || dateRange.end) ? 'Custom Date' : 'All time'}
            </button>

            {isDatePopupOpen && (
              <div className="filter-popup" style={{ width: '280px', left: 0, right: 'auto' }}>
                <div className="filter-popup-header">
                  <span>Date Range</span>
                  {(dateRange.start || dateRange.end) && (
                    <button className="filter-clear-btn" onClick={() => { setDateRange({start: '', end: ''}); setIsDatePopupOpen(false); }}>Clear</button>
                  )}
                </div>
                
                <div className="filter-group">
                  <div className="filter-group-label" style={{ marginBottom: '8px' }}>Quick Select</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', padding: '0 12px 8px' }}>
                    <button className="filter-tab" style={{ justifyContent: 'center' }} onClick={() => setQuickDate('7D')}>Last 7 Days</button>
                    <button className="filter-tab" style={{ justifyContent: 'center' }} onClick={() => setQuickDate('30D')}>Last 30 Days</button>
                    <button className="filter-tab" style={{ justifyContent: 'center' }} onClick={() => setQuickDate('THIS_MONTH')}>This Month</button>
                    <button className="filter-tab" style={{ justifyContent: 'center' }} onClick={() => setQuickDate('LAST_MONTH')}>Last Month</button>
                    <button className="filter-tab" style={{ justifyContent: 'center' }} onClick={() => setQuickDate('THIS_YEAR')}>This Year</button>
                    <button className="filter-tab" style={{ justifyContent: 'center' }} onClick={() => setQuickDate('LAST_FY')}>Last FY</button>
                  </div>
                </div>

                <div className="filter-group">
                  <div className="filter-group-label" style={{ marginBottom: '8px' }}>Custom Range</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '0 12px 6px' }}>
                    <div>
                      <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.4px', fontWeight: 'bold' }}>Start Date</label>
                      <input 
                        type="date" 
                        className="amount-editor-input" 
                        style={{ width: '100%', boxSizing: 'border-box' }}
                        value={dateRange.start}
                        onChange={e => setDateRange(p => ({ ...p, start: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.4px', fontWeight: 'bold' }}>End Date</label>
                      <input 
                        type="date" 
                        className="amount-editor-input" 
                        style={{ width: '100%', boxSizing: 'border-box' }}
                        value={dateRange.end}
                        onChange={e => setDateRange(p => ({ ...p, end: e.target.value }))}
                      />
                    </div>
                  </div>
                </div>

                <div style={{ padding: '12px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end' }}>
                  <button 
                    className="action-btn outline-btn" 
                    onClick={() => setIsDatePopupOpen(false)}
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    Apply Filter
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Unified Download Button */}
          <div className="export-dropdown" ref={downloadPopupRef}>
            <button 
              className="action-btn outline-btn" 
              onClick={() => setShowDownload(!showDownload)}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', fontSize: '0.85rem' }}
            >
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
              Download
              <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" style={{ transform: showDownload ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"></path></svg>
            </button>
            
            {showDownload && (
              <div className="export-menu">
                <button className="export-menu-item" onClick={() => { exportFns.current[view]?.pdf?.(); setShowDownload(false); }}>
                  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                  PDF Report
                </button>
                <button className="export-menu-item" onClick={() => { exportFns.current[view]?.csv?.(); setShowDownload(false); }}>
                  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                  CSV Data
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="analytics-content">
        <div className="analytics-layout">
          {view !== 'ledger' && (
            <div className="analytics-sidebar">
              {view === 'pl' && renderPLSidebar()}
              {view === 'balance' && renderBalanceSidebar()}
              
              <div className="analytics-filter-container">
                {bankAccounts.length > 0 && (
                  <select
                    value={selectedAccountId}
                    onChange={e => setSelectedAccountId(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--glass-border)',
                      background: 'transparent',
                      color: 'var(--text-secondary)',
                      fontSize: '13px',
                      outline: 'none',
                      cursor: 'pointer'
                    }}
                  >
                    <option value="ALL">All accounts</option>
                    {bankAccounts.map(acc => (
                      <option key={acc.account_id} value={acc.account_id}>{acc.account_name}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          )}
          
          <div className={`analytics-main ${view === 'ledger' ? 'full-width' : ''}`}>
            <div style={{ display: view === 'pl' ? 'block' : 'none' }}>{renderPLView()}</div>
            <div style={{ display: view === 'balance' ? 'block' : 'none' }}>{renderBalanceView()}</div>
            <div style={{ display: view === 'ledger' ? 'block' : 'none' }}>{renderLedgerView()}</div>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export default Analytics;
