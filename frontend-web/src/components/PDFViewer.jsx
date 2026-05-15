import { useState, useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, Loader2, FileX, ZoomIn, ZoomOut, Eye } from "lucide-react";
import API from "../api/api";

/**
 * PdfViewer
 * ──────────
 * Renders actual PDF pages as images (via backend render endpoint) and
 * overlays rubber-binding bounding boxes for each extracted transaction.
 *
 * Props:
 *   documentId       - number
 *   transactions     - array of txns with bbox:[x0,y0,x1,y1] and page:number
 *   pageCount        - total pages from pdf-map response
 *   selectedTxnIndex - currently selected transaction index (or null)
 *   onSelectTxn      - callback(index) when user clicks a highlight
 *   hoveredTxnIndex  - currently hovered transaction index (or null)
 *   onHoverTxn       - callback(index|null) when hovering a highlight
 */
export default function PDFViewer({
    documentId,
    transactions = [],
    pageCount = 0,
    selectedTxnIndex = null,
    onSelectTxn,
    hoveredTxnIndex = null,
    onHoverTxn,
    hidePageCount = false,
}) {
    const [currentPage, setCurrentPage] = useState(1);
    const [pageCache, setPageCache] = useState({}); // { pageNum: { image_b64, width, height } }
    const [loadingPage, setLoadingPage] = useState(false);
    const [pageError, setPageError] = useState(null);
    const [zoom, setZoom] = useState(1.0);
    const canvasRef = useRef(null);
    const containerRef = useRef(null);
    const selectedBboxRef = useRef(null);

    // Derive page from selected transaction
    useEffect(() => {
        if (selectedTxnIndex !== null && transactions[selectedTxnIndex]?.page) {
            const p = transactions[selectedTxnIndex].page;
            if (p !== currentPage) setCurrentPage(p);
        }
    }, [selectedTxnIndex]);

    // Scroll selected transaction into view
    useEffect(() => {
        if (selectedBboxRef.current && containerRef.current) {
            setTimeout(() => {
                selectedBboxRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
            }, 100);
        }
    }, [selectedTxnIndex, currentPage, pageCache]);

    // Load page image
    useEffect(() => {
        if (!documentId || pageCount === 0) return;
        if (pageCache[currentPage]) return; // already cached

        setLoadingPage(true);
        setPageError(null);

        API.get(`/documents/${documentId}/pdf-page/${currentPage}`)
            .then(res => {
                setPageCache(prev => ({ ...prev, [currentPage]: res.data }));
            })
            .catch(err => {
                console.error("PDF page load error:", err);
                setPageError("Failed to load page.");
            })
            .finally(() => setLoadingPage(false));
    }, [documentId, currentPage, pageCount]);

    // Pre-fetch next page
    useEffect(() => {
        if (!documentId || pageCount === 0) return;
        const next = currentPage + 1;
        if (next <= pageCount && !pageCache[next]) {
            API.get(`/documents/${documentId}/pdf-page/${next}`)
                .then(res => setPageCache(prev => ({ ...prev, [next]: res.data })))
                .catch(() => {});
        }
    }, [currentPage, pageCount, documentId]);

    const pageData = pageCache[currentPage];

    // Bboxes that belong to the current page
    const currentPageTxns = transactions
        .map((txn, idx) => ({ txn, idx }))
        .filter(({ txn }) => txn.page === currentPage && Array.isArray(txn.bbox));

    // Scale factor: PDF coords → rendered image pixels
    // Backend renders at 300 DPI, so scale = 300/72 ≈ 4.166
    const PDF_DPI_SCALE = 300 / 72;

    const bboxToPixels = (bbox, imgW, imgH) => {
        // bbox is in PDF coordinate space (72 DPI)
        const [x0, y0, x1, y1] = bbox;
        return {
            left:   (x0 * PDF_DPI_SCALE) / imgW,
            top:    (y0 * PDF_DPI_SCALE) / imgH,
            right:  (x1 * PDF_DPI_SCALE) / imgW,
            bottom: (y1 * PDF_DPI_SCALE) / imgH,
        };
    };

    const canGoPrev = currentPage > 1;
    const canGoNext = currentPage < pageCount;

    if (!documentId) {
        return (
            <div style={styles.placeholder}>
                <FileX size={40} color="var(--text-secondary)" />
                <p style={{ color: "var(--text-secondary)", marginTop: "1rem", fontSize: "0.875rem" }}>
                    No document loaded
                </p>
            </div>
        );
    }

    if (pageCount === 0 && !loadingPage) {
        return (
            <div style={styles.placeholder}>
                <Loader2 size={32} className="spin-icon" color="var(--primary-action)" />
                <p style={{ color: "var(--text-secondary)", marginTop: "1rem", fontSize: "0.875rem" }}>
                    Loading PDF map…
                </p>
            </div>
        );
    }

    return (
        <div style={styles.wrapper}>
            {/* ── Toolbar ───────────────────────────────────────────── */}
            <div style={styles.toolbar}>
                <div style={styles.toolbarLeft}>
                    <Eye size={15} color="var(--primary-action)" />
                    <span style={styles.toolbarTitle}>PDF Viewer</span>
                    {!hidePageCount && <span style={styles.badge}>{pageCount} pages</span>}
                </div>

                <div style={styles.toolbarCenter}>
                    <button
                        style={styles.navBtn}
                        disabled={!canGoPrev}
                        onClick={() => setCurrentPage(p => p - 1)}
                        title="Previous page"
                    >
                        <ChevronLeft size={16} />
                    </button>
                    <span style={styles.pageLabel}>
                        Page <strong>{currentPage}</strong> of {pageCount}
                    </span>
                    <button
                        style={styles.navBtn}
                        disabled={!canGoNext}
                        onClick={() => setCurrentPage(p => p + 1)}
                        title="Next page"
                    >
                        <ChevronRight size={16} />
                    </button>
                </div>

                <div style={styles.toolbarRight}>
                    <button
                        style={styles.zoomBtn}
                        onClick={() => setZoom(z => Math.max(0.5, z - 0.15))}
                        title="Zoom out"
                    >
                        <ZoomOut size={14} />
                    </button>
                    <span style={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
                    <button
                        style={styles.zoomBtn}
                        onClick={() => setZoom(z => Math.min(3.0, z + 0.15))}
                        title="Zoom in"
                    >
                        <ZoomIn size={14} />
                    </button>
                </div>
            </div>

            {/* ── Page canvas ───────────────────────────────────────── */}
            <div ref={containerRef} style={styles.canvasWrapper}>
                {loadingPage && (
                    <div style={styles.loadOverlay}>
                        <Loader2 size={32} className="spin-icon" color="var(--primary-action)" />
                        <p style={{ color: "var(--text-secondary)", marginTop: "0.75rem", fontSize: "0.8rem" }}>
                            Loading page {currentPage}…
                        </p>
                    </div>
                )}

                {pageError && (
                    <div style={styles.errorState}>
                        <FileX size={32} color="#F87171" />
                        <p style={{ color: "#F87171", marginTop: "0.5rem", fontSize: "0.85rem" }}>{pageError}</p>
                    </div>
                )}

                {pageData && !loadingPage && (
                    <div style={{ position: "relative", display: "inline-block" }}>
                        {/* PDF page image */}
                        <img
                            src={`data:image/png;base64,${pageData.image_b64}`}
                            alt={`Page ${currentPage}`}
                            style={{
                                display: "block",
                                width: `${zoom * 100}%`,
                                minWidth: zoom > 1 ? `${zoom * 100}%` : undefined,
                                height: "auto",
                                objectFit: 'contain',
                                borderRadius: "4px",
                                boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
                                userSelect: "none",
                                transformOrigin: "top left",
                            }}
                            draggable={false}
                        />

                        {/* Bounding box overlays */}
                        {currentPageTxns.map(({ txn, idx }) => {
                            const rel = bboxToPixels(txn.bbox, pageData.width, pageData.height);
                            const isSelected = idx === selectedTxnIndex;
                            const isHovered = idx === hoveredTxnIndex;

                            const left   = rel.left   * 100;
                            const top    = rel.top    * 100;
                            const width  = (rel.right - rel.left)  * 100;
                            const height = (rel.bottom - rel.top)  * 100;

                            return (
                                <div
                                    key={idx}
                                    ref={isSelected ? selectedBboxRef : null}
                                    title={`${txn.date}  ${txn.details || ""}  ${txn.debit ? `Dr ₹${txn.debit}` : `Cr ₹${txn.credit}`}`}
                                    onClick={() => onSelectTxn && onSelectTxn(idx)}
                                    onMouseEnter={() => onHoverTxn && onHoverTxn(idx)}
                                    onMouseLeave={() => onHoverTxn && onHoverTxn(null)}
                                    style={{
                                        position: "absolute",
                                        left:   `${left}%`,
                                        top:    `${top}%`,
                                        width:  `${width}%`,
                                        height: `${height}%`,
                                        border: isSelected
                                            ? "2.5px solid transparent"
                                            : isHovered
                                                ? "2px solid transparent"
                                                : "1.5px solid transparent",
                                        background: isSelected
                                            ? "#FDFFB4"
                                            : isHovered
                                                ? "rgba(253, 255, 180, 0.7)"
                                                : "transparent",
                                        mixBlendMode: "multiply",
                                        borderRadius: "3px",
                                        cursor: "pointer",
                                        transition: "all 0.15s ease",
                                        zIndex: isSelected ? 10 : isHovered ? 9 : 5,
                                        boxShadow: "none",
                                    }}
                                >
                                    {/* Tiny label on selected */}
                                    {isSelected && (
                                        <div style={{
                                            position: "absolute",
                                            top: "-20px",
                                            left: 0,
                                            background: "#FDFFB4",
                                            color: "#1a1a2e",
                                            fontSize: "9px",
                                            fontWeight: 800,
                                            padding: "2px 6px",
                                            borderRadius: "3px",
                                            whiteSpace: "nowrap",
                                            pointerEvents: "none",
                                            letterSpacing: "0.3px",
                                            boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                                        }}>
                                            #{idx + 1} · {txn.date}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ── Match stats ───────────────────────────────────────── */}
            <div style={styles.footer}>
                <span style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
                    {currentPageTxns.length} transaction{currentPageTxns.length !== 1 ? "s" : ""} on this page
                </span>
                <span style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
                    {transactions.filter(t => t.bbox).length}/{transactions.length} matched
                </span>
            </div>
        </div>
    );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
    wrapper: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-primary)",
        borderRadius: "16px",
        border: "1px solid var(--border-color)",
        overflow: "hidden",
    },
    toolbar: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0.75rem 1rem",
        borderBottom: "1px solid var(--border-color)",
        background: "var(--card-bg)",
        gap: "0.5rem",
        flexShrink: 0,
    },
    toolbarLeft: {
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        flex: 1,
    },
    toolbarTitle: {
        fontWeight: 800,
        fontSize: "0.85rem",
        color: "var(--text-primary)",
    },
    badge: {
        background: "rgba(124, 58, 237, 0.1)",
        color: "#7C3AED",
        fontSize: "0.65rem",
        fontWeight: 700,
        padding: "2px 7px",
        borderRadius: "20px",
    },
    toolbarCenter: {
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
    },
    pageLabel: {
        fontSize: "0.8rem",
        color: "var(--text-primary)",
        minWidth: "110px",
        textAlign: "center",
    },
    toolbarRight: {
        display: "flex",
        alignItems: "center",
        gap: "0.35rem",
        flex: 1,
        justifyContent: "flex-end",
    },
    navBtn: {
        background: "none",
        border: "1px solid var(--border-color)",
        borderRadius: "8px",
        padding: "4px 8px",
        cursor: "pointer",
        color: "var(--text-primary)",
        display: "flex",
        alignItems: "center",
        transition: "all 0.15s",
    },
    zoomBtn: {
        background: "none",
        border: "1px solid var(--border-color)",
        borderRadius: "6px",
        padding: "4px 6px",
        cursor: "pointer",
        color: "var(--text-primary)",
        display: "flex",
        alignItems: "center",
        transition: "all 0.15s",
    },
    zoomLabel: {
        fontSize: "0.75rem",
        fontWeight: 700,
        color: "var(--text-secondary)",
        minWidth: "38px",
        textAlign: "center",
    },
    canvasWrapper: {
        flex: 1,
        height: "100%",
        overflow: "auto",
        padding: "0.25rem",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        background: "rgba(0,0,0,0.05)",
        position: "relative",
    },
    loadOverlay: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "300px",
    },
    errorState: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "300px",
    },
    placeholder: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: "300px",
    },
    footer: {
        display: "flex",
        justifyContent: "space-between",
        padding: "0.5rem 1rem",
        borderTop: "1px solid var(--border-color)",
        background: "var(--card-bg)",
        flexShrink: 0,
    },
};
