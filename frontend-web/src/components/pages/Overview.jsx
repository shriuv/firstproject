import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../shared/supabase';
import { useUser } from '../../context/UserContext';
import { useData } from '../../context/DataContext';
import { useNavigate } from 'react-router-dom';
import '../../styles/Overview.css';
import { formatDate } from '../../utils/dateUtils';
import { motion } from 'framer-motion';

const Overview = () => {
  const navigate = useNavigate();
  const user = useUser();
  const { transactions: allTxnsRaw, transactionsLoading: txnsLoading } = useData();
  const chartScrollRef = useRef(null);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const loading = txnsLoading || ledgerLoading;
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(() => {
    return sessionStorage.getItem('ledgerai_selected_account_id') || 'ALL';
  });
  const [timeframe, setTimeframe] = useState('MONTH');
  const [timeRange, setTimeRange] = useState('12M'); // 'ALL' | '30D' | '3M' | '12M'

  const handleAccountChange = (val) => {
    setSelectedAccountId(val);
    sessionStorage.setItem('ledgerai_selected_account_id', val);
  };
  const [activeBarIndex, setActiveBarIndex] = useState(null);
  const [activeDonutIndex, setActiveDonutIndex] = useState(null);
  const [breakdownModal, setBreakdownModal] = useState({ isOpen: false, type: null, data: [] });
  const [categoryTxnModal, setCategoryTxnModal] = useState({ isOpen: false, categoryName: '', txns: [] });
  const [globalLedgerMap, setGlobalLedgerMap] = useState({});
  // Ledger-based asset/liability state — computed identically to Analytics Balance Sheet
  const [assetsLedger, setAssetsLedger] = useState({ total: 0, breakdown: [] });
  const [liabilitiesLedger, setLiabilitiesLedger] = useState({ total: 0, breakdown: [] });

  const handleStatClick = (type) => {
    if (type === 'INCOME') setBreakdownModal({ isOpen: true, type: 'Income Breakdown', data: incomeBreakdown, modalType: 'INCOME' });
    else if (type === 'EXPENSE') setBreakdownModal({ isOpen: true, type: 'Expense Breakdown', data: expenseBreakdown, modalType: 'EXPENSE' });
    // Assets/Liabilities use ledger-based breakdown (matches Analytics Balance Sheet)
    else if (type === 'ASSETS') setBreakdownModal({ isOpen: true, type: 'Total Assets Breakdown', data: assetsLedger.breakdown, modalType: 'ASSETS' });
    else if (type === 'LIABILITIES') {
      // Enrich liabilities breakdown with account subtype tags
      const enriched = Object.values(globalLedgerMap)
        .filter(acc => acc.account_type === 'LIABILITY')
        .map(acc => {
          // Proper accounting perspective: Liability balance = totalCredit - totalDebit
          const balance = acc.totalCredit - acc.totalDebit;
          // Determine subtype tag based on account name
          const tag = acc.account_name.toLowerCase().includes('card') ? 'Credit Card' : 'Liability';
          return { name: acc.account_name, amount: balance, tag };
        })
        .sort((a, b) => b.amount - a.amount);
      setBreakdownModal({ isOpen: true, type: 'Total Liabilities Breakdown', data: enriched, modalType: 'LIABILITIES' });
    }
    else if (type === 'SAVINGS' || type === 'BALANCE') {
      // Per-account balance breakdown
      const perAccount = Object.values(globalLedgerMap)
        .filter(acc => acc.account_type === 'ASSET')
        .map(acc => {
          // Proper accounting perspective: Asset balance = totalDebit - totalCredit
          const balance = acc.totalDebit - acc.totalCredit;
          return { name: acc.account_name, amount: balance };
        })
        .sort((a, b) => b.amount - a.amount);
      const summaryRows = [
        { name: 'Total Income', amount: stats.income, isSummary: true },
        { name: 'Total Expenses', amount: -stats.expense, isSummary: true },
        { name: 'Net Savings', amount: stats.savings, isSummary: true, isBold: true },
      ];
      setBreakdownModal({
        isOpen: true,
        type: type === 'SAVINGS' ? 'Net Savings Breakdown' : 'Balance Breakdown',
        data: [...summaryRows, ...perAccount],
        modalType: type,
      });
    }
  };

  useEffect(() => {
    fetchLedger();
  }, []);

  // Fetch linked bank and credit card accounts for the dropdown filter
  useEffect(() => {
    const fetchFilterAccounts = async () => {
      if (!user) return;
      const { data } = await supabase
        .from('accounts')
        .select(`
          account_id,
          account_name,
          account_identifiers!inner (
            account_number_last4,
            card_last4,
            is_active
          )
        `)
        .eq('user_id', user.id)
        .eq('is_active', true);

      if (data) {
        const filtered = data.filter(acc =>
          acc.account_identifiers &&
          acc.account_identifiers.length > 0 &&
          acc.account_identifiers.some(ident =>
            ident.is_active &&
            (ident.account_number_last4 != null || ident.card_last4 != null)
          )
        ).map(acc => ({
          id: acc.account_id,
          name: acc.account_name
        }));
        setAccounts(filtered);
      }
    };
    fetchFilterAccounts();
  }, [user]);

  useEffect(() => {
    if (Object.keys(globalLedgerMap).length === 0) return;

    let totalAssetsVal = 0;
    let totalLiabilitiesVal = 0;
    const assetsBreakdownMap = {};
    const liabilitiesBreakdownMap = {};

    Object.values(globalLedgerMap).forEach(acc => {
      if (selectedAccountId !== 'ALL' && String(acc.account_id) !== String(selectedAccountId)) return;

      let balance = 0;
      if (acc.account_type === 'ASSET') {
        balance = acc.totalDebit - acc.totalCredit;
      } else if (acc.account_type === 'LIABILITY') {
        balance = acc.totalCredit - acc.totalDebit;
      } else {
        balance = acc.totalCredit - acc.totalDebit;
      }

      if (acc.account_type === 'ASSET') {
        totalAssetsVal += balance;
        if (!assetsBreakdownMap[acc.account_name]) assetsBreakdownMap[acc.account_name] = 0;
        assetsBreakdownMap[acc.account_name] += balance;
      } else if (acc.account_type === 'LIABILITY') {
        totalLiabilitiesVal += balance;
        if (!liabilitiesBreakdownMap[acc.account_name]) liabilitiesBreakdownMap[acc.account_name] = 0;
        liabilitiesBreakdownMap[acc.account_name] += balance;
      }
    });

    setAssetsLedger({
      total: totalAssetsVal,
      breakdown: Object.entries(assetsBreakdownMap)
        .map(([name, amount]) => ({ name, amount }))
        .sort((a, b) => b.amount - a.amount)
    });
    setLiabilitiesLedger({
      total: totalLiabilitiesVal,
      breakdown: Object.entries(liabilitiesBreakdownMap)
        .map(([name, amount]) => ({ name, amount }))
        .sort((a, b) => b.amount - a.amount)
    });
  }, [globalLedgerMap, selectedAccountId]);

  const fetchLedger = async () => {
    try {
      if (!user) return;

      // Fetch journal_entries for Assets & Liabilities
      // Cumulative fetch (no .gte filter) to get the actual account balances.
      const { data: ledgerEntries } = await supabase
        .from('journal_entries')
        .select(`
          debit_amount,
          credit_amount,
          account:account_id (
            account_id,
            account_name,
            account_type,
            balance_nature
          )
        `)
        .eq('user_id', user.id);

      // Accumulate debit/credit per account
      const ledgerMap = {};
      (ledgerEntries || []).forEach(entry => {
        if (!entry.account) return;
        const { account_id, account_type, account_name, balance_nature } = entry.account;
        if (!['ASSET', 'LIABILITY'].includes(account_type)) return;

        if (!ledgerMap[account_id]) {
          ledgerMap[account_id] = { account_id, account_name, account_type, balance_nature, totalDebit: 0, totalCredit: 0 };
        }
        ledgerMap[account_id].totalDebit  += entry.debit_amount  || 0;
        ledgerMap[account_id].totalCredit += entry.credit_amount || 0;
      });

      // Save ledger map to state so it can be dynamically filtered
      setGlobalLedgerMap(ledgerMap);

    } catch (err) {
      console.error('Error fetching overview ledger data:', err);
    } finally {
      setLedgerLoading(false);
    }
  };

  const { stats, topExpenses, incomeBreakdown, expenseBreakdown, assetsBreakdown, liabilitiesBreakdown, recentTxns, chartData, insights, mappedExpenses, donutColors } = React.useMemo(() => {
    let txns = selectedAccountId === 'ALL' ? allTxnsRaw : allTxnsRaw.filter(t => String(t.account_id) === String(selectedAccountId));

    if (timeRange !== 'ALL') {
      const today = new Date();
      const cutoff = new Date();
      if (timeRange === '30D') {
        cutoff.setDate(today.getDate() - 30);
      } else if (timeRange === '3M') {
        cutoff.setMonth(today.getMonth() - 3);
      } else if (timeRange === '12M') {
        cutoff.setMonth(today.getMonth() - 12);
      }
      txns = txns.filter(t => new Date(t.txn_date) >= cutoff);
    }

    let totalIncome = 0;
    let totalExpense = 0;
    const expenseMap = {};
    const incomeMap = {};
    const monthlyData = {};
    // Track only categorised transactions for the Recent Transactions table
    const categorisedTxns = [];

    txns.forEach(txn => {
      const credit = parseFloat(txn.credit) || 0;
      const debit = parseFloat(txn.debit) || 0;

      const date = new Date(txn.txn_date);
      let timeKey = '';
      let sortTime = date.getTime();

      if (timeframe === 'MONTH') {
        timeKey = date.toLocaleString('en-US', { month: 'short' }) + ' ' + String(date.getFullYear()).slice(-2);
        sortTime = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
      } else if (timeframe === 'WEEK') {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const weekStart = new Date(d.setDate(diff));
        timeKey = formatDate(weekStart);
        sortTime = weekStart.getTime();
      } else {
        timeKey = formatDate(date);
      }

      if (!monthlyData[timeKey]) {
        // Start at 0 — only categorised P&L amounts will be added below
        monthlyData[timeKey] = { income: 0, expense: 0, label: timeKey, _d: sortTime };
      }

      let category = 'Uncategorized';
      let effectiveAccountType = null;
      let isContra = false;
      let isUncatDB = false;
      let isBase = false;

      const baseAccountType = txn.source_account?.account_type;

      if (txn.transactions && txn.transactions.length > 0) {
        const linkedTxn = txn.transactions[0];
        isContra = linkedTxn.is_contra === true;
        isUncatDB = linkedTxn.is_uncategorised === true;

        if (baseAccountType === 'EXPENSE' || baseAccountType === 'INCOME') {
          category = txn.source_account?.account_name || 'Uncategorized';
          effectiveAccountType = baseAccountType;
          isBase = true;
        } else if (linkedTxn.accounts) {
          category = linkedTxn.accounts.account_name;
          effectiveAccountType = linkedTxn.accounts.account_type;
        }
      }

      // Skip contra transactions (internal bank-to-bank transfers)
      if (isContra) return;

      const catLower = category.toLowerCase().trim();
      const isUncategorised =
        isUncatDB ||
        effectiveAccountType === null ||
        catLower.includes('uncategor') ||
        catLower.includes('unclassif') ||
        catLower.includes('suspense') ||
        catLower.includes('opening bal') ||
        catLower.includes('temp') ||
        catLower === 'other' ||
        catLower === 'others' ||
        catLower === 'miscellaneous' ||
        catLower === 'misc' ||
        catLower === 'undefined' ||
        catLower === 'unknown' ||
        catLower === 'general' ||
        catLower === 'assets' ||
        catLower === 'liabilities' ||
        catLower === 'income' ||
        catLower === 'expenses' ||
        catLower === 'equity' ||
        catLower === 'current assets' ||
        catLower === 'fixed assets' ||
        catLower === 'non-current assets' ||
        catLower === 'current liabilities' ||
        catLower === 'long-term liabilities' ||
        catLower === 'non-current liabilities';
      if (isUncategorised) return;

      if (effectiveAccountType === 'EXPENSE') {
        const expenseAmt = isBase ? debit : credit;
        const reversalAmt = isBase ? credit : debit;

        if (expenseAmt > 0) {
          totalExpense += expenseAmt;
          monthlyData[timeKey].expense += expenseAmt;
          if (!expenseMap[category]) expenseMap[category] = { amount: 0, txns: [] };
          expenseMap[category].amount += expenseAmt;
          expenseMap[category].txns.push({ ...txn, _isExpense: true, _amt: expenseAmt });
          categorisedTxns.push({ ...txn, _isExpense: true, _amt: expenseAmt, _cat: category });
        } else if (reversalAmt > 0) {
          monthlyData[timeKey].expense = Math.max(0, monthlyData[timeKey].expense - reversalAmt);
        }
      } else if (effectiveAccountType === 'INCOME') {
        const incomeAmt = isBase ? credit : debit;
        const reversalAmt = isBase ? debit : credit;

        if (incomeAmt > 0) {
          totalIncome += incomeAmt;
          monthlyData[timeKey].income += incomeAmt;
          if (!incomeMap[category]) incomeMap[category] = { amount: 0, txns: [] };
          incomeMap[category].amount += incomeAmt;
          incomeMap[category].txns.push({ ...txn, _isExpense: false, _amt: incomeAmt });
          categorisedTxns.push({ ...txn, _isExpense: false, _amt: incomeAmt, _cat: category });
        } else if (reversalAmt > 0) {
          monthlyData[timeKey].income = Math.max(0, monthlyData[timeKey].income - reversalAmt);
        }
      }
      // EQUITY, ASSETS, LIABILITIES — skip from P&L widgets
    });

    const balance = totalIncome - totalExpense;
    const sortedMonths = Object.values(monthlyData).sort((a, b) => a._d - b._d);

    const insights = [];
    if (totalIncome > totalExpense && totalIncome > 0) {
      const ratio = (((totalIncome - totalExpense) / totalIncome) * 100).toFixed(0);
      insights.push({ type: 'success', text: `Great job! You saved ${ratio}% of your income this period.` });
    } else if (totalExpense > totalIncome && totalIncome > 0) {
      const overspent = (((totalExpense - totalIncome) / totalIncome) * 100).toFixed(0);
      insights.push({ type: 'danger', text: `Warning: You spent ${overspent}% more than you earned this period.` });
    }

    const topExpenseCat = Object.entries(expenseMap).sort((a, b) => b[1].amount - a[1].amount)[0];
    if (topExpenseCat) {
      const ratio = ((topExpenseCat[1].amount / totalExpense) * 100).toFixed(0);
      insights.push({ type: 'info', text: `Your highest spend category is '${topExpenseCat[0]}', burning ${ratio}% of all expenses.` });
    }

    // Extract all valid, categorised expense transactions from the expenseMap
    const validExpenseTxns = Object.values(expenseMap).flatMap(cat => cat.txns).sort((a, b) => b._amt - a._amt);
    if (validExpenseTxns.length > 0) {
      const largest = validExpenseTxns[0];
      const avg = totalExpense / validExpenseTxns.length;
      if (largest._amt > avg * 3 && largest._amt > 10000) {
        const formattedAmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(largest._amt);
        insights.push({
          type: 'warning',
          text: `Large unusual transaction detected: ${formattedAmt} for '${largest.details}'.`,
          txn: largest
        });
      }
    }

    const mappedExpenses = Object.entries(expenseMap)
      .map(([name, data]) => ({ name, amount: data.amount, txns: data.txns }))
      .sort((a, b) => b.amount - a.amount);

    const donutColors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#6366F1', '#84CC16', '#06B6D4', '#D946EF'];

    return {
      insights, mappedExpenses, donutColors,
      stats: { income: totalIncome, expense: totalExpense, savings: balance, balance: balance },
      topExpenses: Object.entries(expenseMap)
        .map(([name, data]) => ({ name, amount: data.amount, txns: data.txns }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5),
      incomeBreakdown: Object.entries(incomeMap)
        .map(([name, data]) => ({ name, amount: data.amount, txns: data.txns }))
        .sort((a, b) => b.amount - a.amount),
      expenseBreakdown: Object.entries(expenseMap)
        .map(([name, data]) => ({ name, amount: data.amount, txns: data.txns }))
        .sort((a, b) => b.amount - a.amount),
      // Only show properly categorised transactions in the recent list
      recentTxns: categorisedTxns.slice(0, 5),
      chartData: sortedMonths
    };
  }, [allTxnsRaw, selectedAccountId, timeframe, timeRange]);

  useEffect(() => {
    if (chartScrollRef.current) {
      chartScrollRef.current.scrollLeft = chartScrollRef.current.scrollWidth;
    }
  }, [chartData, timeframe]);

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2
    }).format(amount);
  };

  const maxChartVal = Math.max(...chartData.map(d => Math.max(d.income, d.expense)), 1000);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="overview-container">
      <div className="overview-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <h1>Overview Dashboard</h1>
          <div style={{ width: '1px', height: '24px', background: 'var(--border-color)' }}></div>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', fontWeight: 500 }}>View your financial summary and key metrics.</span>
        </div>
        <div className="header-filters" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {accounts.length > 0 && (
            <select
              value={selectedAccountId}
              onChange={e => handleAccountChange(e.target.value)}
              className="filter-tab"
              style={{
                outline: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                color: 'var(--text-primary)'
              }}
            >
              <option value="ALL">All Accounts</option>
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>{acc.name}</option>
              ))}
            </select>
          )}
          <select
            value={timeRange}
            onChange={e => setTimeRange(e.target.value)}
            className="filter-tab"
            style={{
              outline: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              color: 'var(--text-primary)'
            }}
          >
            <option value="ALL">All time</option>
            <option value="30D">Last 30 Days</option>
            <option value="3M">Last 3 Months</option>
            <option value="12M">Last 12 Months</option>
          </select>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card" onClick={() => handleStatClick('INCOME')} style={{ cursor: 'pointer' }}>
          <div className="stat-icon income">
            <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline><polyline points="16 7 22 7 22 13"></polyline></svg>
          </div>
          <div className="stat-info">
            <span className="stat-label">Total Income</span>
            <span className="stat-value">{formatCurrency(stats.income)}</span>
          </div>
        </div>

        <div className="stat-card" onClick={() => handleStatClick('EXPENSE')} style={{ cursor: 'pointer' }}>
          <div className="stat-icon expense">
            <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"></polyline><polyline points="16 17 22 17 22 11"></polyline></svg>
          </div>
          <div className="stat-info">
            <span className="stat-label">Total Expense</span>
            <span className="stat-value">{formatCurrency(stats.expense)}</span>
          </div>
        </div>

        <div className="stat-card" onClick={() => handleStatClick('SAVINGS')} style={{ cursor: 'pointer' }}>
          <div className="stat-icon savings">
            <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 12 3a4.65 4.65 0 0 0-4.5 8.5c.76.76 1.23 1.52 1.41 2.5"></path></svg>
          </div>
          <div className="stat-info">
            <span className="stat-label">Net Savings</span>
            <span className="stat-value">{formatCurrency(stats.savings)}</span>
          </div>
        </div>

        <div className="stat-card" onClick={() => handleStatClick('BALANCE')} style={{ cursor: 'pointer' }}>
          <div className="stat-icon balance">
            <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"></path><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"></path><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"></path></svg>
          </div>
          <div className="stat-info">
            <span className="stat-label">Balance</span>
            <span className="stat-value">{formatCurrency(stats.balance)}</span>
          </div>
        </div>

        <div className="stat-card" onClick={() => handleStatClick('ASSETS')} style={{ cursor: 'pointer' }}>
          <div className="stat-icon assets">
            <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"></rect><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"></path><line x1="12" y1="12" x2="12" y2="16"></line><line x1="10" y1="14" x2="14" y2="14"></line></svg>
          </div>
          <div className="stat-info">
            <span className="stat-label">Total Assets</span>
            <span className="stat-value" style={{ color: assetsLedger.total < 0 ? '#ef4444' : 'inherit' }}>
              {formatCurrency(assetsLedger.total)}
            </span>
          </div>
        </div>

        <div className="stat-card" onClick={() => handleStatClick('LIABILITIES')} style={{ cursor: 'pointer' }}>
          <div className="stat-icon liabilities">
            <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path></svg>
          </div>
          <div className="stat-info">
            <span className="stat-label">Total Liabilities</span>
            <span className="stat-value" style={{ color: liabilitiesLedger.total < 0 ? '#ef4444' : 'inherit' }}>
              {formatCurrency(liabilitiesLedger.total)}
            </span>
          </div>
        </div>
      </div>

      <div className="main-content-grid">
        <div className="overview-card">
          <div className="card-header">
            <h3 className="card-title">Income vs Expense Trend</h3>
            <select
              value={timeframe}
              onChange={e => setTimeframe(e.target.value)}
              style={{
                position: 'absolute', top: '-4px', right: '170px',
                padding: '4px 8px', borderRadius: '6px', background: 'var(--bg-primary)',
                color: 'var(--text-primary)', border: '1px solid var(--border-color)',
                fontSize: '12px', outline: 'none', cursor: 'pointer'
              }}
            >
              <option value="DAY">Daily</option>
              <option value="WEEK">Weekly</option>
              <option value="MONTH">Monthly</option>
            </select>
            <div className="chart-legend">
              <div className="legend-item"><div className="legend-dot expense"></div> Expense</div>
              <div className="legend-item"><div className="legend-dot income"></div> Income</div>
            </div>
          </div>
          <div className="chart-container">
            <div className="chart-y-axis">
              <span>₹{(maxChartVal / 1000).toFixed(0)}k</span>
              <span>₹{(maxChartVal * 0.75 / 1000).toFixed(0)}k</span>
              <span>₹{(maxChartVal * 0.5 / 1000).toFixed(0)}k</span>
              <span>₹{(maxChartVal * 0.25 / 1000).toFixed(0)}k</span>
              <span>₹0</span>
            </div>
            <div className="chart-y-line" style={{ bottom: '85px' }}></div>
            <div className="chart-y-line" style={{ bottom: '140px' }}></div>
            <div className="chart-y-line" style={{ bottom: '195px' }}></div>
            <div className="chart-y-line" style={{ bottom: '250px' }}></div>

            <div className="chart-content" ref={chartScrollRef}>
              {chartData.map((data, i) => (
                <div
                  className="chart-group"
                  key={i}
                  onMouseEnter={() => setActiveBarIndex(i)}
                  onMouseLeave={() => setActiveBarIndex(null)}
                  style={{ cursor: 'pointer' }}
                >
                  {activeBarIndex === i && (
                    <div className="chart-tooltip">
                      <div className="tooltip-inc">Inc: {formatCurrency(data.income)}</div>
                      <div className="tooltip-exp">Exp: {formatCurrency(data.expense)}</div>
                    </div>
                  )}
                  <div className="chart-bar income" style={{ height: `${(data.income / maxChartVal) * 100}%` }}></div>
                  <div className="chart-bar expense" style={{ height: `${(data.expense / maxChartVal) * 100}%` }}></div>
                  <div className="chart-label">{data.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="overview-card">
          <div className="card-header">
            <h3 className="card-title">Top Expenses</h3>
            <span className="card-link" onClick={() => navigate('/transactions')}>See all →</span>
          </div>
          <div className="top-expenses-list">
            {topExpenses.map((exp, i) => (
              <div
                className="expense-item"
                key={i}
                onClick={() => navigate('/category/' + encodeURIComponent(exp.name), { state: { txns: exp.txns } })}
                style={{ cursor: 'pointer', padding: '4px', margin: '-4px', borderRadius: '6px' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-primary)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <div className="expense-rank">{i + 1}</div>
                <div className="expense-name">{exp.name}</div>
                <div className="expense-amount">{formatCurrency(exp.amount)}</div>
              </div>
            ))}
            <div className="expense-total">
              <span>Top {topExpenses.length} Σ</span>
              <span>{formatCurrency(topExpenses.reduce((a, b) => a + b.amount, 0))}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="secondary-grid">
        <div className="overview-card" style={{ minWidth: 0 }}>
          <div className="card-header">
            <h3 className="card-title">Expense Breakdown</h3>
          </div>
          {stats.expense > 0 ? (
            <div className="donut-container">
              <div style={{ position: 'relative', width: '180px', height: '180px', flexShrink: 0 }}>
                <svg viewBox="0 0 100 100" style={{ transform: 'rotate(-90deg)', width: '100%', height: '100%' }}>
                  {(() => {
                    let offset = 0;
                    const r = 40;
                    const circ = 2 * Math.PI * r;
                    return mappedExpenses.map((exp, i) => {
                      const ratio = exp.amount / stats.expense;
                      const dashVal = ratio * circ;
                      const strokeOffset = -offset;
                      offset += dashVal;
                      if (ratio === 0) return null;
                      return (
                        <circle
                          key={i}
                          cx="50" cy="50" r={r}
                          fill="transparent"
                          stroke={donutColors[i % donutColors.length]}
                          strokeWidth={activeDonutIndex === i ? "24" : "20"}
                          strokeDasharray={`${dashVal} ${circ}`}
                          strokeDashoffset={strokeOffset}
                          onMouseEnter={() => setActiveDonutIndex(i)}
                          onMouseLeave={() => setActiveDonutIndex(null)}
                          style={{
                            transition: 'stroke-width 0.2s ease, stroke-dasharray 1s ease, stroke-dashoffset 1s ease, opacity 0.2s',
                            cursor: 'pointer',
                            opacity: activeDonutIndex === null || activeDonutIndex === i ? 1 : 0.4
                          }}
                        />
                      );
                    });
                  })()}
                </svg>
                <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', pointerEvents: 'none' }}>
                  {activeDonutIndex !== null ? (
                    <>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)', textAlign: 'center', padding: '0 8px', wordBreak: 'break-word', lineHeight: 1.1, marginBottom: '4px' }}>
                        {mappedExpenses[activeDonutIndex].name}
                      </span>
                      <span style={{ fontSize: '16px', fontWeight: '800', color: donutColors[activeDonutIndex % donutColors.length] }}>
                        ₹{(mappedExpenses[activeDonutIndex].amount / 1000).toFixed(1)}k
                      </span>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Total</span>
                      <span style={{ fontSize: '18px', fontWeight: '800', color: 'var(--text-primary)' }}>₹{(stats.expense / 1000).toFixed(1)}k</span>
                    </>
                  )}
                </div>
              </div>
              <div className="donut-legend" style={{ flexGrow: 1 }}>
                {mappedExpenses.map((exp, i) => (
                  <div
                    className="donut-legend-item"
                    key={i}
                    onClick={() => navigate('/category/' + encodeURIComponent(exp.name), { state: { txns: exp.txns } })}
                    onMouseEnter={() => setActiveDonutIndex(i)}
                    onMouseLeave={() => setActiveDonutIndex(null)}
                    style={{
                      opacity: activeDonutIndex === null || activeDonutIndex === i ? 1 : 0.4,
                      cursor: 'pointer',
                      transition: 'opacity 0.2s ease',
                      padding: '2px 6px', margin: '-2px -6px', borderRadius: '4px'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div className="donut-legend-color" style={{ background: donutColors[i % donutColors.length] }}></div>
                      <span>{exp.name}</span>
                    </div>
                    <span style={{ fontWeight: '700' }}>{((exp.amount / stats.expense) * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="empty-state">No expense data to display.</div>
          )}
        </div>

        <div className="overview-card" style={{ minWidth: 0 }}>
          <div className="card-header">
            <h3 className="card-title">Smart Insights</h3>
          </div>
          <div className="insights-list">
            {insights.map((insight, i) => (
              <div className={`insight-item ${insight.type}`} key={i}>
                <div className="insight-icon">
                  {insight.type === 'success' && <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"></path></svg>}
                  {insight.type === 'danger' && <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"></path></svg>}
                  {insight.type === 'warning' && <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>}
                  {insight.type === 'info' && <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>}
                </div>
                <div style={{ fontSize: '14px', lineHeight: '1.4', color: 'var(--text-primary)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span>{insight.text}</span>
                  {insight.txn && (
                    <button
                      onClick={() => navigate('/transactions', { state: { srcAccId: insight.txn.account_id } })}
                      style={{
                        alignSelf: 'flex-start',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--primary-action, #7c6ff7)',
                        fontSize: '12px',
                        fontWeight: '600',
                        padding: 0,
                        cursor: 'pointer',
                        textDecoration: 'underline'
                      }}
                    >
                      View Transactions
                    </button>
                  )}
                </div>
              </div>
            ))}
            {insights.length === 0 && <div className="empty-state">No notable insights right now.</div>}
          </div>
        </div>
      </div>

      <div className="overview-card top-space">
        <div className="card-header" style={{ marginBottom: '16px' }}>
          <h3 className="card-title">Recent Transactions</h3>
        </div>
        <table className="recent-transactions-table">
          <thead>
            <tr>
              <th>DATE</th>
              <th>DETAILS</th>
              <th>CATEGORY</th>
              <th>AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {recentTxns.map(txn => {
              const isExpense = txn._isExpense === true;
              const amt = txn._amt || 0;

              let category = txn._cat || 'Uncategorized';
              if (!txn._cat && txn.transactions && txn.transactions.length > 0 && txn.transactions[0].accounts) {
                category = txn.transactions[0].accounts.account_name;
              } else if (!txn._cat) {
                if (txn.details.toLowerCase().includes('salary')) category = 'Staff Salary';
                else if (txn.details.toLowerCase().includes('rent')) category = 'Rent';
              }

              const sign = isExpense ? '-' : '+';
              const displayDate = formatDate(txn.txn_date);

              return (
                <tr key={txn.uncategorized_transaction_id}>
                  <td>{displayDate}</td>
                  <td className="txn-details">{txn.details}</td>
                  <td><span className="txn-category">{category}</span></td>
                  <td className={`txn-amount ${isExpense ? 'negative' : 'positive'}`}>
                    {sign}{formatCurrency(amt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {breakdownModal.isOpen && (
        <div className="modal-overlay" onClick={() => setBreakdownModal({ isOpen: false, type: null, data: [] })}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{breakdownModal.type}</h2>
              <button className="close-btn" onClick={() => setBreakdownModal({ isOpen: false, type: null, data: [] })}>✕</button>
            </div>
            <div className="modal-body">
              {breakdownModal.data.map((item, i) => {
                const isClickable = !item.isSummary && !item.isBold && item.txns && item.txns.length > 0;
                return (
                  <div
                    key={i}
                    className="breakdown-item"
                    onClick={() => {
                      if (!isClickable) return;
                      setBreakdownModal({ isOpen: false, type: null, data: [] });
                      navigate('/category/' + encodeURIComponent(item.name), {
                        state: { txns: item.txns, backTo: '/overview' }
                      });
                    }}
                    style={{
                      borderTop: item.isBold ? '1px solid var(--border-color)' : undefined,
                      paddingTop: item.isBold ? '10px' : undefined,
                      marginTop: item.isBold ? '6px' : undefined,
                      fontWeight: item.isBold ? 700 : item.isSummary ? 600 : 400,
                      cursor: isClickable ? 'pointer' : 'default',
                      borderRadius: isClickable ? '6px' : undefined,
                      padding: isClickable ? '4px 6px' : undefined,
                      margin: isClickable ? '-4px -6px' : undefined,
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => { if (isClickable) e.currentTarget.style.background = 'var(--bg-primary)'; }}
                    onMouseLeave={(e) => { if (isClickable) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span className="breakdown-name" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={isClickable ? { color: 'var(--primary-action, #6366f1)', textDecoration: 'underline' } : {}}>
                        {item.name}
                      </span>
                      {item.tag && (
                        <span style={{
                          fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '999px',
                          background: item.tag === 'Credit Card' ? '#fef3c7' : '#fee2e2',
                          color: item.tag === 'Credit Card' ? '#92400e' : '#991b1b',
                        }}>
                          {item.tag}
                        </span>
                      )}
                      {isClickable && (
                        <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
                          <path d="M5 12H19M12 5l7 7-7 7"/>
                        </svg>
                      )}
                    </span>
                    <span className="breakdown-amount" style={{ color: item.amount < 0 ? '#ef4444' : 'inherit' }}>
                      {formatCurrency(item.amount)}
                    </span>
                  </div>
                );
              })}
              {breakdownModal.data.length === 0 && <div className="empty-state">No data available.</div>}
            </div>
          </div>
        </div>
      )}

      {categoryTxnModal.isOpen && (
        <div className="modal-overlay" onClick={() => setCategoryTxnModal({ isOpen: false, categoryName: '', txns: [] })}>
          <div className="modal-content" style={{ maxWidth: '650px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: '18px' }}>{categoryTxnModal.categoryName} <span style={{ color: 'var(--text-secondary)', fontWeight: 500, marginLeft: '4px' }}>({categoryTxnModal.txns.length} transactions)</span></h2>
              <button className="close-btn" onClick={() => setCategoryTxnModal({ isOpen: false, categoryName: '', txns: [] })}>✕</button>
            </div>
            <div className="modal-body" style={{ maxHeight: '60vh', padding: 0 }}>
              <table className="recent-transactions-table" style={{ margin: 0 }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 1 }}>
                  <tr>
                    <th style={{ padding: '16px 24px' }}>DATE</th>
                    <th style={{ padding: '16px 24px' }}>DETAILS</th>
                    <th style={{ padding: '16px 24px', textAlign: 'right' }}>AMOUNT</th>
                  </tr>
                </thead>
                <tbody>
                  {categoryTxnModal.txns.map(txn => {
                    const isDebit = txn.debit > 0;
                    const amt = isDebit ? txn.debit : txn.credit;
                    const sign = isDebit ? '-' : '+';
                    const displayDate = formatDate(txn.txn_date);
                    return (
                      <tr key={txn.uncategorized_transaction_id}>
                        <td style={{ padding: '16px 24px' }}>{displayDate}</td>
                        <td className="txn-details" style={{ padding: '16px 24px' }}>{txn.details}</td>
                        <td className={`txn-amount ${isDebit ? 'negative' : 'positive'}`} style={{ padding: '16px 24px', textAlign: 'right' }}>
                          {sign}{formatCurrency(amt)}
                        </td>
                      </tr>
                    );
                  })}
                  {categoryTxnModal.txns.length === 0 && (
                    <tr><td colSpan="3" className="empty-state">No transactions found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}


    </motion.div>
  );
};

export default Overview;
