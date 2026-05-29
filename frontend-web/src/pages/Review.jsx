import { useState, useEffect, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Check, Code, FileSearch, Building2, Cpu, Loader2, ChevronLeft, ChevronRight, CheckCircle, Download, Link, ScrollText, Trash2, Plus, Minus, RotateCcw, AlertCircle, Info, X, Building, CreditCard, ChevronDown, List, Maximize2, Minimize2, Expand } from "lucide-react";
// import API from "../api/api";
import API from "../api/api";
import { useParsing } from "../context/ParsingContext";
import PDFViewer from "../components/PDFViewer";
import { Toast, useToast } from "../components/Toast";

// Syntax highlighting helper for JSON
const syntaxHighlight = (json) => {
    if (!json) return "";
    let str = JSON.stringify(json, null, 2);
    str = str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="json-highlight">${str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
        let cls = 'number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'key';
            } else {
                cls = 'string';
            }
        } else if (/true|false/.test(match)) {
            cls = 'boolean';
        } else if (/null/.test(match)) {
            cls = 'null';
        }
        return `<span class="${cls}">${match}</span>`;
    })}</div>`;
};

// Generic field editor for Date, Details, Balance
const FieldEditor = ({ value, type, onSave, onCancel }) => {
    const [val, setVal] = useState(value || '');
    const [saving, setSaving] = useState(false);
    const inputRef = useRef(null);

    useEffect(() => { 
        inputRef.current?.focus(); 
        if (type !== 'textarea' && type !== 'date') inputRef.current?.select(); 
    }, [type]);

    const handleSave = async () => {
        setSaving(true);
        await onSave(type === 'number' ? parseFloat(val) || 0 : val);
        setSaving(false);
    };

    const handleKey = (e) => {
        if (e.key === 'Enter' && type !== 'textarea') handleSave();
        if (e.key === 'Escape') onCancel();
    };

    return (
        <div className="amount-editor" onClick={(e) => e.stopPropagation()}>
            {type === 'textarea' ? (
                <textarea
                    ref={inputRef}
                    className="amount-editor-input"
                    value={val}
                    onChange={(e) => setVal(e.target.value)}
                    onKeyDown={handleKey}
                    style={{ minHeight: '80px', resize: 'vertical', width: '220px' }}
                />
            ) : (
                <input
                    ref={inputRef}
                    className="amount-editor-input"
                    type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
                    step={type === 'number' ? '0.01' : undefined}
                    value={val}
                    onChange={(e) => setVal(e.target.value)}
                    onKeyDown={handleKey}
                    style={{ width: type === 'date' ? '150px' : '100%' }}
                />
            )}
            <div className="amount-editor-actions">
                <button className="amount-editor-save" onClick={handleSave} disabled={saving}>
                    {saving ? '...' : '✓'}
                </button>
                <button className="amount-editor-cancel" onClick={onCancel}>✕</button>
            </div>
        </div>
    );
};

// Specialized amount editor with Dr/Cr toggle
const AmountEditor = ({ tx, onSave, onCancel }) => {
    const isDebit = (tx.debit || 0) > 0;
    const [editAmount, setEditAmount] = useState(isDebit ? tx.debit : tx.credit);
    const [editType, setEditType] = useState(isDebit ? 'DEBIT' : 'CREDIT');
    const [saving, setSaving] = useState(false);
    const inputRef = useRef(null);

    useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

    const handleSave = async () => {
        const parsed = parseFloat(editAmount);
        if (isNaN(parsed) || parsed < 0) return;
        setSaving(true);
        await onSave(parsed, editType);
        setSaving(false);
    };

    const handleKey = (e) => {
        if (e.key === 'Enter') handleSave();
        if (e.key === 'Escape') onCancel();
    };

    return (
        <div className="amount-editor" onClick={(e) => e.stopPropagation()}>
            <div className="amount-editor-type-toggle">
                <button
                    className={`type-btn ${editType === 'DEBIT' ? 'active debit' : ''}`}
                    onClick={() => setEditType('DEBIT')}
                >− Dr</button>
                <button
                    className={`type-btn ${editType === 'CREDIT' ? 'active credit' : ''}`}
                    onClick={() => setEditType('CREDIT')}
                >+ Cr</button>
            </div>
            <input
                ref={inputRef}
                className="amount-editor-input"
                type="number"
                step="0.01"
                min="0.01"
                value={editAmount}
                onChange={(e) => setEditAmount(e.target.value)}
                onKeyDown={handleKey}
            />
            <div className="amount-editor-actions">
                <button className="amount-editor-save" onClick={handleSave} disabled={saving}>
                    {saving ? '...' : '✓'}
                </button>
                <button className="amount-editor-cancel" onClick={onCancel}>✕</button>
            </div>
        </div>
    );
};

export default function ReviewPage() {
    const { toasts, exiting, showToast, dismissToast } = useToast();
    const [searchParams] = useSearchParams();
    const documentId = searchParams.get("id");
    const navigate = useNavigate();
    const { retryExtraction } = useParsing();

    const [data, setData] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState("");
    const [isApproved, setIsApproved] = useState(false);
    const [isApproving, setIsApproving] = useState(false);
    const [userAccounts, setUserAccounts] = useState([]);
    const [selectedAccountId, setSelectedAccountId] = useState(null);
    const [isLinkingAccount, setIsLinkingAccount] = useState(false);
    const [accountLinked, setAccountLinked] = useState(false);

    // Editing and Selection state
    const [editableCodeTxns, setEditableCodeTxns] = useState([]);
    const [editableLlmTxns, setEditableLlmTxns] = useState([]);
    const [selectedIndices, setSelectedIndices] = useState({ CODE: [], LLM: [] });
    const [activeParser, setActiveParser] = useState("CODE"); 
    const [currentPage, setCurrentPage] = useState(1);
    const [editingCell, setEditingCell] = useState(null); // { parser, index, field }
    const [isRetryModalOpen, setIsRetryModalOpen] = useState(false);
    const [retryMethod, setRetryMethod] = useState("CODE"); // CODE, VISION, MANUAL
    const [retryNote, setRetryNote] = useState("");
    const [isRetrying, setIsRetrying] = useState(false);

    // Add Account Modal State
    const [isAddAccountModalOpen, setIsAddAccountModalOpen] = useState(false);
    const [isAddingAccount, setIsAddingAccount] = useState(false);
    const [isAccountDropdownOpen, setIsAccountDropdownOpen] = useState(false);
    const accountDropdownRef = useRef(null);
    const [newAccountForm, setNewAccountForm] = useState({
        type: 'BANK',
        institution_name: '',
        account_name: '',
        last4: '',
        ifsc_code: '',
        card_network: 'VISA'
    });

    // PDF Viewer state
    const [pdfMapData, setPdfMapData] = useState([]);
    const [pdfPageCount, setPdfPageCount] = useState(0);
    const [pdfLoading, setPdfLoading] = useState(false);
    const [pdfHighlightIndex, setPdfHighlightIndex] = useState(null);
    const [pdfHoverIndex, setPdfHoverIndex] = useState(null);
    const [tablePdfHighlight, setTablePdfHighlight] = useState(null);
    const [lastInteraction, setLastInteraction] = useState(null); // 'PDF' or 'TABLE'
    const [activeView, setActiveView] = useState("extracted"); // "extracted" or "json"
    const [isFullscreen, setIsFullscreen] = useState(false); // fullscreen transactions view

    const fetchReviewData = async () => {
        if (!documentId) return;
        setIsLoading(true);
        try {
            const res = await API.get(`/documents/${documentId}/review`);
            setData(res.data);
            const codeTxns = res.data.code_transactions || [];
            const llmTxns = res.data.llm_transactions || [];
            
            setEditableCodeTxns(codeTxns);
            setEditableLlmTxns(llmTxns);
            
            const preferred = res.data.transaction_parsed_type || "CODE";
            setActiveParser(preferred);
            
            // Auto-deselect rows marked as duplicates by the backend
            setSelectedIndices({
                CODE: codeTxns.map((tx, i) => tx.is_duplicate ? null : i).filter(v => v !== null),
                LLM: llmTxns.map((tx, i) => tx.is_duplicate ? null : i).filter(v => v !== null)
            });
            if (res.data.user_accounts) setUserAccounts(res.data.user_accounts);
            if (res.data.selected_account_id) {
                setSelectedAccountId(res.data.selected_account_id);
                setAccountLinked(true);
            }
            if (res.data.status === "APPROVE") {
                setIsApproved(true);
                setAccountLinked(true);
            }
        } catch (err) {
            console.error(err);
            setError("Failed to fetch review data.");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchReviewData();
    }, [documentId]);

    useEffect(() => {
        setEditingCell(null);
    }, [activeParser]);

    // Fetch PDF map (rubber-binding bboxes) — runs once after documentId is known
    useEffect(() => {
        if (!documentId) return;
        setPdfLoading(true);
        API.get(`/documents/${documentId}/pdf-map`)
            .then(res => {
                const txns = res.data.transactions || [];
                setPdfMapData(txns);
                setPdfPageCount(res.data.page_count || 0);
                
                // Auto-jump to the first page that actually contains transactions
                if (txns.length > 0 && txns[0].page && txns[0].page > 1) {
                    setCurrentPage(prev => (prev === 1 ? txns[0].page : prev));
                }
            })
            .catch(err => console.error('PDF map load error:', err))
            .finally(() => setPdfLoading(false));
    }, [documentId]);

    // Find matching index in pdfMapData by date+amount (occurrence-aware)
    const findPdfMapIndex = (txn, tableIdx, parserType) => {
        if (!pdfMapData || !pdfMapData.length) return null;
        const date = String(txn.date || txn.txn_date || '');
        const amount = parseFloat(txn.debit || txn.credit || 0);

        let occurrence = 0;
        const txns = parserType === 'CODE' ? editableCodeTxns : editableLlmTxns;
        for (let k = 0; k <= tableIdx; k++) {
            const t = txns[k];
            const tAmt = parseFloat(t.debit || t.credit || 0);
            if (String(t.date || t.txn_date || '') === date && Math.abs(tAmt - amount) < 0.05) {
                occurrence++;
            }
        }

        let matchCount = 0;
        for (let j = 0; j < pdfMapData.length; j++) {
            const pt = pdfMapData[j];
            if (!pt.bbox) continue;
            const pdfDate = String(pt.date || pt.txn_date || '');
            const pdfAmt  = parseFloat(pt.debit || pt.credit || 0);
            if (pdfDate === date && Math.abs(pdfAmt - amount) < 0.05) {
                matchCount++;
                if (matchCount === occurrence) return j;
            }
        }
        
        // Fallback to first match
        for (let j = 0; j < pdfMapData.length; j++) {
            const pt = pdfMapData[j];
            if (!pt.bbox) continue;
            const pdfDate = String(pt.date || pt.txn_date || '');
            const pdfAmt  = parseFloat(pt.debit || pt.credit || 0);
            if (pdfDate === date && Math.abs(pdfAmt - amount) < 0.05) return j;
        }

        return null;
    };

    // Find matching table-row index by date+amount (occurrence-aware)
    const findTableIndex = (pdfTxn, pdfIdx, parserType) => {
        const date  = String(pdfTxn.date || pdfTxn.txn_date || '');
        const amount = parseFloat(pdfTxn.debit || pdfTxn.credit || 0);

        let occurrence = 0;
        for (let j = 0; j <= pdfIdx; j++) {
            const pt = pdfMapData[j];
            if (!pt.bbox) continue; 
            const ptDate = String(pt.date || pt.txn_date || '');
            const ptAmt = parseFloat(pt.debit || pt.credit || 0);
            if (ptDate === date && Math.abs(ptAmt - amount) < 0.05) {
                occurrence++;
            }
        }

        const txns = parserType === 'CODE' ? editableCodeTxns : editableLlmTxns;
        let matchCount = 0;
        for (let k = 0; k < txns.length; k++) {
            const t = txns[k];
            const tAmt = parseFloat(t.debit || t.credit || 0);
            if (String(t.date || t.txn_date || '') === date && Math.abs(tAmt - amount) < 0.05) {
                matchCount++;
                if (matchCount === occurrence) return k;
            }
        }

        // Fallback to first match
        for (let k = 0; k < txns.length; k++) {
            const t = txns[k];
            const tAmt = parseFloat(t.debit || t.credit || 0);
            if (String(t.date || t.txn_date || '') === date && Math.abs(tAmt - amount) < 0.05) return k;
        }
        
        return null;
    };

    const handleApprove = async () => {
        if (!accountLinked) { showToast("Please link an account before approving.", "error"); return; }
        const txnsToUse = activeParser === "CODE" ? editableCodeTxns : editableLlmTxns;
        const currentIndices = selectedIndices[activeParser];
        if (currentIndices.length === 0) { showToast("Please select at least one transaction to approve.", "error"); return; }
        const selectedTxns = currentIndices.map(i => txnsToUse[i]);
        setIsApproving(true);
        try {
            await API.post(`/documents/${documentId}/approve`, { transactions: selectedTxns, parser_type: activeParser });
            setIsApproved(true);
            setData(prev => prev ? { ...prev, status: "APPROVE" } : prev);
            showToast(`${selectedTxns.length} transactions approved successfully!`, "success");
        } catch (err) {
            console.error(err);
            showToast("Approval failed: " + (err.response?.data?.detail || err.message), "error");
        } finally {
            setIsApproving(false);
        }
    };

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (accountDropdownRef.current && !accountDropdownRef.current.contains(event.target)) {
                setIsAccountDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleLinkAccount = async () => {
        if (!selectedAccountId) return;
        if (selectedAccountId === "ADD_NEW") {
            setIsAddAccountModalOpen(true);
            return;
        }
        setIsLinkingAccount(true);
        try {
            await API.post(`/documents/${documentId}/select-account`, { account_id: selectedAccountId });
            setAccountLinked(true);
            // Re-fetch data to trigger backend deduplication now that account is linked
            await fetchReviewData();
            showToast("Account linked successfully!", "success");
        } catch (err) {
            console.error(err);
            showToast("Failed to link account: " + (err.response?.data?.detail || err.message), "error");
        } finally {
            setIsLinkingAccount(false);
        }
    };

    const handleCreateAccount = async () => {
        if (!newAccountForm.institution_name || !newAccountForm.last4) {
            showToast("Please fill in Institution Name and Last 4 digits.", "error");
            return;
        }
        if (newAccountForm.last4.length !== 4) {
            showToast("Last 4 digits must be exactly 4 numbers.", "error");
            return;
        }

        setIsAddingAccount(true);
        try {
            const res = await API.post("/documents/accounts", newAccountForm);
            const createdAcc = res.data;
            
            // Add to the list and select it
            setUserAccounts(prev => [...prev, createdAcc].sort((a,b) => a.institution_name.localeCompare(b.institution_name)));
            setSelectedAccountId(createdAcc.account_id);
            setAccountLinked(false); // Make user click "Link" or auto-link? 
            
            // Close modal
            setIsAddAccountModalOpen(false);
            setNewAccountForm({ type: 'BANK', institution_name: '', account_name: '', last4: '', ifsc_code: '', card_network: 'VISA' });
            
            // Auto-link newly created account
            await API.post(`/documents/${documentId}/select-account`, { account_id: createdAcc.account_id });
            setAccountLinked(true);
            showToast("Account created and linked successfully!", "success");
            
        } catch (err) {
            console.error(err);
            showToast("Failed to create account: " + (err.response?.data?.detail || err.message), "error");
        } finally {
            setIsAddingAccount(false);
        }
    };

    const handleRetryExtraction = async () => {
        setIsRetrying(true);
        try {
            await API.post(`/documents/${documentId}/retry`, {
                method: retryMethod,
                note: retryNote
            });
            
            // Trigger progress overlay in context
            retryExtraction(documentId, data?.file_name || "Document");

            // Redirect to dashboard where the progress indicator is
            navigate("/parsing");
        } catch (err) {
            console.error(err);
            showToast("Retry failed: " + (err.response?.data?.detail || err.message), "error");
        } finally {
            setIsRetrying(false);
            setIsRetryModalOpen(false);
        }
    };

    const handleUpdateTxn = (parserType, index, field, value) => {
        const updater = parserType === "CODE" ? setEditableCodeTxns : setEditableLlmTxns;
        updater(prev => {
            const next = [...prev];
            next[index] = { ...next[index], [field]: value };
            return next;
        });
    };

    const handleAmountSave = (parserType, index, amount, type) => {
        const updater = parserType === "CODE" ? setEditableCodeTxns : setEditableLlmTxns;
        updater(prev => {
            const next = [...prev];
            next[index] = {
                ...next[index],
                debit: type === 'DEBIT' ? amount : 0,
                credit: type === 'CREDIT' ? amount : 0
            };
            return next;
        });
        setEditingCell(null);
    };

    const toggleSelection = (parserType, index) => {
        setSelectedIndices(prev => {
            const current = [...prev[parserType]];
            const foundIdx = current.indexOf(index);
            if (foundIdx > -1) current.splice(foundIdx, 1);
            else current.push(index);
            return { ...prev, [parserType]: current };
        });
    };

    const handleAddTxn = (parserType) => {
        const updater = parserType === "CODE" ? setEditableCodeTxns : setEditableLlmTxns;
        const newTxn = { date: new Date().toISOString().split('T')[0], details: "Manual Entry", debit: 0, credit: 0, balance: 0, confidence: 1.0 };
        updater(prev => {
            const next = [...prev, newTxn];
            setSelectedIndices(prevIndices => ({ ...prevIndices, [parserType]: [...prevIndices[parserType], next.length - 1] }));
            return next;
        });
    };

    const toggleSelectAll = (parserType, onlyIndices = null) => {
        const txns = parserType === "CODE" ? editableCodeTxns : editableLlmTxns;
        setSelectedIndices(prev => {
            const targets = onlyIndices || txns.map((t, i) => t.is_duplicate ? null : i).filter(v => v !== null);
            const isAllSelected = targets.length > 0 && targets.every(idx => prev[parserType].includes(idx));
            
            let newSelected = [...prev[parserType]];
            if (isAllSelected) {
                // Deselect only targets
                newSelected = newSelected.filter(idx => !targets.includes(idx));
            } else {
                // Select all targets (avoiding duplicates)
                const toAdd = targets.filter(idx => !newSelected.includes(idx));
                newSelected = [...newSelected, ...toAdd];
            }
            return { ...prev, [parserType]: newSelected };
        });
    };

    const handleDownloadJson = async () => {
        try {
            const txnsToUse = activeParser === "CODE" ? editableCodeTxns : editableLlmTxns;
            const currentIndices = selectedIndices[activeParser];
            const selectedTxns = currentIndices.map(i => txnsToUse[i]);
            const linkedAccount = userAccounts.find(a => a.account_id === selectedAccountId);
            const accountNumber = linkedAccount?.account_number || linkedAccount?.account_number_last4 || linkedAccount?.card_last4 || String(documentId);
            const normalizedTransactions = selectedTxns.map(tx => ({
                txn_date:   tx.txn_date  ?? tx.date        ?? null,
                debit:      tx.debit     != null ? tx.debit  : 0,
                credit:     tx.credit    != null ? tx.credit : 0,
                balance:    tx.balance   != null ? tx.balance : 0,
                details:    tx.details   || tx.description  || "",
                confidence: tx.confidence ?? null,
            }));
            const output = {
                file_name: data?.file_name || `${(data?.bank_name || "bank").replace(/\s+/g, "_").toLowerCase()}_primary_ml.pdf`,
                identifiers: [String(accountNumber)],
                transactions: normalizedTransactions,
            };
            const jsonStr = JSON.stringify(output, null, 2);
            const blob = new Blob([jsonStr], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${(data?.bank_name || "transactions").replace(/\s+/g, "_")}_transactions.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast("JSON downloaded successfully!", "success");
        } catch (err) {
            console.error(err);
            showToast("Download failed.", "error");
        }
    };

    if (isLoading) return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
                <Loader2 className="spin-icon" size={48} color="var(--primary-action)" />
            </div>
        );

    if (error || !data || !documentId) return (
            <div id="review-empty-state" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '70vh', textAlign: 'center', padding: '2rem' }}>
                <div style={{ width: '80px', height: '80px', borderRadius: '24px', background: 'rgba(72, 62, 168, 0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1.5rem', color: 'var(--primary-action)' }}>
                    <FileSearch size={40} />
                </div>
                <h2 id="review-title" style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>No Document Selected</h2>
                <p style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', maxWidth: '400px', lineHeight: 1.6, marginBottom: '2rem' }}>Transaction data will appear here once you've started processing a statement.</p>
                <button onClick={() => navigate("/parsing")} style={{ padding: '0.8rem 2.5rem', background: 'var(--primary-action)', color: 'white', border: 'none', borderRadius: '12px', fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' }}>Return to Dashboard</button>
            </div>
        );

    const renderTransactionTable = (transactions, title, icon, parserType) => {
        const isActive = activeParser === parserType;
        const currentSelected = selectedIndices[parserType] || [];
        
        // Map transactions to their PDF pages
        let txnPages = new Array(transactions.length).fill(1);
        if (transactions.length > 0) {
            let lastPage = null;
            let pdfSearchStart = 0;
            
            for (let i = 0; i < transactions.length; i++) {
                const txn = transactions[i];
                const date = String(txn.date || txn.txn_date || '');
                const amount = parseFloat(txn.debit || txn.credit || 0);
                let matchedPage = null;
                
                if (pdfMapData && pdfMapData.length > 0) {
                    for (let j = pdfSearchStart; j < pdfMapData.length; j++) {
                        const pt = pdfMapData[j];
                        const pdfDate = String(pt.date || pt.txn_date || '');
                        const pdfAmt  = parseFloat(pt.debit || pt.credit || 0);
                        if (pdfDate === date && Math.abs(pdfAmt - amount) < 0.05) {
                            matchedPage = pt.page;
                            pdfSearchStart = j + 1;
                            break;
                        }
                    }
                }
                
                if (matchedPage !== null) {
                    lastPage = matchedPage;
                    txnPages[i] = matchedPage;
                } else {
                    txnPages[i] = lastPage;
                }
            }
            
            let firstKnownPage = txnPages.find(p => p !== null) || 1;
            for (let i = txnPages.length - 1; i >= 0; i--) {
                if (txnPages[i] === null) {
                    txnPages[i] = firstKnownPage;
                } else {
                    firstKnownPage = txnPages[i];
                }
            }
        }

        // Pagination Logic
        const totalPages = Math.max(pdfPageCount || 1, Math.max(...txnPages, 1));
        
        const pagedTransactions = [];
        const pagedIndices = [];
        
        for (let i = 0; i < transactions.length; i++) {
            if (txnPages[i] === currentPage) {
                pagedTransactions.push(transactions[i]);
                pagedIndices.push(i);
            }
        }
        
        // Check if all rows on CURRENT page are selected
        const isAllSelected = pagedIndices.length > 0 && pagedIndices.every(idx => currentSelected.includes(idx));

        return (
            <div style={{
                background: isActive ? 'var(--bg-primary)' : 'var(--card-bg)',
                borderRadius: '16px',
                border: isActive ? '2px solid var(--primary-action)' : '1px solid var(--border-color)',
                overflow: 'hidden',
                opacity: isActive ? 1 : 0.7,
                transition: 'all 0.3s ease',
                position: 'relative'
            }}>
                {/* ── Fullscreen button ── absolute top-right of card */}
                <div
                    style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 10 }}
                    onMouseEnter={e => { const t = e.currentTarget.querySelector('.fs-tip'); if(t) t.style.opacity='1'; }}
                    onMouseLeave={e => { const t = e.currentTarget.querySelector('.fs-tip'); if(t) t.style.opacity='0'; }}
                >
                    <button
                        onClick={(e) => { e.stopPropagation(); setIsFullscreen(true); }}
                        style={{
                            background: 'var(--bg-primary)',
                            border: '1px solid var(--border-color)',
                            borderRadius: '6px',
                            padding: '4px 6px',
                            cursor: 'pointer',
                            color: 'var(--text-secondary)',
                            display: 'flex',
                            alignItems: 'center',
                            transition: 'color 0.15s, border-color 0.15s',
                        }}
                    >
                        <Expand size={14} />
                    </button>
                    <div className="fs-tip" style={{
                        position: 'absolute',
                        top: 'calc(100% + 6px)',
                        right: 0,
                        background: '#111',
                        color: '#fff',
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        padding: '4px 9px',
                        borderRadius: '6px',
                        whiteSpace: 'nowrap',
                        opacity: 0,
                        transition: 'opacity 0.15s',
                        pointerEvents: 'none',
                        zIndex: 100,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                    }}>
                        View fullscreen
                        <div style={{ 
                            position: 'absolute', 
                            top: '-4px', 
                            right: '10px', 
                            width: 0, 
                            height: 0, 
                            borderLeft: '4px solid transparent', 
                            borderRight: '4px solid transparent', 
                            borderBottom: '4px solid #111' 
                        }} />
                    </div>
                </div>

                <div 
                    onClick={() => !isApproved && setActiveParser(parserType)}
                    style={{
                        padding: '0.75rem 1rem',
                        paddingRight: '48px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        cursor: isApproved ? 'default' : 'pointer',
                        borderBottom: '1px solid var(--border-color)',
                        background: isActive ? 'rgba(72, 62, 168, 0.05)' : 'transparent'
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div style={{
                            width: 20, height: 20, borderRadius: '50%',
                            border: `2px solid ${isActive ? 'var(--primary-action)' : 'var(--border-color)'}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: isActive ? 'var(--primary-action)' : 'transparent'
                        }}>
                            {isActive && <Check size={12} color="white" />}
                        </div>
                        <h3 style={{ fontSize: '0.85rem', fontWeight: 400, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            {title}
                        </h3>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.05)', padding: '2px 8px', borderRadius: '10px' }}>
                            {transactions.length} rows
                        </span>
                    </div>

                    </div>

                <div id="review-table" style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ background: 'var(--bg-secondary)' }}>
                                <th style={{ width: '40px', padding: '1rem', textAlign: 'center' }}>
                                    <input 
                                        type="checkbox" 
                                        checked={isAllSelected} 
                                        onChange={() => !isApproved && toggleSelectAll(parserType, pagedIndices)} 
                                        disabled={isApproved} 
                                        style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--accent-color)' }}
                                    />
                                </th>
                                <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', width: '130px', letterSpacing: '0.05em' }}>Date</th>
                                <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Details</th>
                                <th style={{ padding: '1rem', textAlign: 'right', fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', width: '110px', letterSpacing: '0.05em' }}>Debit</th>
                                <th style={{ padding: '1rem', textAlign: 'right', fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', width: '110px', letterSpacing: '0.05em' }}>Credit</th>
                                <th style={{ padding: '1rem', textAlign: 'right', fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', width: '120px', letterSpacing: '0.05em' }}>Balance</th>
                                <th style={{ padding: '1rem', textAlign: 'center', fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', width: '90px', letterSpacing: '0.05em' }}>Match</th>
                            </tr>
                        </thead>
                        <tbody>
                            {pagedTransactions && pagedTransactions.length > 0 ? pagedTransactions.map((tx, i) => {
                                const realIndex = pagedIndices[i];
                                const isSelected = currentSelected.includes(realIndex);
                                const isDebit = (tx.debit || 0) > 0;
                                const amount = isDebit ? tx.debit : tx.credit;
                                const isActiveRow = isActive && tablePdfHighlight === realIndex;

                                return (
                                    <tr 
                                        key={realIndex}
                                        id={`txn-row-${parserType}-${realIndex}`}
                                        onClick={() => {
                                            if (isActive && !tx.is_duplicate) {
                                                setLastInteraction('TABLE');
                                                const pdfIdx = findPdfMapIndex(tx, realIndex, parserType);
                                                setPdfHighlightIndex(pdfIdx !== null ? pdfIdx : realIndex);
                                                setTablePdfHighlight(realIndex);
                                            }
                                        }}
                                        style={{ 
                                            borderBottom: '1px solid #f1f5f9',
                                            background: tx.is_duplicate
                                                ? '#fef2f2'
                                                : isActiveRow
                                                    ? '#FDFFB4'
                                                    : (isSelected ? '#f8fafc' : 'transparent'),
                                            borderLeft: tx.is_duplicate
                                                ? '4px solid #ef4444'
                                                : isActiveRow
                                                    ? '4px solid #FDE047'
                                                    : '4px solid transparent',
                                            position: 'relative',
                                            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                                            cursor: isActive && !tx.is_duplicate ? 'pointer' : 'default',
                                        }}
                                    >
                                        <td style={{ textAlign: 'center', padding: '0.75rem' }}>
                                            <input 
                                                type="checkbox" 
                                                checked={isSelected} 
                                                onChange={() => !isApproved && !tx.is_duplicate && toggleSelection(parserType, realIndex)} 
                                                disabled={isApproved || tx.is_duplicate}
                                                style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--accent-color)' }}
                                            />
                                        </td>
                                        
                                        {/* Date Field */}
                                        <td style={{ padding: '0.5rem', position: 'relative' }}>
                                            {editingCell?.parser === parserType && editingCell?.index === i && editingCell?.field === 'date' ? (
                                                <FieldEditor 
                                                    value={tx.date || tx.txn_date || ''}
                                                    type="date"
                                                    onSave={(val) => { handleUpdateTxn(parserType, i, 'date', val); setEditingCell(null); }}
                                                    onCancel={() => setEditingCell(null)}
                                                />
                                            ) : (
                                                <div 
                                                    className="amount-cell-review"
                                                    onClick={() => !isApproved && !tx.is_duplicate && setEditingCell({ parser: parserType, index: i, field: 'date' })}
                                                    style={{ cursor: (isApproved || tx.is_duplicate) ? 'default' : 'pointer', width: '120px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}
                                                >
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                        {tx.date || tx.txn_date || ''}
                                                        {!isApproved && !tx.is_duplicate && <span className="amount-edit-hint">✎</span>}
                                                    </div>
                                                    {tx.is_duplicate && (
                                                        <span style={{ 
                                                            fontSize: '10px', 
                                                            fontWeight: 800, 
                                                            background: '#2B4366', 
                                                            color: 'white', 
                                                            padding: '2px 6px', 
                                                            borderRadius: '4px',
                                                            letterSpacing: '0.5px'
                                                        }}>
                                                            DUPLICATE
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                        </td>

                                        {/* Details Field */}
                                        <td style={{ padding: '0.5rem', position: 'relative' }}>
                                            {editingCell?.parser === parserType && editingCell?.index === i && editingCell?.field === 'details' ? (
                                                <FieldEditor 
                                                    value={tx.details || tx.description || ''}
                                                    type="textarea"
                                                    onSave={(val) => { handleUpdateTxn(parserType, i, 'details', val); setEditingCell(null); }}
                                                    onCancel={() => setEditingCell(null)}
                                                />
                                            ) : (
                                                <div 
                                                    className="amount-cell-review"
                                                    onClick={() => !isApproved && !tx.is_duplicate && setEditingCell({ parser: parserType, index: i, field: 'details' })}
                                                    style={{ cursor: (isApproved || tx.is_duplicate) ? 'default' : 'pointer', minWidth: '200px' }}
                                                >
                                                    {tx.details || tx.description || ''}
                                                    {!isApproved && <span className="amount-edit-hint">✎</span>}
                                                </div>
                                            )}
                                        </td>

                                        {/* Separate Debit and Credit Cells for perfect alignment */}
                                        {editingCell?.parser === parserType && editingCell?.index === i && editingCell?.field === 'amount' ? (
                                            <td colSpan="2" style={{ padding: '0.5rem 1rem', position: 'relative' }}>
                                                <AmountEditor 
                                                    tx={tx} 
                                                    onSave={(amt, type) => handleAmountSave(parserType, i, amt, type)} 
                                                    onCancel={() => setEditingCell(null)} 
                                                />
                                            </td>
                                        ) : (
                                            <>
                                                {/* Debit Cell */}
                                                <td 
                                                    style={{ padding: '0.5rem 1rem', textAlign: 'right', width: '120px', position: 'relative' }}
                                                    onClick={() => !isApproved && !tx.is_duplicate && setEditingCell({ parser: parserType, index: i, field: 'amount' })}
                                                >
                                                    <div className="amount-cell-review" style={{ cursor: (isApproved || tx.is_duplicate) ? 'default' : 'pointer', justifyContent: 'flex-end', width: '100%', gap: '4px' }}>
                                                        {isDebit && <Minus size={12} style={{ color: '#F87171' }} />}
                                                        <span style={{ color: isDebit ? '#F87171' : '#e2e8f0', fontWeight: 600 }}>{isDebit ? `₹${amount}` : '--'}</span>
                                                        {!isApproved && <span className="amount-edit-hint">✎</span>}
                                                    </div>
                                                </td>
                                                {/* Credit Cell */}
                                                <td 
                                                    style={{ padding: '0.5rem 1rem', textAlign: 'right', width: '120px', position: 'relative' }}
                                                    onClick={() => !isApproved && !tx.is_duplicate && setEditingCell({ parser: parserType, index: i, field: 'amount' })}
                                                >
                                                    <div className="amount-cell-review" style={{ cursor: (isApproved || tx.is_duplicate) ? 'default' : 'pointer', justifyContent: 'flex-end', width: '100%', gap: '4px' }}>
                                                        {!isDebit && amount > 0 && <Plus size={12} style={{ color: '#34D399' }} />}
                                                        <span style={{ color: !isDebit && amount > 0 ? '#34D399' : '#e2e8f0', fontWeight: 600 }}>{!isDebit && amount > 0 ? `₹${amount}` : '--'}</span>
                                                        {!isApproved && <span className="amount-edit-hint">✎</span>}
                                                    </div>
                                                </td>
                                            </>
                                        )}

                                        {/* Balance Field */}
                                        <td style={{ padding: '0.5rem', position: 'relative', textAlign: 'right' }}>
                                            {editingCell?.parser === parserType && editingCell?.index === i && editingCell?.field === 'balance' ? (
                                                <FieldEditor 
                                                    value={tx.balance || ''}
                                                    type="number"
                                                    onSave={(val) => { handleUpdateTxn(parserType, i, 'balance', val); setEditingCell(null); }}
                                                    onCancel={() => setEditingCell(null)}
                                                />
                                            ) : (
                                                <div 
                                                    className="amount-cell-review"
                                                    onClick={() => !isApproved && !tx.is_duplicate && setEditingCell({ parser: parserType, index: i, field: 'balance' })}
                                                    style={{ cursor: (isApproved || tx.is_duplicate) ? 'default' : 'pointer', fontWeight: 600, width: '90px', marginLeft: 'auto' }}
                                                >
                                                    ₹{tx.balance || '0'}
                                                    {!isApproved && <span className="amount-edit-hint">✎</span>}
                                                </div>
                                            )}
                                        </td>

                                        <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                                            <span style={{ 
                                                background: tx.confidence >= 0.9 ? '#ecfdf5' : tx.confidence >= 0.7 ? '#fffbeb' : '#fef2f2',
                                                color: tx.confidence >= 0.9 ? '#059669' : tx.confidence >= 0.7 ? '#d97706' : '#dc2626',
                                                padding: '4px 10px', borderRadius: '8px', fontSize: '0.7rem', fontWeight: 800, border: '1px solid currentColor'
                                            }}>
                                                {tx.confidence != null ? (tx.confidence * 100).toFixed(0) + '%' : 'N/A'}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            }) : (
                                <tr><td colSpan="7" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>No transactions extracted.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>

                {!isApproved && (
                    <div style={{ padding: '0.5rem', borderTop: '1px solid var(--border-color)', background: isActive ? 'rgba(72, 62, 168, 0.02)' : 'transparent' }}>
                        {/* Footer space */}
                    </div>
                )}
                
                <style dangerouslySetInnerHTML={{ __html: `
                    .table-input { background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 4px 8px; font-family: inherit; font-size: 0.8rem; color: var(--text-primary); transition: all 0.2; }
                    .table-input:hover:not(:disabled) { border-color: var(--border-color); background: var(--bg-secondary); }
                    .table-input:focus:not(:disabled) { border-color: var(--primary-action); background: var(--bg-primary); outline: none; box-shadow: 0 0 0 2px rgba(72, 62, 168, 0.1); }
                    
                    .amount-cell-review { position: relative; border-radius: 6px; padding: 4px 8px; transition: background 0.15s; user-select: none; min-height: 28px; display: flex; align-items: center; font-size: 0.8rem; }
                    .amount-cell-review:hover:not(:disabled) { background: rgba(255, 255, 255, 0.04); }
                    
                    .amount-edit-hint { position: absolute; top: -2px; right: -2px; font-size: 11px; opacity: 0; color: var(--text-secondary); transition: opacity 0.15s; }
                    .amount-cell-review:hover .amount-edit-hint { opacity: 1; }
                    
                    .amount-editor { display: flex; flex-direction: column; gap: 6px; background: var(--bg-primary, #1a1a2e); border: 1px solid var(--glass-border); border-radius: 10px; padding: 8px 10px; min-width: 140px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); text-align: left; z-index: 100; position: absolute; top: 100%; right: 0; }
                    .amount-editor-type-toggle { display: flex; border-radius: 6px; overflow: hidden; border: 1px solid var(--glass-border); margin-bottom: 4px; }
                    .type-btn { flex: 1; padding: 4px 8px; font-size: 11px; font-weight: 700; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; transition: all 0.15s; }
                    .type-btn.active.debit { background: rgba(248, 113, 113, 0.15); color: #F87171; }
                    .type-btn.active.credit { background: rgba(52, 211, 153, 0.15); color: #34D399; }
                    .amount-editor-input { width: 100%; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--glass-border); border-radius: 6px; padding: 6px; font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px; outline: none; }
                    .amount-editor-input:focus { border-color: var(--accent-color); }
                    .amount-editor-actions { display: flex; gap: 6px; }
                    .amount-editor-save, .amount-editor-cancel { flex: 1; padding: 5px 0; border-radius: 6px; font-size: 13px; font-weight: 700; border: 1px solid var(--glass-border); cursor: pointer; transition: all 0.15s; }
                    .amount-editor-save { background: rgba(52, 211, 153, 0.15); color: #34D399; border-color: rgba(52, 211, 153, 0.3); }
                    .amount-editor-save:hover:not(:disabled) { background: rgba(52, 211, 153, 0.25); }
                    .amount-editor-cancel { background: transparent; color: var(--text-secondary); }
                    .amount-editor-cancel:hover { background: rgba(255, 255, 255, 0.05); color: var(--text-primary); }
                `}} />

                {/* ── Fullscreen Modal ─────────────────────────────── */}
                {isFullscreen && (
                    <div style={{
                        position: 'fixed', inset: 0,
                        background: 'var(--bg-primary)',
                        zIndex: 9999,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                    }}>
                        {/* Fullscreen header */}
                        <div style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '1rem 1.5rem',
                            borderBottom: '1px solid var(--border-color)',
                            background: 'var(--bg-secondary)',
                            flexShrink: 0,
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                <h2 style={{ fontSize: '1rem', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
                                    Transactions
                                </h2>
                                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.05)', padding: '2px 8px', borderRadius: '10px' }}>
                                    {transactions.length} rows
                                </span>
                            </div>
                            <button
                                onClick={() => setIsFullscreen(false)}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                                    background: 'none', border: '1px solid var(--border-color)',
                                    borderRadius: '8px', padding: '6px 12px',
                                    cursor: 'pointer', color: 'var(--text-secondary)',
                                    fontSize: '0.8rem', fontWeight: 600,
                                    transition: 'all 0.15s',
                                }}
                            >
                                <Minimize2 size={14} /> Exit Fullscreen
                            </button>
                        </div>

                        {/* Fullscreen table */}
                        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
                                    <tr style={{ background: 'var(--bg-secondary)' }}>
                                        <th style={{ width: '40px', padding: '1rem', textAlign: 'center' }}>
                                            <input
                                                type="checkbox"
                                                checked={pagedIndices.length > 0 && pagedIndices.every(idx => currentSelected.includes(idx))}
                                                onChange={() => !isApproved && toggleSelectAll(parserType, pagedIndices)}
                                                disabled={isApproved}
                                                style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--accent-color)' }}
                                            />
                                        </th>
                                        <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', width: '130px', letterSpacing: '0.05em' }}>Date</th>
                                        <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Details</th>
                                        <th style={{ padding: '1rem', textAlign: 'right', fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', width: '110px', letterSpacing: '0.05em' }}>Debit</th>
                                        <th style={{ padding: '1rem', textAlign: 'right', fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', width: '110px', letterSpacing: '0.05em' }}>Credit</th>
                                        <th style={{ padding: '1rem', textAlign: 'right', fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', width: '120px', letterSpacing: '0.05em' }}>Balance</th>
                                        <th style={{ padding: '1rem', textAlign: 'center', fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', width: '90px', letterSpacing: '0.05em' }}>Match</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {transactions.map((tx, i) => {
                                        const isSelected = currentSelected.includes(i);
                                        const isDebit = (tx.debit || 0) > 0;
                                        return (
                                            <tr key={i} style={{
                                                borderBottom: '1px solid #f1f5f9',
                                                background: tx.is_duplicate ? '#fef2f2' : isSelected ? '#f8fafc' : 'transparent',
                                                borderLeft: tx.is_duplicate ? '4px solid #ef4444' : '4px solid transparent',
                                            }}>
                                                <td style={{ textAlign: 'center', padding: '0.75rem' }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={isSelected}
                                                        onChange={() => !isApproved && !tx.is_duplicate && toggleSelection(parserType, i)}
                                                        disabled={isApproved || tx.is_duplicate}
                                                        style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--accent-color)' }}
                                                    />
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 500 }}>
                                                    {tx.date || tx.txn_date || '—'}
                                                    {tx.is_duplicate && <span style={{ display: 'block', fontSize: '10px', fontWeight: 800, background: '#2B4366', color: 'white', padding: '2px 6px', borderRadius: '4px', marginTop: '4px', letterSpacing: '0.5px' }}>DUPLICATE</span>}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', fontSize: '0.8rem', color: 'var(--text-primary)', maxWidth: '400px' }}>
                                                    {tx.details || tx.description || '—'}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: '0.8rem', fontWeight: 600, color: (tx.debit || 0) > 0 ? '#ef4444' : 'var(--text-secondary)' }}>
                                                    {(tx.debit || 0) > 0 ? `— ₹${tx.debit}` : '—'}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: '0.8rem', fontWeight: 600, color: (tx.credit || 0) > 0 ? '#10b981' : 'var(--text-secondary)' }}>
                                                    {(tx.credit || 0) > 0 ? `+ ₹${tx.credit}` : '—'}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                                    {tx.balance != null ? `₹${tx.balance}` : '—'}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                                                    <span style={{
                                                        background: tx.confidence >= 0.9 ? '#ecfdf5' : tx.confidence >= 0.7 ? '#fffbeb' : '#fef2f2',
                                                        color: tx.confidence >= 0.9 ? '#059669' : tx.confidence >= 0.7 ? '#d97706' : '#dc2626',
                                                        padding: '4px 10px', borderRadius: '8px', fontSize: '0.7rem', fontWeight: 800, border: '1px solid currentColor'
                                                    }}>
                                                        {tx.confidence != null ? (tx.confidence * 100).toFixed(0) + '%' : 'N/A'}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ 
                maxWidth: '1440px', 
                margin: '0 auto', 
                padding: '1.5rem', 
                minHeight: '100vh',
                background: 'var(--bg-primary)',
                fontFamily: "'Outfit', sans-serif"
            }}
        >
            {/* Compact Header with Stats */}
            <div style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', background: 'var(--bg-primary)', padding: '1rem 0', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                    <button
                        onClick={() => navigate(-1)}
                        style={{
                            padding: '8px 16px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'white', color: 'var(--text-primary)', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', transition: 'all 0.2s'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = '#f1f5f9'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
                    >
                        <ChevronLeft size={16} /> Back
                    </button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <h1 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0, letterSpacing: '-0.2px' }}>
                            {data?.file_name?.split('/').pop() || 'Review Document'}
                        </h1>
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '2.5rem', alignItems: 'center' }}>
                    {(() => {
                        const currentTxns = activeParser === "CODE" ? editableCodeTxns : editableLlmTxns;
                        const creditTxns = currentTxns.filter(t => (t.credit || 0) > 0);
                        const debitTxns = currentTxns.filter(t => (t.debit || 0) > 0);
                        const totalCreditAmount = creditTxns.reduce((sum, t) => sum + (t.credit || 0), 0);
                        const totalDebitAmount = debitTxns.reduce((sum, t) => sum + (t.debit || 0), 0);
                        
                        const formatMoney = (val) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(val);

                        return [
                            { label: `Total Transactions (${currentTxns.length})`, value: formatMoney(totalCreditAmount + totalDebitAmount), color: 'var(--primary-action)' },
                            { label: `Total Credit (${creditTxns.length})`, value: formatMoney(totalCreditAmount), color: '#059669' },
                            { label: `Total Debit (${debitTxns.length})`, value: formatMoney(totalDebitAmount), color: '#e11d48' }
                        ].map((stat, i) => (
                            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                                <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{stat.label}</div>
                                <div style={{ fontSize: '0.85rem', fontWeight: 700, color: stat.color }}>{stat.value}</div>
                            </div>
                        ));
                    })()}
                </div>
            </div>

            {/* Main 50-50 Split Layout */}
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                {/* Left Column: PDF Viewer (Strict 50%) */}
                <div style={{ width: 'calc(50% - 0.5rem)', position: 'sticky', top: '4rem', height: 'calc(100vh - 4rem)' }}>
                    <PDFViewer
                        documentId={documentId ? parseInt(documentId) : null}
                        transactions={pdfMapData}
                        pageCount={pdfPageCount}
                        selectedTxnIndex={pdfHighlightIndex}
                        onSelectTxn={(pdfIdx) => {
                            setLastInteraction('PDF');
                            setPdfHighlightIndex(pdfIdx);
                            const pdfTxn = pdfMapData[pdfIdx];
                            if (!pdfTxn) return;
                            const tableIdx = findTableIndex(pdfTxn, pdfIdx, activeParser);
                            const finalIdx = tableIdx !== null ? tableIdx : pdfIdx;
                            setTablePdfHighlight(finalIdx);
                            
                            // Change table pagination page if necessary
                            const requiredPage = pdfTxn.page || 1;
                            setCurrentPage(requiredPage);

                            setTimeout(() => {
                                const el = document.getElementById(`txn-row-${activeParser}-${finalIdx}`);
                                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }, 150);
                        }}
                        hoveredTxnIndex={pdfHoverIndex}
                        onHoverTxn={setPdfHoverIndex}
                        hidePageCount={true}
                        currentPage={currentPage}
                        onPageChange={setCurrentPage}
                        disableAutoScroll={lastInteraction === 'PDF'}
                    />
                </div>

                {/* Right Column: Control Panel (Strict 50%) */}
                <div style={{ width: 'calc(50% - 0.5rem)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                    
                    {/* Step 1: Link Bank Account */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', opacity: isApproved ? 0.8 : 1, transition: 'all 0.3s ease' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', padding: '0 0.5rem' }}>
                            <h2 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ background: accountLinked ? 'var(--accent-color)' : 'var(--primary-action)', color: 'white', width: '20px', height: '20px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem' }}>
                                    {accountLinked ? <Check size={12} strokeWidth={3} /> : "1"}
                                </span>
                                Link Bank Account
                            </h2>
                        </div>

                        {/* Account Linker - Integrated */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0 0.5rem' }}>
                            <div style={{ flex: 1, position: 'relative' }} ref={accountDropdownRef}>
                                <div 
                                    onClick={() => !isApproved && setIsAccountDropdownOpen(!isAccountDropdownOpen)} 
                                    style={{ padding: '10px 14px', border: '1px solid #cbd5e1', borderRadius: '10px', background: 'white', cursor: isApproved ? 'not-allowed' : 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}
                                >
                                    <span style={{ fontSize: '0.85rem', fontWeight: 500, color: selectedAccountId ? '#1e293b' : '#94a3b8' }}>
                                        {selectedAccountId 
                                            ? userAccounts.find(a => a.account_id === selectedAccountId)?.institution_name + " ••••" + (userAccounts.find(a => a.account_id === selectedAccountId)?.account_number_last4 || userAccounts.find(a => a.account_id === selectedAccountId)?.card_last4)
                                            : "Select Bank Account..."}
                                    </span>
                                    <ChevronDown size={14} color="#64748b" />
                                </div>
                                
                                {isAccountDropdownOpen && (
                                    <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 10000, background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', boxShadow: '0 10px 30px rgba(0,0,0,0.15)', overflow: 'hidden' }}>
                                        <div style={{ maxHeight: '200px', overflowY: 'auto', padding: '6px' }}>
                                            {userAccounts.map(acc => (
                                                <div 
                                                    key={acc.account_id}
                                                    onClick={() => { setSelectedAccountId(acc.account_id); setAccountLinked(false); setIsAccountDropdownOpen(false); }}
                                                    style={{ padding: '8px 12px', borderRadius: '8px', cursor: 'pointer', fontSize: '0.8rem', transition: 'background 0.2s' }}
                                                    onMouseEnter={(e) => e.currentTarget.style.background = '#f1f5f9'}
                                                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                                >
                                                    <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '0.85rem' }}>{acc.institution_name}</div>
                                                    <div style={{ fontSize: '0.75rem', color: '#64748b' }}>•••• {acc.account_number_last4 || acc.card_last4}</div>
                                                </div>
                                            ))}
                                        </div>
                                        <button 
                                            onClick={() => { setIsAddAccountModalOpen(true); setIsAccountDropdownOpen(false); }}
                                            style={{ width: '100%', padding: '10px', border: 'none', borderTop: '1px solid #e2e8f0', background: '#f8fafc', color: 'var(--primary-action)', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer' }}
                                        >
                                            + Add New Account
                                        </button>
                                    </div>
                                )}
                            </div>
                            <button 
                                onClick={(e) => {
                                    if (!selectedAccountId || isApproved || isLinkingAccount || accountLinked) return;
                                    handleLinkAccount();
                                }}
                                style={{ 
                                    padding: '10px 20px', 
                                    background: (accountLinked || isApproved) ? 'transparent' : (selectedAccountId ? 'var(--primary-action)' : 'white'), 
                                    color: (accountLinked || isApproved) ? 'var(--accent-color)' : (selectedAccountId ? 'white' : 'var(--primary-action)'), 
                                    border: (accountLinked || isApproved) ? '1px solid var(--accent-color)' : (selectedAccountId ? '1px solid var(--primary-action)' : '1px solid #cbd5e1'), 
                                    borderRadius: '10px', 
                                    fontWeight: 600, 
                                    fontSize: '0.85rem',
                                    cursor: 'pointer',
                                    boxShadow: (selectedAccountId && !accountLinked && !isApproved) ? '0 4px 12px rgba(72, 62, 168, 0.2)' : 'none',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    transition: 'all 0.3s ease'
                                }}
                                onMouseEnter={(e) => {
                                    if (!selectedAccountId && !accountLinked && !isApproved) e.currentTarget.style.background = '#f1f5f9';
                                }}
                                onMouseLeave={(e) => {
                                    if (!selectedAccountId && !accountLinked && !isApproved) e.currentTarget.style.background = 'white';
                                }}
                            >
                                {isLinkingAccount ? (
                                    <><Loader2 size={14} className="spin-icon" /> Linking...</>
                                ) : accountLinked ? (
                                    <><Check size={14} /> Linked</>
                                ) : (
                                    "Link Account"
                                )}
                            </button>
                        </div>
                    </div>

                    {/* Step 2: Extracted Transactions */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', transition: 'all 0.3s ease' }}>
                        {/* Header: Clean & Unobtrusive */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', padding: '0 0.5rem' }}>
                            <h2 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ background: isApproved ? 'var(--accent-color)' : (accountLinked ? 'var(--primary-action)' : '#cbd5e1'), color: 'white', width: '20px', height: '20px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', transition: 'all 0.3s ease' }}>
                                    {isApproved ? <Check size={12} strokeWidth={3} /> : "2"}
                                </span>
                                Review & Approve
                            </h2>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <button 
                                    onClick={(e) => {
                                        if (!accountLinked || isApproving || isApproved) return;
                                        handleApprove();
                                    }}
                                    style={{ 
                                        padding: '8px 20px', 
                                        borderRadius: '8px', 
                                        background: isApproved ? 'transparent' : (accountLinked ? 'var(--primary-action)' : 'white'), 
                                        color: isApproved ? 'var(--accent-color)' : (accountLinked ? 'white' : 'var(--primary-action)'), 
                                        border: isApproved ? '1px solid var(--accent-color)' : (accountLinked ? '1px solid var(--primary-action)' : '1px solid #cbd5e1'), 
                                        fontSize: '0.85rem', 
                                        fontWeight: 600, 
                                        cursor: 'pointer', 
                                        display: 'flex', 
                                        alignItems: 'center', 
                                        gap: '6px', 
                                        transition: 'all 0.3s ease',
                                        boxShadow: (!accountLinked || isApproved) ? 'none' : '0 4px 12px rgba(72, 62, 168, 0.25)'
                                    }}
                                    onMouseEnter={(e) => {
                                        if (!accountLinked && !isApproved) e.currentTarget.style.background = '#f1f5f9';
                                    }}
                                    onMouseLeave={(e) => {
                                        if (!accountLinked && !isApproved) e.currentTarget.style.background = 'white';
                                    }}
                                >
                                    {isApproving ? <Loader2 size={14} className="spin-icon" /> : <Check size={14} />}
                                    {isApproved ? 'Approved' : `Approve Data`}
                                </button>
                            </div>
                        </div>

                        {/* Transactions Section Container */}
                        <div style={{ display: 'flex', flexDirection: 'column', background: 'white', borderRadius: '20px', border: '1px solid var(--border-color)', boxShadow: '0 4px 20px rgba(0,0,0,0.02)', overflow: 'hidden' }}>
                            {/* The Table Itself */}
                            <div>
                                {renderTransactionTable(
                                    activeParser === "CODE" ? editableCodeTxns : editableLlmTxns,
                                    "Transactions",
                                    null,
                                    activeParser
                                )}
                            </div>

                            {/* Bottom Action Bar */}
                            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '0.75rem 1.25rem', background: '#f8fafc', borderTop: '1px solid #e2e8f0' }}>
                                {!isApproved && (currentPage >= (pdfPageCount || 1)) ? (
                                    <button 
                                        onClick={() => handleAddTxn(activeParser)}
                                        style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', background: 'transparent', color: 'var(--primary-action)', fontWeight: 700, fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}
                                    >
                                        <Plus size={16} /> Add Missing Row
                                    </button>
                                ) : <div />}
                            </div>
                        </div>
                    </div>
                </div>
            </div>


            {/* Retry Extraction Modal */}
            {isRetryModalOpen && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 11000 }}>
                    <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} style={{ background: 'var(--bg-secondary)', padding: '2.5rem', borderRadius: '24px', border: '1px solid var(--glass-border)', maxWidth: '500px', width: '90%', boxShadow: '0 25px 60px -12px rgba(0,0,0,0.4)', color: 'var(--text-primary)' }}>
                        <h3 style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: '0.75rem' }}>Retry extraction</h3>
                        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '2rem', lineHeight: 1.6 }}>
                            Choose a different extraction method or add a note to help the parser.
                        </p>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '2rem' }}>
                            <label style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '4px' }}>Extraction method</label>
                            
                            {[
                                { id: 'CODE', label: 'Code-based (current)', sub: 'Fastest extraction method' },
                                { id: 'VISION', label: 'AI vision extraction', sub: 'Better for scanned or image-based PDFs', recommended: true },
                                { id: 'MANUAL', label: 'Manual entry', sub: 'Set status to review and add manually' }
                            ].map(method => (
                                <div 
                                    key={method.id}
                                    onClick={() => setRetryMethod(method.id)}
                                    style={{ 
                                        padding: '1rem', 
                                        borderRadius: '12px', 
                                        border: `2px solid ${retryMethod === method.id ? 'var(--primary-action)' : 'var(--border-color)'}`,
                                        background: retryMethod === method.id ? 'rgba(72, 62, 168, 0.05)' : 'var(--bg-primary)',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '12px',
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    <div style={{ 
                                        width: '20px', height: '20px', borderRadius: '50%', 
                                        border: `2px solid ${retryMethod === method.id ? 'var(--primary-action)' : 'var(--border-color)'}`,
                                        display: 'flex', alignItems: 'center', justifyContent: 'center'
                                    }}>
                                        {retryMethod === method.id && <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--primary-action)' }} />}
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: 700, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            {method.label}
                                            {method.recommended && <span style={{ background: 'rgba(72, 62, 168, 0.1)', color: 'var(--primary-action)', fontSize: '0.65rem', padding: '2px 8px', borderRadius: '20px' }}>Recommended</span>}
                                        </div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{method.sub}</div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {data?.logic_version >= 3 && (
                            <div style={{ 
                                padding: '1rem', 
                                background: 'rgba(231, 76, 60, 0.08)', 
                                border: '1px solid rgba(231, 76, 60, 0.2)', 
                                borderRadius: '12px', 
                                marginBottom: '2rem', 
                                display: 'flex', 
                                gap: '12px' 
                            }}>
                                <AlertCircle size={20} color="#e74c3c" style={{ flexShrink: 0 }} />
                                <div style={{ fontSize: '0.8rem', color: '#e74c3c', lineHeight: 1.5, fontWeight: 500 }}>
                                    <b>AI reaches its limit:</b> This format has been refined {data.logic_version} times. Artificial Intelligence is struggling to fix this structure. We recommend using <b>AI Vision</b> or manually editing the transactions.
                                </div>
                            </div>
                        )}

                        <div style={{ marginBottom: '2rem' }}>
                            <label style={{ fontSize: '0.85rem', fontWeight: 700, display: 'block', marginBottom: '8px' }}>Reason / note <span style={{ fontWeight: 500, opacity: 0.6 }}>(optional)</span></label>
                            <textarea 
                                value={retryNote}
                                onChange={(e) => setRetryNote(e.target.value)}
                                placeholder="e.g. Transactions are missing from page 3 onwards..."
                                style={{ 
                                    width: '100%', minHeight: '100px', padding: '0.875rem', 
                                    borderRadius: '12px', background: 'var(--bg-primary)', 
                                    border: '1px solid var(--border-color)', color: 'var(--text-primary)',
                                    resize: 'vertical', fontSize: '0.9rem', outline: 'none'
                                }}
                            />
                        </div>

                        <div style={{ display: 'flex', gap: '1rem' }}>
                            <button 
                                onClick={() => setIsRetryModalOpen(false)} 
                                disabled={isRetrying}
                                style={{ flex: 1, padding: '0.875rem', borderRadius: '12px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', fontWeight: 700, cursor: isRetrying ? 'not-allowed' : 'pointer', color: 'var(--text-secondary)' }}
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={handleRetryExtraction} 
                                disabled={isRetrying}
                                style={{ 
                                    flex: 1.5, 
                                    padding: '0.875rem', 
                                    borderRadius: '12px', 
                                    border: 'none', 
                                    background: 'var(--primary-action)', 
                                    color: 'white', 
                                    fontWeight: 700, 
                                    cursor: isRetrying ? 'not-allowed' : 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '8px'
                                }}
                            >
                                {isRetrying ? <Loader2 size={18} className="spin-icon" /> : <RotateCcw size={18} />}
                                START RETRY
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
            {/* Add Account Modal */}
            {isAddAccountModalOpen && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 12000 }}>
                    <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} style={{ background: 'var(--bg-secondary)', padding: '2.5rem', borderRadius: '24px', border: '1px solid var(--glass-border)', maxWidth: '500px', width: '90%', boxShadow: '0 25px 60px -12px rgba(0,0,0,0.4)', color: 'var(--text-primary)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0 }}>Add Account</h3>
                            <button onClick={() => setIsAddAccountModalOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={20} /></button>
                        </div>

                        <div style={{ display: 'flex', gap: '8px', marginBottom: '1.5rem' }}>
                            <button 
                                onClick={() => setNewAccountForm(p => ({ ...p, type: 'BANK' }))}
                                style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `2px solid ${newAccountForm.type === 'BANK' ? 'var(--primary-action)' : 'var(--border-color)'}`, background: newAccountForm.type === 'BANK' ? 'rgba(72,62,168,0.05)' : 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontWeight: 700, fontSize: '0.85rem' }}
                            >
                                <Building size={16} /> Bank
                            </button>
                            <button 
                                onClick={() => setNewAccountForm(p => ({ ...p, type: 'CREDIT_CARD' }))}
                                style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `2px solid ${newAccountForm.type === 'CREDIT_CARD' ? 'var(--primary-action)' : 'var(--border-color)'}`, background: newAccountForm.type === 'CREDIT_CARD' ? 'rgba(72,62,168,0.05)' : 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontWeight: 700, fontSize: '0.85rem' }}
                            >
                                <CreditCard size={16} /> Credit Card
                            </button>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginBottom: '2rem' }}>
                            <div style={{ padding: '12px', background: 'rgba(72, 62, 168, 0.05)', border: '1px solid rgba(72, 62, 168, 0.1)', borderRadius: '12px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                                    <Info size={16} color="var(--primary-action)" />
                                    <span style={{ fontWeight: 800, fontSize: '0.85rem' }}>Account Identifier</span>
                                </div>
                                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>Add details to help match uploaded statements.</p>
                            </div>

                            <div className="form-group">
                                <label style={{ fontSize: '0.8rem', fontWeight: 700, display: 'block', marginBottom: '6px' }}>Institution / Bank Name *</label>
                                <input 
                                    type="text" 
                                    className="form-input" 
                                    placeholder="e.g. HDFC, SBI"
                                    value={newAccountForm.institution_name}
                                    onChange={e => setNewAccountForm(p => ({ ...p, institution_name: e.target.value }))}
                                    style={{ width: '100%', padding: '0.75rem', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' }}
                                />
                            </div>

                            <div style={{ display: 'flex', gap: '1rem' }}>
                                <div style={{ flex: 1 }}>
                                    <label style={{ fontSize: '0.8rem', fontWeight: 700, display: 'block', marginBottom: '6px' }}>Last 4 Digits *</label>
                                    <input 
                                        type="text" 
                                        maxLength={4}
                                        placeholder="e.g. 1234"
                                        value={newAccountForm.last4}
                                        onChange={e => setNewAccountForm(p => ({ ...p, last4: e.target.value.replace(/\D/g, '') }))}
                                        style={{ width: '100%', padding: '0.75rem', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' }}
                                    />
                                </div>
                                {newAccountForm.type === 'BANK' ? (
                                    <div style={{ flex: 1 }}>
                                        <label style={{ fontSize: '0.8rem', fontWeight: 700, display: 'block', marginBottom: '6px' }}>IFSC Code</label>
                                        <input 
                                            type="text" 
                                            placeholder="e.g. HDFC0001234"
                                            value={newAccountForm.ifsc_code}
                                            onChange={e => setNewAccountForm(p => ({ ...p, ifsc_code: e.target.value.toUpperCase() }))}
                                            style={{ width: '100%', padding: '0.75rem', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' }}
                                        />
                                    </div>
                                ) : (
                                    <div style={{ flex: 1 }}>
                                        <label style={{ fontSize: '0.8rem', fontWeight: 700, display: 'block', marginBottom: '6px' }}>Network</label>
                                        <select 
                                            value={newAccountForm.card_network}
                                            onChange={e => setNewAccountForm(p => ({ ...p, card_network: e.target.value }))}
                                            style={{ width: '100%', padding: '0.75rem', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' }}
                                        >
                                            <option value="VISA">Visa</option>
                                            <option value="MASTERCARD">Mastercard</option>
                                            <option value="AMEX">Amex</option>
                                            <option value="OTHER">Other</option>
                                        </select>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: '1rem' }}>
                            <button 
                                onClick={() => setIsAddAccountModalOpen(false)}
                                style={{ flex: 1, padding: '0.875rem', borderRadius: '12px', border: '1px solid var(--border-color)', background: 'none', color: 'var(--text-secondary)', fontWeight: 700, cursor: 'pointer' }}
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={handleCreateAccount}
                                disabled={isAddingAccount || !newAccountForm.institution_name || newAccountForm.last4.length !== 4}
                                style={{ flex: 1.5, padding: '0.875rem', borderRadius: '12px', border: 'none', background: 'var(--primary-action)', color: 'white', fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', opacity: (isAddingAccount || !newAccountForm.institution_name || newAccountForm.last4.length !== 4) ? 0.6 : 1 }}
                            >
                                {isAddingAccount ? <Loader2 size={18} className="spin-icon" /> : 'Add Account'}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
            <Toast toasts={toasts} exiting={exiting} onDismiss={dismissToast} />
        </motion.div>
    );
}