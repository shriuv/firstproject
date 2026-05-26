import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import API from '../api/api';

// const ParsingContext = createContext();
const ParsingContext = createContext();
export const useParsing = () => useContext(ParsingContext);

// Step definition logic — moved to context for consistency
export const extractionSteps = [
    { label: "Upload", icon: "FileUp", statuses: ["UPLOADED", "UPLOADING", "PROCESSING"] },
    { label: "Text Extraction", icon: "List", statuses: ["EXTRACTING_TEXT"] },
    { label: "Identification", icon: "Search", statuses: ["IDENTIFYING_FORMAT"] },
    { label: "Analysis", icon: "Cpu", statuses: ["PARSING_TRANSACTIONS", "PARSING_TRANSACTIONS_CODE"] },
    { label: "Ready", icon: "CheckCircle", statuses: ["AWAITING_REVIEW", "DONE", "APPROVE", "POSTED"] },
];

export const ParsingProvider = ({ children }) => {
    const [activeDoc, setActiveDoc] = useState(null);
    const [isExtracting, setIsExtracting] = useState(false);
    const [latestFinishedDocId, setLatestFinishedDocId] = useState(null);
    const [maxStepReached, setMaxStepReached] = useState(-1);

    const [notification, setNotification] = useState(null);

    const pollRef = useRef(null);
    const timerRef = useRef(null);

    useEffect(() => {
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, []);

    const startExtraction = async (file, password = "") => {
        setIsExtracting(true);
        setMaxStepReached(0); // Start at step 0
        setActiveDoc({
            id: null,
            name: file.name,
            status: "UPLOADING",
            processingStatus: "UPLOADING",
            elapsedSeconds: 0,
            parsedType: null
        });

        const formData = new FormData();
        formData.append("file", file);
        if (password) formData.append("password", password);

        try {
            const res = await API.post("/documents/upload", formData);
            const docId = res.data.document_id;
            setActiveDoc(prev => ({ ...prev, id: docId, status: "PROCESSING" }));

            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = setInterval(() => {
                setActiveDoc(prev => {
                    if (!prev) return null;
                    if (prev.status === "ERROR" || prev.status === "FAILED" || prev.processingStatus === "FAILED") {
                        const nextSec = prev.elapsedSeconds - 1;
                        if (nextSec <= 0) {
                            setIsExtracting(false);
                            if (timerRef.current) {
                                clearInterval(timerRef.current);
                                timerRef.current = null;
                            }
                            return null;
                        }
                        return { ...prev, elapsedSeconds: nextSec };
                    }
                    return { ...prev, elapsedSeconds: prev.elapsedSeconds + 1 };
                });
            }, 1000);

            startPolling(docId, file.name);

        } catch (err) {
            setIsExtracting(false);
            setActiveDoc(null);
            setMaxStepReached(-1);
            throw err;
        }
    };

    const startPolling = (docId, fileName) => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
            try {
                const statusRes = await API.get(`/documents/status/${docId}`);
                const { status: docStatus, transaction_parsed_type: docParsedType, pipeline_error: pipelineError } = statusRes.data;

                setActiveDoc(prev => {
                    const newDoc = {
                        ...prev,
                        processingStatus: docStatus,
                        parsedType: docParsedType || prev?.parsedType,
                        pipelineError: pipelineError
                    };

                    // Update global progress gate
                    const stepIdx = extractionSteps.findIndex(s => s.statuses.includes(docStatus));
                    if (stepIdx > maxStepReached) {
                        setMaxStepReached(stepIdx);
                    }

                    return newDoc;
                });

                if (["AWAITING_REVIEW", "APPROVE", "POSTED", "DONE"].includes(docStatus)) {
                    stopPolling(docId, "DONE");
                    setNotification({
                        type: 'success',
                        title: 'Extraction Complete',
                        message: `Transactions for "${fileName}" have been extracted successfully.`,
                        docId: docId
                    });
                } else if (docStatus === "FAILED") {
                    if (pollRef.current) {
                        clearInterval(pollRef.current);
                        pollRef.current = null;
                    }
                    setLatestFinishedDocId(docId);
                    setActiveDoc(prev => prev ? { 
                        ...prev, 
                        status: "ERROR", 
                        processingStatus: "FAILED",
                        pipelineError: pipelineError,
                        elapsedSeconds: Math.max(5, prev.elapsedSeconds)
                    } : null);
                    
                    const isIncorrectPassword = pipelineError && pipelineError.includes("Incorrect PDF password");
                    if (!isIncorrectPassword) {
                        setNotification({
                            type: 'error',
                            title: 'Extraction Failed',
                            message: `Failed to process "${fileName}". Please check the file if it's protected or corrupted.`,
                            docId: docId
                        });
                    }
                }
            } catch (err) {
                console.error("Polling error", err);
            }
        }, 2000);
    };

    const retryExtraction = (docId, fileName) => {
        setIsExtracting(true);
        setMaxStepReached(0);
        setActiveDoc({
            id: docId,
            name: fileName,
            status: "PROCESSING",
            processingStatus: "UPLOADED",
            elapsedSeconds: 0,
            parsedType: null
        });

        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
            setActiveDoc(prev => {
                if (!prev) return null;
                if (prev.status === "ERROR" || prev.status === "FAILED" || prev.processingStatus === "FAILED") {
                    const nextSec = prev.elapsedSeconds - 1;
                    if (nextSec <= 0) {
                        setIsExtracting(false);
                        if (timerRef.current) {
                            clearInterval(timerRef.current);
                            timerRef.current = null;
                        }
                        return null;
                    }
                    return { ...prev, elapsedSeconds: nextSec };
                }
                return { ...prev, elapsedSeconds: prev.elapsedSeconds + 1 };
            });
        }, 1000);

        startPolling(docId, fileName);
    };

    const stopPolling = (docId, finalStatus) => {
        if (pollRef.current) clearInterval(pollRef.current);
        if (timerRef.current) clearInterval(timerRef.current);
        setIsExtracting(false);
        setLatestFinishedDocId(docId);
        setActiveDoc(prev => prev ? { ...prev, status: finalStatus } : null);
    };

    const clearActiveDoc = () => {
        setActiveDoc(null);
        setIsExtracting(false);
        setMaxStepReached(-1);
    };

    return (
        <ParsingContext.Provider value={{
            activeDoc,
            isExtracting,
            latestFinishedDocId,
            startExtraction,
            retryExtraction,
            clearActiveDoc,
            setLatestFinishedDocId,
            notification,
            setNotification,
            maxStepReached
        }}>
            {children}
            <NotificationPortal notification={notification} onClose={() => setNotification(null)} />
        </ParsingContext.Provider>
    );
};

