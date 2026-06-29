import React, { useState, useEffect } from 'react';

export default function App() {
  const [client, setClient] = useState(null);
  const [isZafMode, setIsZafMode] = useState(false);
  const [ticketId, setTicketId] = useState(null);
  const [ticketDetails, setTicketDetails] = useState(null);
  const [draft, setDraft] = useState('');
  const [confidence, setConfidence] = useState(0);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState('');
  const [standaloneTicketInput, setStandaloneTicketInput] = useState('1');
  const [debugInfo, setDebugInfo] = useState({
    zafSdkStatus: 'checking',
    url: typeof window !== 'undefined' ? window.location.href : '',
    zafError: null
  });

  // Backend host configuration (assumes Express running locally on port 3001 or live on Render)
  const BACKEND_HOST = import.meta.env.DEV
    ? 'http://localhost:3001'
    : 'https://intelligent-cx-triage-agent.onrender.com';

  // 1. Initialize ZAF Context
  useEffect(() => {
    const initZAF = () => {
      const zafSdkPresent = typeof window !== 'undefined' && !!window.ZAFClient;
      setDebugInfo(prev => ({
        ...prev,
        zafSdkStatus: zafSdkPresent ? 'loaded' : 'missing',
        url: typeof window !== 'undefined' ? window.location.href : ''
      }));

      if (zafSdkPresent) {
        try {
          const zClient = window.ZAFClient.init();
          setClient(zClient);
          setIsZafMode(true);
          
          zClient.invoke('resize', { width: '100%', height: '480px' });
          
          // Fetch ticket context from Zendesk
          zClient.get('ticket').then((data) => {
            const id = data.ticket.id;
            setTicketId(id);
            fetchTicketData(id);
          }).catch((err) => {
            console.error('Failed to get ticket context from ZAF:', err);
            setError('Failed to fetch ticket context from Zendesk.');
            setDebugInfo(prev => ({ ...prev, zafError: err.message }));
            setLoading(false);
          });
        } catch (initErr) {
          console.error('ZAF Client init failed:', initErr);
          setDebugInfo(prev => ({ ...prev, zafError: initErr.message }));
          fallbackToStandalone();
        }
      } else {
        fallbackToStandalone();
      }
    };

    const fallbackToStandalone = () => {
      setIsZafMode(false);
      setTicketId(1);
      fetchTicketData(1);
    };

    initZAF();
  }, []);

  // Fetch ticket details and draft response from our backend server
  const fetchTicketData = async (id) => {
    setLoading(true);
    setError(null);
    setSuccessMsg('');
    try {
      // Fetch ticket info and draft response concurrently in parallel
      const [ticketRes, draftRes] = await Promise.all([
        fetch(`${BACKEND_HOST}/api/tickets/${id}`),
        fetch(`${BACKEND_HOST}/api/tickets/${id}/draft`)
      ]);

      if (!ticketRes.ok) {
        throw new Error(`Ticket #${id} not found in database. Try running a query on the Dev Console first.`);
      }
      const ticketData = await ticketRes.json();
      setTicketDetails(ticketData);
      
      // Parse tags
      let parsedTags = [];
      try {
        parsedTags = typeof ticketData.tags === 'string' ? JSON.parse(ticketData.tags) : ticketData.tags;
      } catch (e) {
        parsedTags = ticketData.tags ? ticketData.tags.split(',') : [];
      }
      setTags(parsedTags || []);

      // Fetch draft response
      if (draftRes.ok) {
        const draftData = await draftRes.json();
        setDraft(draftData.draft_body);
        setConfidence(draftData.confidence_score);
      } else {
        setDraft('');
        setConfidence(0);
      }
    } catch (err) {
      console.error(err);
      setError(err.message);
      setTicketDetails(null);
      setDraft('');
    } finally {
      setLoading(false);
    }
  };

  // Save/Update the draft response in our backend database
  const handleSaveDraft = async () => {
    if (!ticketId) return;
    setSuccessMsg('');
    setError(null);

    try {
      const response = await fetch(`${BACKEND_HOST}/api/tickets/${ticketId}/draft`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          draftBody: draft,
          confidenceScore: confidence,
          suggestedTags: tags
        })
      });

      if (!response.ok) {
        throw new Error('Failed to update draft in database.');
      }
      setSuccessMsg('Draft response successfully updated in DB!');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err) {
      setError(err.message);
    }
  };

  // Push draft comment directly into Zendesk active ticket composer
  const handleApplyToZendesk = async () => {
    if (!client) {
      // If we are testing standalone in browser, show message log since alert is blocked in iframes
      console.log(`[Developer Standalone Mode] Applying draft text:\n\n"${draft}"`);
      setSuccessMsg('Draft printed to console (alert blocked in sandbox iframe)');
      setTimeout(() => setSuccessMsg(''), 3000);
      return;
    }

    try {
      // Use official ZAF client.invoke to append the draft reply into the active composer
      await client.invoke('ticket.comment.appendText', draft);
      setSuccessMsg('Draft applied to Zendesk editor!');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err) {
      console.error(err);
      setError(`Failed to apply draft: ${err.message}`);
    }
  };

  const handleStandaloneSubmit = (e) => {
    e.preventDefault();
    const id = parseInt(standaloneTicketInput, 10);
    if (!isNaN(id)) {
      setTicketId(id);
      fetchTicketData(id);
    }
  };

  // Styled colors helper
  const getPriorityColor = (p) => {
    switch (p?.toLowerCase()) {
      case 'urgent': return { bg: 'rgba(244,63,94,0.15)', text: '#f43f5e' };
      case 'high': return { bg: 'rgba(245,158,11,0.15)', text: '#f59e0b' };
      case 'normal': return { bg: 'rgba(6,182,212,0.15)', text: '#06b6d4' };
      default: return { bg: 'rgba(16,185,129,0.15)', text: '#10b981' };
    }
  };

  const pColors = getPriorityColor(ticketDetails?.priority);

  return (
    <div style={styles.container}>
      {/* Sidebar Header */}
      <header style={styles.header}>
        <div style={styles.titleRow}>
          <span style={styles.headerIcon}>🤖</span>
          <h2 style={styles.headerTitle}>AI Triage Sidekick</h2>
        </div>
        <span style={{ 
          ...styles.modeBadge, 
          color: isZafMode ? '#10b981' : '#f59e0b',
          borderColor: isZafMode ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)',
          backgroundColor: isZafMode ? 'rgba(16,185,129,0.05)' : 'rgba(245,158,11,0.05)'
        }}>
          {isZafMode ? 'Zendesk Sandbox' : 'Dev Standalone'}
        </span>
      </header>

      {/* Standalone controls for visual testing */}
      {!isZafMode && (
        <form onSubmit={handleStandaloneSubmit} style={styles.standaloneForm}>
          <label style={styles.label}>Select Ticket ID to Triage:</label>
          <div style={styles.inputGroup}>
            <input 
              type="number" 
              value={standaloneTicketInput}
              onChange={(e) => setStandaloneTicketInput(e.target.value)}
              style={styles.input}
              min="1"
            />
            <button type="submit" style={styles.btnSecondary}>Load</button>
          </div>
        </form>
      )}

      {loading ? (
        <div style={styles.loader}>Analyzing ticket context...</div>
      ) : error ? (
        <div style={styles.errorBox}>
          <p style={{ fontWeight: 600 }}>⚠️ Data Fetch Error</p>
          <p style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>{error}</p>
          {!isZafMode && (
            <p style={{ fontSize: '0.75rem', marginTop: '0.5rem', color: '#64748b' }}>
              Verify the backend is running and you have run a query from the Dev Console.
            </p>
          )}
        </div>
      ) : ticketDetails ? (
        <div style={styles.content}>
          {/* Ticket Info Card */}
          <div style={styles.infoCard}>
            <div style={styles.infoRow}>
              <span style={styles.ticketNum}>Ticket #{ticketDetails.id}</span>
              <span style={{ 
                ...styles.priorityPill,
                backgroundColor: pColors.bg,
                color: pColors.text
              }}>
                {ticketDetails.priority}
              </span>
            </div>
            <div style={styles.subject}>{ticketDetails.subject}</div>
            
            {tags.length > 0 && (
              <div style={styles.tagWrapper}>
                {tags.map((t, idx) => (
                  <span key={idx} style={styles.tag}>{t}</span>
                ))}
              </div>
            )}
          </div>

          {/* AI Pre-written draft */}
          <div style={styles.draftCard}>
            <div style={styles.draftHeader}>
              <span style={styles.draftTitle}>Claude Suggested Response</span>
              {confidence > 0 && (
                <span style={styles.confidence}>
                  Confidence: {(confidence * 100).toFixed(0)}%
                </span>
              )}
            </div>

            <textarea 
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={styles.textarea}
              placeholder="Pre-writing response..."
            />

            {/* Actions */}
            <div style={styles.actionRow}>
              <button onClick={handleSaveDraft} style={styles.btnSecondaryFlat}>
                💾 Save Edits
              </button>
              <button onClick={handleApplyToZendesk} style={styles.btnPrimary}>
                ✨ Apply to Reply
              </button>
            </div>
          </div>

          {/* Success toast notifications */}
          {successMsg && (
            <div style={styles.successToast}>
              {successMsg}
            </div>
          )}
        </div>
      ) : null}

      {/* Dynamic SDK Debug Diagnostics for Developers (only shown when not in ZAF Mode) */}
      {!isZafMode && (
        <div style={{
          marginTop: '12px',
          padding: '8px',
          borderRadius: '6px',
          border: '1px dashed #d8dcde',
          fontSize: '0.65rem',
          color: '#68737d',
          backgroundColor: '#f8f9fa',
          wordBreak: 'break-all'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '4px', color: '#49545c' }}>⚙️ Triage Debug Info</div>
          <div>SDK Script: <strong style={{ color: debugInfo.zafSdkStatus === 'loaded' ? '#10b981' : '#f43f5e' }}>{debugInfo.zafSdkStatus}</strong></div>
          <div>URL: <code style={{ color: '#1f73b7' }}>{debugInfo.url}</code></div>
          {debugInfo.zafError && (
            <div style={{ color: '#b71c1c', marginTop: '2px' }}>ZAF Error: {debugInfo.zafError}</div>
          )}
        </div>
      )}
    </div>
  );
}

