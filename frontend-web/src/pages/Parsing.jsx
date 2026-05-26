import { useEffect, useState, useRef } from "react";
import { motion } from "framer-motion";
import {
    FileUp, CheckCircle, Loader2, AlertCircle, Search, Cpu, List, Lock,
    FileText, Clock, ChevronDown, Table as TableIcon, Trash2, RotateCcw, Code, Eye, EyeOff, ScrollText
} from "lucide-react";
// import API from "../api/api";
import API from "../api/api";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useParsing, extractionSteps } from "../context/ParsingContext";
import { formatDate } from "../utils/dateUtils";
import '../styles/Overview.css';

// ── Circular Processing Indicator ────────────────────────────────────────────
const STAGE_META = {
    UPLOADED: { label: "Initializing", sub: "Setting up extraction workspace...", color: "var(--primary-action)", pct: 10 },
    UPLOADING: { label: "Uploading", sub: "Sending file to processing server...", color: "var(--primary-action)", pct: 10 },
    PROCESSING: { label: "Processing", sub: "Enqueuing document in extraction pipeline...", color: "var(--primary-action)", pct: 20 },
    EXTRACTING_TEXT: { label: "Extracting Text", sub: "Reading PDF pages and extracting raw text...", color: "var(--primary-action)", pct: 33 },
    IDENTIFYING_FORMAT: { label: "Identifying Format", sub: "Matching statement format in database...", color: "var(--primary-action)", pct: 55 },
    PARSING_TRANSACTIONS: { label: "Parsing Transactions", sub: "Running Code + LLM extraction pipeline...", color: "var(--primary-action)", pct: 78 },
    PARSING_TRANSACTIONS_CODE: { label: "Extracting Transactions", sub: "Format found in DB — using stored extraction logic (fast path)...", color: "var(--accent-color)", pct: 68 },
    AWAITING_REVIEW: { label: "Finalizing", sub: "Validating transactions and preparing review...", color: "var(--accent-color)", pct: 100 },
    ERROR: { label: "Extraction Failed", sub: "Please check the file if it's protected or corrupted.", color: "#F87171", pct: 100 },
    FAILED: { label: "Extraction Failed", sub: "Please check the file if it's protected or corrupted.", color: "#F87171", pct: 100 },
};

function CircularProgress({ processingStatus, status, elapsedSeconds, parsedType, pipelineError }) {
    let currentKey = processingStatus || status;
    if (currentKey === "PARSING_TRANSACTIONS" && parsedType === "CODE") {
        currentKey = "PARSING_TRANSACTIONS_CODE";
    }
    
    // Create a copy of the meta so we can safely modify it if needed
    const meta = { ...(STAGE_META[currentKey] || STAGE_META["PROCESSING"]) };
    
    if (pipelineError && pipelineError.includes("Incorrect PDF password")) {
        meta.sub = "Incorrect Password, Please Try Again.";
    }
    
    // Simulate a sub-process percentage that climbs but never hits 100% prematurely
    const [subPct, setSubPct] = useState(0);
    
    useEffect(() => {
        setSubPct(0);
        let current = 0;
        const speed = currentKey === "PARSING_TRANSACTIONS" ? 1500 : 800; // Slower for heavy tasks
        
        const interval = setInterval(() => {
            setSubPct(prev => {
                // Logarithmic-style growth: the closer to 100, the slower it gets
                const remaining = 100 - prev;
                const increment = Math.max(0.1, remaining / 15);
                const next = prev + increment;
                return next > 98.5 ? 98.5 : next; // Cap at 98.5% until status changes
            });
        }, speed);
        return () => clearInterval(interval);
    }, [currentKey]);

    return (
        <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", padding: "1.5rem 1rem", gap: "1rem",
            background: "var(--bg-primary)",
            borderRadius: "16px", border: "1px solid var(--border-color)",
            margin: "0.5rem 0"
        }}>
            <div style={{ position: "relative", width: 100, height: 100 }}>
                <svg width="100" height="100" style={{ transform: "rotate(-90deg)" }}>
                    <circle cx="50" cy="50" r={42} fill="none" stroke="rgba(0,0,0,0.05)" strokeWidth="8" />
                    <circle
                        cx="50" cy="50" r={42}
                        fill="none"
                        stroke={meta.color}
                        strokeWidth="8"
                        strokeLinecap="round"
                        strokeDasharray={2 * Math.PI * 42}
                        strokeDashoffset={2 * Math.PI * 42 - (meta.pct / 100) * 2 * Math.PI * 42}
                        style={{ transition: "stroke-dashoffset 0.8s ease" }}
                    />
                </svg>
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: "1.1rem", fontWeight: 800, color: "var(--text-primary)" }}>{meta.pct}%</span>
                </div>
            </div>
            <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.9rem", fontWeight: 800, color: "var(--text-primary)" }}>{meta.label}</div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", maxWidth: 280 }}>
                    {!(currentKey === "ERROR" || currentKey === "FAILED") && (
                        <span style={{ fontWeight: 700, color: "var(--primary-action)", marginRight: '4px' }}>
                            ({Math.round(subPct)}% completed)
                        </span>
                    )}
                    {meta.sub}
                </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.7rem", color: "var(--text-secondary)" }}>
                <Clock size={12} /> {elapsedSeconds}s {currentKey === "ERROR" || currentKey === "FAILED" ? "remaining" : "elapsed"}
            </div>
        </div>
    );
}