const NotificationPortal = ({ notification, onClose }) => {
    const navigate = useNavigate();
    
    useEffect(() => {
        if (!notification) return;
        
        // Auto-dismiss after 2 seconds (matches user request)
        const timer = setTimeout(() => {
            onClose();
        }, 2000);
        
        return () => clearTimeout(timer);
    }, [notification, onClose]);

    if (!notification) return null;

    const handleAction = () => {
        if (notification.type === 'success' && notification.docId) {
            navigate(`/review/${notification.docId}`);
        }
        onClose();
    };

    const accentColor = notification.type === 'success' ? '#10B981' : '#F87171';

    return (
        <div 
            onClick={handleAction}
            style={{
                position: 'fixed',
                bottom: '20px',
                right: '20px',
                zIndex: 9999,
                cursor: 'pointer',
                animation: 'slideInNotif 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards',
            }}
        >
            <div style={{
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--glass-border)',
                borderLeft: `4px solid ${accentColor}`,
                borderRadius: '12px',
                padding: '16px',
                minWidth: '320px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.3)',
            }}>
                <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)', marginBottom: '2px' }}>
                        {notification.title}
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.4, opacity: 0.75 }}>
                        {notification.message}
                    </div>
                </div>
                <button
                    onClick={(e) => { e.stopPropagation(); onClose(); }}
                    style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        fontSize: '18px',
                        padding: '0 0 0 8px',
                        display: 'flex',
                        alignItems: 'center',
                        flexShrink: 0,
                    }}
                >
                    ✕
                </button>
            </div>
            <style>{`
                @keyframes slideInNotif {
                    from { opacity: 0; transform: translateX(400px); }
                    to   { opacity: 1; transform: translateX(0); }
                }
            `}</style>
        </div>
    );
};