// Clean premium inline styles to stay completely independent of external CSS files in Zendesk container
const styles = {
  container: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    color: '#2f3941',
    backgroundColor: '#ffffff',
    padding: '12px',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    minHeight: '100%',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: '10px',
    borderBottom: '1px solid #e9ebed',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  headerIcon: {
    fontSize: '1.25rem',
  },
  headerTitle: {
    fontSize: '0.95rem',
    fontWeight: '700',
    margin: 0,
    color: '#1f73b7',
  },
  modeBadge: {
    fontSize: '0.7rem',
    padding: '2px 6px',
    borderRadius: '4px',
    fontWeight: '600',
    border: '1px solid',
  },
  standaloneForm: {
    backgroundColor: '#f8f9fa',
    border: '1px solid #e9ebed',
    padding: '8px 12px',
    borderRadius: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  label: {
    fontSize: '0.75rem',
    fontWeight: '600',
    color: '#49545c',
  },
  inputGroup: {
    display: 'flex',
    gap: '6px',
  },
  input: {
    flex: 1,
    padding: '4px 8px',
    border: '1px solid #d8dcde',
    borderRadius: '4px',
    fontSize: '0.8rem',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  infoCard: {
    border: '1px solid #e9ebed',
    borderRadius: '8px',
    padding: '10px',
    backgroundColor: '#f8f9fa',
  },
  infoRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '4px',
  },
  ticketNum: {
    fontSize: '0.75rem',
    fontWeight: '600',
    color: '#68737d',
  },
  priorityPill: {
    fontSize: '0.7rem',
    padding: '1px 6px',
    borderRadius: '3px',
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  subject: {
    fontSize: '0.85rem',
    fontWeight: '600',
    color: '#2f3941',
    marginBottom: '8px',
  },
  tagWrapper: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
  },
  tag: {
    fontSize: '0.65rem',
    backgroundColor: '#e4f2fe',
    color: '#1f73b7',
    padding: '1px 5px',
    borderRadius: '3px',
    border: '1px solid #d2e8fc',
  },
  draftCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  draftHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  draftTitle: {
    fontSize: '0.8rem',
    fontWeight: '600',
    color: '#49545c',
  },
  confidence: {
    fontSize: '0.75rem',
    color: '#10b981',
    fontWeight: '600',
  },
  textarea: {
    width: '100%',
    minHeight: '180px',
    padding: '10px',
    border: '1px solid #d8dcde',
    borderRadius: '6px',
    fontFamily: 'inherit',
    fontSize: '0.85rem',
    lineHeight: '1.4',
    resize: 'vertical',
    color: '#2f3941',
  },
  actionRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '8px',
  },
  btnPrimary: {
    backgroundColor: '#1f73b7',
    color: '#ffffff',
    border: 'none',
    borderRadius: '4px',
    padding: '8px 12px',
    fontSize: '0.8rem',
    fontWeight: '600',
    cursor: 'pointer',
    flex: 1,
    textAlign: 'center',
  },
  btnSecondary: {
    backgroundColor: '#ffffff',
    color: '#2f3941',
    border: '1px solid #d8dcde',
    borderRadius: '4px',
    padding: '4px 10px',
    fontSize: '0.8rem',
    fontWeight: '500',
    cursor: 'pointer',
  },
  btnSecondaryFlat: {
    backgroundColor: '#ffffff',
    color: '#49545c',
    border: '1px solid #d8dcde',
    borderRadius: '4px',
    padding: '8px 12px',
    fontSize: '0.8rem',
    fontWeight: '600',
    cursor: 'pointer',
    flex: 1,
    textAlign: 'center',
  },
  loader: {
    fontSize: '0.85rem',
    color: '#68737d',
    textAlign: 'center',
    padding: '40px 0',
  },
  errorBox: {
    backgroundColor: '#fff0f1',
    border: '1px solid #ffcdd2',
    color: '#b71c1c',
    padding: '12px',
    borderRadius: '8px',
    fontSize: '0.85rem',
  },
  successToast: {
    backgroundColor: '#e6f4ea',
    color: '#137333',
    border: '1px solid #c6ecce',
    padding: '8px 12px',
    borderRadius: '4px',
    fontSize: '0.8rem',
    fontWeight: '600',
    textAlign: 'center',
    animation: 'fadeIn 0.2s ease-out',
  }
};