export default function ParsingPage() {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const { activeDoc, isExtracting, startExtraction, clearActiveDoc, maxStepReached } = useParsing();

    const [file, setFile] = useState(null);
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [needsPassword, setNeedsPassword] = useState(false);
    const [pdfType, setPdfType] = useState(null);
    const [status, setStatus] = useState("IDLE");
    const [error, setError] = useState("");
    const fileInputRef = useRef(null);

    const [stats, setStats] = useState({ total: 0, parsed: 0, failed: 0, pending_review: 0 });
    const [recentDocs, setRecentDocs] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [sortOption, setSortOption] = useState("Newest first");
    const [isSortOpen, setIsSortOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [isDeleting, setIsDeleting] = useState(false);

    // Pagination & Filter State — page stored in URL so back button restores it
    const currentPage = parseInt(searchParams.get('page') || '1', 10);
    const setCurrentPage = (page) => {
        const p = typeof page === 'function' ? page(currentPage) : page;
        setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('page', String(p)); return n; }, { replace: true });
    };
    const pageSize = 8;
    const [totalResults, setTotalResults] = useState(0);
    const [searchTerm, setSearchTerm] = useState("");
    
    const totalPages = Math.ceil((totalResults || 0) / pageSize);



    const sortOptions = ["Newest first", "Oldest first", "Last activity", "Alphabetically"];

    useEffect(() => {
        const timer = setTimeout(() => {
            fetchData(currentPage);
        }, 300);
        return () => clearTimeout(timer);
    }, [currentPage, sortOption, searchTerm]);

    useEffect(() => {
        if (!isExtracting && activeDoc?.status === "DONE") {
            fetchData(currentPage);
        }
    }, [isExtracting, activeDoc]);

    const fetchData = async (page = 1) => {
        setIsLoading(true);
        try {
            let sortParam = "newest";
            if (sortOption === "Oldest first") sortParam = "oldest";
            if (sortOption === "Alphabetically") sortParam = "alpha";

            const params = {
                page,
                limit: pageSize,
                sort: sortParam,
                search: searchTerm || undefined
            };

            const [statsRes, recentRes] = await Promise.all([
                API.get("/documents/stats"),
                API.get("/documents/recent", { params })
            ]);
            
            setStats(statsRes.data);
            setRecentDocs(recentRes.data.data);
            setTotalResults(recentRes.data.total);
            

        } catch (err) {
            console.error("Failed to fetch dashboard data", err);
        } finally {
            setIsLoading(false);
        }
    };



    const handleSortChange = (opt) => {
        setSortOption(opt);
        setCurrentPage(1); // Reset to first page on sort change
        setIsSortOpen(false);
    };

    const handleDeleteDocument = (docId, fileName) => {
        setDeleteTarget({ id: docId, name: fileName });
    };

    const confirmDelete = async () => {
        if (!deleteTarget || isDeleting) return;
        const { id, name } = deleteTarget;
        setIsDeleting(true);
        setError("");

        try {
            await API.delete(`/documents/${id}`);
            setRecentDocs(prev => prev.filter(d => d.document_id !== id));
            const statsRes = await API.get("/documents/stats");
            setStats(statsRes.data);
            setDeleteTarget(null);
        } catch (err) {
            console.error("Delete failed", err);
            if (err.response?.status === 404) {
                setRecentDocs(prev => prev.filter(d => d.document_id !== id));
                setDeleteTarget(null);
            } else {
                alert("Failed to delete document: " + (err.response?.data?.detail || err.message));
                setDeleteTarget(null);
            }
        } finally {
            setIsDeleting(false);
        }
    };

    const getStepState = (idx) => {
        if (!activeDoc) return "pending";
        const currentStatus = activeDoc.processingStatus || activeDoc.status;
        if (["DONE", "APPROVE", "POSTED"].includes(currentStatus)) return "completed";

        if (idx < maxStepReached) return "completed";
        if (idx === maxStepReached) return "active";
        return "pending";
    };

    const onFileChange = async (e) => {
        const selectedFile = e.target.files[0];
        if (!selectedFile) return;
        setFile(selectedFile);
        setError("");
        setPdfType(null);
        setNeedsPassword(false);
        setShowPassword(false);
        setStatus("DETECTING");

        const formData = new FormData();
        formData.append("file", selectedFile);
        try {
            const res = await API.post("/documents/verify-type", formData);
            const type = res.data.pdf_type;
            setPdfType(type);
            if (type === "PASSWORD_TEXT_PDF") {
                setNeedsPassword(true);
                setStatus("PASSWORD_REQUIRED");
                setError("Password required.");
            } else if (type === "CORRUPTED_PDF" || type === "RESTRICTED_PDF") {
                setStatus("ERROR");
                setError("File is invalid or restricted.");
            } else {
                setStatus("DETECTED");
            }
        } catch (err) {
            setStatus("ERROR");
            setError("Detection failed.");
        }
    };

    const handleUpload = async () => {
        if (!file) return;
        try {
            await startExtraction(file, password);
        } catch (err) {
            setError(err.message || "Upload failed.");
        }
    };

    const getIcon = (name) => {
        const iconMap = { FileUp, Clock, List, Search, Cpu, CheckCircle };
        const IconComp = iconMap[name] || FileText;
        return <IconComp size={14} />;
    };

    return (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} style={{ padding: '32px 40px' }}>
            <div className="overview-header">
                <h1>Parsing</h1>
            </div>

            <div className="upload-page-card" style={{
                background: 'var(--bg-secondary)',
                padding: '2.5rem 2rem',
                borderRadius: '16px',
                marginBottom: '2.5rem',
                border: '1px solid var(--border-color)',
                maxWidth: '860px',
                margin: '0 auto 2.5rem',
                position: 'relative'
            }}>
                {activeDoc && (
                    <div style={{ marginBottom: '1.5rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '1.5rem' }}>
                            {extractionSteps.map((step, i) => {
                                const state = getStepState(i);
                                return (
                                    <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, position: 'relative' }}>
                                        <div style={{
                                            width: 28, height: 28, borderRadius: '50%',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            background: state === 'completed' ? 'var(--accent-color)' : state === 'active' ? 'var(--primary-action)' : 'rgba(0,0,0,0.05)',
                                            color: state === 'pending' ? 'var(--text-secondary)' : 'white',
                                            marginBottom: '0.4rem', zIndex: 1, transition: 'all 0.3s'
                                        }}>
                                            {state === 'completed' ? <CheckCircle size={14} /> : state === 'active' ? <Loader2 size={14} className="spin-icon" /> : getIcon(step.icon)}
                                        </div>
                                        <span style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-primary)', textAlign: 'center' }}>{step.label}</span>
                                        {i < extractionSteps.length - 1 && (
                                            <div style={{ position: 'absolute', top: 14, left: '50%', width: '100%', height: 2, background: state === 'completed' ? 'var(--accent-color)' : 'rgba(0,0,0,0.05)', zIndex: 0 }} />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        {isExtracting && (
                            <CircularProgress
                                processingStatus={activeDoc.processingStatus}
                                status={activeDoc.status}
                                elapsedSeconds={activeDoc.elapsedSeconds}
                                parsedType={activeDoc.parsedType}
                                pipelineError={activeDoc.pipelineError}
                            />
                        )}
                        {!isExtracting && activeDoc.status === "DONE" && (
                            <div style={{ textAlign: "center", padding: "1rem", background: "rgba(127, 175, 138, 0.1)", borderRadius: "12px", border: "1px solid var(--accent-color)" }}>
                                <div style={{ fontWeight: 800, color: "var(--accent-color)" }}>Ready for Review!</div>
                                <button onClick={() => { navigate(`/review?id=${activeDoc.id}`); clearActiveDoc(); }} style={{ marginTop: "0.5rem", background: "var(--accent-color)", color: "#fff", border: "none", padding: "0.5rem 1rem", borderRadius: "8px", fontWeight: 700, cursor: "pointer" }}>Open Transactions</button>
                            </div>
                        )}
                    </div>
                )}

                {!isExtracting && (!activeDoc || activeDoc.status !== "DONE") && (
                    <>
                        <div className="dropzone"
                            onClick={() => fileInputRef.current.click()}
                            style={{
                                minHeight: '180px',
                                border: '2px dashed var(--border-color)',
                                borderRadius: '12px',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: '1.5rem',
                                transition: 'all 0.2s ease',
                                background: file ? 'rgba(99, 102, 241, 0.03)' : 'transparent',
                                cursor: 'pointer'
                            }}
                        >
                            <input type="file" hidden ref={fileInputRef} onChange={onFileChange} accept=".pdf" />

                            {!file ? (
                                <div style={{ textAlign: 'center' }}>
                                    <FileUp size={40} style={{ color: 'var(--primary-action)', marginBottom: '0.75rem' }} />
                                    <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Choose PDF Statement</div>
                                    <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)' }}>Maximum 50MB per file</div>
                                </div>
                            ) : (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'var(--bg-primary)', padding: '10px 16px', borderRadius: '10px', border: '1px solid var(--border-color)', position: 'relative' }}>
                                    <FileText size={24} style={{ color: 'var(--primary-action)' }} />
                                    <div style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.9rem', fontWeight: 700 }}>{file.name}</div>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setFile(null); setPassword(""); setShowPassword(false); setStatus("IDLE"); setError(""); }}
                                        style={{ background: 'rgba(231, 76, 60, 0.1)', color: '#e74c3c', border: 'none', width: '24px', height: '24px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.2s' }}
                                        title="Remove this file"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            )}
                        </div>

                        {needsPassword && (
                            <div style={{ marginTop: '1.5rem' }}>
                                <label style={{ fontSize: '0.8rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}><Lock size={12} /> Password</label>
                                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                                    <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%', padding: '0.75rem', paddingRight: '40px', background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: '8px', boxSizing: 'border-box' }} />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        title={showPassword ? 'Hide password' : 'Show password'}
                                        style={{
                                            position: 'absolute',
                                            right: '12px',
                                            background: 'none',
                                            border: 'none',
                                            color: 'var(--text-secondary)',
                                            cursor: 'pointer',
                                            display: 'flex',
                                            alignItems: 'center',
                                            padding: 0
                                        }}
                                    >
                                        {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                                    </button>
                                </div>
                            </div>
                        )}

                        {error && <div style={{ marginTop: '1rem', color: '#e74c3c', fontSize: '0.8rem', fontWeight: 600 }}>{error}</div>}

                        <button
                            disabled={!file || status === "DETECTING" || (needsPassword && !password)}
                            onClick={handleUpload}
                            style={{
                                width: '100%',
                                height: '52px',
                                marginTop: '1.5rem',
                                borderRadius: '12px',
                                background: (file && status !== "DETECTING" && (!needsPassword || password)) ? 'var(--primary-action)' : '#e5e7eb',
                                color: 'white',
                                border: 'none',
                                fontWeight: 700,
                                cursor: (file && status !== "DETECTING" && (!needsPassword || password)) ? 'pointer' : 'not-allowed',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '8px'
                            }}
                        >
                            {status === "DETECTING" ? (
                                <>
                                    <Loader2 size={18} className="spin-icon" />
                                    CHECKING PDF...
                                </>
                            ) : (
                                "START EXTRACTION"
                            )}
                        </button>
                    </>
                )}
            </div>

            <div id="parsing-summary" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1.5rem', marginBottom: '3rem' }}>
                <div style={{ background: 'var(--card-bg)', borderRadius: '20px', padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1.25rem', border: '1px solid var(--border-color)', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' }}>
                    <div style={{ padding: '0.75rem', background: 'rgba(72, 62, 168, 0.08)', borderRadius: '14px', color: 'var(--primary-action)' }}>
                        <ScrollText size={24} />
                    </div>
                    <div>
                        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Total</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)' }}>{stats.total || 0}</div>
                    </div>
                </div>
                
                <div style={{ background: 'var(--card-bg)', borderRadius: '20px', padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1.25rem', border: '1px solid var(--border-color)', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' }}>
                    <div style={{ padding: '0.75rem', background: 'rgba(127, 175, 138, 0.1)', borderRadius: '14px', color: 'var(--accent-color)' }}>
                        <CheckCircle size={24} />
                    </div>
                    <div>
                        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Approved</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)' }}>{stats.parsed || 0}</div>
                    </div>
                </div>

                <div style={{ background: 'var(--card-bg)', borderRadius: '20px', padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1.25rem', border: '1px solid var(--border-color)', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' }}>
                    <div style={{ padding: '0.75rem', background: 'rgba(231, 76, 60, 0.1)', borderRadius: '14px', color: '#e74c3c' }}>
                        <AlertCircle size={24} />
                    </div>
                    <div>
                        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Failed</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)' }}>{stats.failed || 0}</div>
                    </div>
                </div>

                <div style={{ background: 'var(--card-bg)', borderRadius: '20px', padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1.25rem', border: '1px solid var(--border-color)', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' }}>
                    <div style={{ padding: '0.75rem', background: 'rgba(243, 156, 18, 0.1)', borderRadius: '14px', color: '#f39c12' }}>
                        <Clock size={24} />
                    </div>
                    <div>
                        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Pending Approval</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)' }}>{stats.pending_review || 0}</div>
                    </div>
                </div>
            </div>

            {/* Sort and Search Only */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', gap: '1.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', position: 'relative' }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Sort:</span>
                    <div
                        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem', cursor: 'pointer', fontWeight: 700, color: 'var(--primary-action)' }}
                        onClick={() => setIsSortOpen(!isSortOpen)}
                    >
                        {sortOption} <ChevronDown size={14} />
                    </div>
                    {isSortOpen && (
                        <div style={{
                            position: 'absolute',
                            top: '100%',
                            left: '40px',
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border-color)',
                            borderRadius: '8px',
                            boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
                            zIndex: 10,
                            width: '180px',
                            padding: '0.5rem 0',
                            marginTop: '0.5rem'
                        }}>
                            {sortOptions.map(opt => (
                                <div
                                    key={opt}
                                    onClick={() => handleSortChange(opt)}
                                    style={{
                                        padding: '0.6rem 1rem',
                                        fontSize: '0.8rem',
                                        cursor: 'pointer',
                                        background: sortOption === opt ? 'var(--bg-primary)' : 'transparent',
                                        color: sortOption === opt ? 'var(--primary-action)' : 'var(--text-secondary)',
                                        fontWeight: sortOption === opt ? 700 : 500
                                    }}
                                >
                                    {opt}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div style={{ position: 'relative', flex: 1, maxWidth: '400px' }}>
                    <Search style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} size={16} />
                    <input
                        type="text"
                        placeholder="Search by bank or filename..."
                        value={searchTerm}
                        onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                        style={{
                            width: '100%',
                            padding: '0.6rem 1rem 0.6rem 2.5rem',
                            borderRadius: '10px',
                            border: '1px solid var(--border-color)',
                            background: 'var(--bg-primary)',
                            fontSize: '0.875rem',
                            color: 'var(--text-primary)',
                            outline: 'none',
                            transition: 'all 0.2s'
                        }}
                        onFocus={(e) => e.target.style.borderColor = 'var(--primary-action)'}
                        onBlur={(e) => e.target.style.borderColor = 'var(--border-color)'}
                    />
                </div>
            </div>

            <div style={{ background: 'var(--bg-secondary)', borderRadius: '16px', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr style={{ background: 'var(--bg-primary)', fontSize: '0.75rem', color: 'var(--text-secondary)' }}><th style={{ padding: '1rem 2rem', textAlign: 'left' }}>File Name</th><th style={{ padding: '1rem' }}>Status</th><th style={{ padding: '1rem' }}>Type</th><th style={{ padding: '1rem' }}>Activity</th><th style={{ padding: '1rem 2rem' }}>Actions</th></tr></thead>
                    <tbody>
                        {isLoading ? <tr><td colSpan="5" style={{ textAlign: 'center', padding: '2rem' }}><Loader2 className="spin-icon" size={24} color="#483EA8" /></td></tr> : recentDocs.map(doc => (
                            <tr key={doc.document_id} style={{ borderTop: '1px solid var(--border-color)', fontSize: '0.9rem' }}>
                                <td style={{ padding: '1rem 2rem' }}><div><b>{doc.file_name}</b></div><div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{doc.institution_name || 'Generic PDF'}</div></td>
                                <td style={{ textAlign: 'center' }}>
                                    <span style={{
                                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                        padding: '4px 12px', borderRadius: '20px',
                                        background: doc.status === 'APPROVE' ? 'rgba(127, 175, 138, 0.15)' : 'rgba(243, 156, 18, 0.1)',
                                        color: doc.status === 'APPROVE' ? 'var(--accent-color)' : '#92400e',
                                        fontSize: '0.7rem', fontWeight: 800,
                                        gap: '4px'
                                    }}>
                                        {doc.status === 'APPROVE' ? <><CheckCircle size={12} /> Approved</> : <><div style={{ width: 6, height: 6, borderRadius: '50%', background: '#f39c12' }} /> Pending approval</>}
                                    </span>
                                </td>
                                <td style={{ textAlign: 'center' }}><span style={{
                                    background: 'rgba(72, 62, 168, 0.08)',
                                    color: 'var(--primary-action)',
                                    padding: '4px 10px',
                                    borderRadius: '8px',
                                    fontSize: '0.7rem',
                                    fontWeight: 800,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    border: '1px solid rgba(72, 62, 168, 0.2)'
                                }}>
                                    <Code size={12} /> {doc.transaction_parsed_type || 'CODE'}
                                </span></td>
                                <td style={{ textAlign: 'center', fontSize: '0.8rem' }}>{formatDate(doc.created_at)}</td>
                                <td style={{ textAlign: 'center', padding: '1rem 2rem' }}>
                                    <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'center' }}>
                                        <button
                                            onClick={() => { navigate(`/review?id=${doc.document_id}`); clearActiveDoc(); }}
                                            style={{
                                                background: 'none',
                                                border: '1px solid var(--border-color)',
                                                padding: '6px 12px',
                                                borderRadius: '8px',
                                                fontSize: '0.75rem',
                                                color: 'var(--primary-action)',
                                                fontWeight: 700,
                                                cursor: 'pointer',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '6px',
                                                transition: 'all 0.2s'
                                            }}
                                        >
                                            <TableIcon size={14} /> Transactions
                                        </button>

                                        {doc.status !== 'APPROVE' && (
                                            <button
                                                onClick={() => handleDeleteDocument(doc.document_id, doc.file_name)}
                                                style={{
                                                    background: 'rgba(231, 76, 60, 0.05)',
                                                    border: '1px solid #fecaca',
                                                    padding: '6px 10px',
                                                    borderRadius: '8px',
                                                    color: '#e74c3c',
                                                    cursor: 'pointer',
                                                    transition: 'all 0.2s',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center'
                                                }}
                                                onMouseOver={(e) => e.currentTarget.style.transform = 'scale(1.1)'}
                                                onMouseOut={(e) => e.currentTarget.style.transform = 'scale(1)'}
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
                <div style={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    gap: '0.5rem',
                    marginTop: '2rem',
                    marginBottom: '2rem'
                }}>
                    <button
                        disabled={currentPage === 1 || isLoading}
                        onClick={() => setCurrentPage(prev => prev - 1)}
                        style={{
                            padding: '8px 16px',
                            borderRadius: '8px',
                            border: '1px solid var(--border-color)',
                            background: 'var(--bg-secondary)',
                            color: currentPage === 1 ? 'var(--text-secondary)' : 'var(--primary-action)',
                            fontWeight: 700,
                            cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                            opacity: currentPage === 1 ? 0.5 : 1,
                            transition: 'all 0.2s',
                            fontSize: '0.8rem'
                        }}
                    >
                        Previous
                    </button>

                    <div style={{ display: 'flex', gap: '4px' }}>
                        {[...Array(totalPages)].map((_, i) => {
                            const p = i + 1;
                            // Basic pagination logic: show first, last, and around current
                            if (
                                p === 1 || 
                                p === totalPages || 
                                (p >= currentPage - 1 && p <= currentPage + 1)
                            ) {
                                return (
                                    <button
                                        key={p}
                                        onClick={() => setCurrentPage(p)}
                                        style={{
                                            width: '36px',
                                            height: '36px',
                                            borderRadius: '8px',
                                            border: '1px solid var(--border-color)',
                                            background: currentPage === p ? 'var(--primary-action)' : 'var(--bg-secondary)',
                                            color: currentPage === p ? 'white' : 'var(--text-primary)',
                                            fontWeight: 700,
                                            cursor: 'pointer',
                                            transition: 'all 0.2s'
                                        }}
                                    >
                                        {p}
                                    </button>
                                );
                            } else if (
                                (p === 2 && currentPage > 3) || 
                                (p === totalPages - 1 && currentPage < totalPages - 2)
                            ) {
                                return <span key={p} style={{ padding: '8px', color: 'var(--text-secondary)' }}>...</span>;
                            }
                            return null;
                        })}
                    </div>

                    <button
                        disabled={currentPage === totalPages || isLoading}
                        onClick={() => setCurrentPage(prev => prev + 1)}
                        style={{
                            padding: '8px 16px',
                            borderRadius: '8px',
                            border: '1px solid var(--border-color)',
                            background: 'var(--bg-secondary)',
                            color: currentPage === totalPages ? 'var(--text-secondary)' : 'var(--primary-action)',
                            fontWeight: 700,
                            cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
                            opacity: currentPage === totalPages ? 0.5 : 1,
                            transition: 'all 0.2s',
                            fontSize: '0.8rem'
                        }}
                    >
                        Next
                    </button>
                </div>
            )}

            {/* Custom Styled Delete Confirmation Modal */}
            {deleteTarget && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 11000 }}>
                    <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} style={{ background: 'var(--bg-secondary)', padding: '2.5rem', borderRadius: '24px', border: '1px solid var(--glass-border)', maxWidth: '420px', width: '90%', textAlign: 'center', boxShadow: '0 25px 60px -12px rgba(0,0,0,0.4)' }}>
                        <div style={{ width: '64px', height: '64px', borderRadius: '20px', background: 'rgba(166, 61, 64, 0.1)', color: 'var(--error)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
                            <Trash2 size={32} />
                        </div>
                        <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '0.75rem' }}>Delete Document?</h3>
                        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '2.5rem', lineHeight: 1.6 }}>
                            Are you sure you want to delete <br />
                            <b style={{
                                color: 'var(--primary-action)',
                                display: 'block',
                                margin: '8px 0',
                                overflowWrap: 'anywhere',
                                wordBreak: 'break-word',
                                padding: '0 10px'
                            }}>
                                "{deleteTarget.name}"?
                            </b>
                            This action will permanently remove all associated transactions.
                        </p>
                        <div style={{ display: 'flex', gap: '1rem' }}>
                            <button
                                onClick={() => setDeleteTarget(null)}
                                disabled={isDeleting}
                                style={{ flex: 1, padding: '0.875rem', borderRadius: '12px', border: '1px solid var(--glass-border)', background: 'var(--bg-primary)', fontWeight: 700, cursor: isDeleting ? 'not-allowed' : 'pointer', color: 'var(--text-secondary)', transition: 'all 0.2s', opacity: isDeleting ? 0.5 : 1 }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmDelete}
                                disabled={isDeleting}
                                style={{
                                    flex: 1,
                                    padding: '0.875rem',
                                    borderRadius: '12px',
                                    border: 'none',
                                    background: isDeleting ? '#fecaca' : 'var(--error)',
                                    color: 'white',
                                    fontWeight: 700,
                                    cursor: isDeleting ? 'not-allowed' : 'pointer',
                                    boxShadow: isDeleting ? 'none' : '0 4px 12px rgba(166, 61, 64, 0.2)',
                                    transition: 'all 0.2s',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '8px'
                                }}
                            >
                                {isDeleting ? (
                                    <>
                                        <Loader2 size={18} className="spin-icon" />
                                        DELETING...
                                    </>
                                ) : (
                                    "Delete Document"
                                )}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}


        </motion.div>
    );
}