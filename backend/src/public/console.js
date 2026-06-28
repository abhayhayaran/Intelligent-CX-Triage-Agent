// Helper to generate a UUID v4
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// DOM Elements
const requestIdInput = document.getElementById('requestId-input');
const regenIdBtn = document.getElementById('regen-id-btn');
const queryInput = document.getElementById('query-input');
const triggerBtn = document.getElementById('trigger-triage-btn');
const terminalLogs = document.getElementById('terminal-logs');
const resultsSection = document.getElementById('results-section');
const backendModeBadge = document.getElementById('backend-mode-badge');
const zcliDevTip = document.getElementById('zcli-dev-tip');

const resTicketId = document.getElementById('res-ticket-id');
const resTicketSubject = document.getElementById('res-ticket-subject');
const resTicketPriority = document.getElementById('res-ticket-priority');
const resTicketStatus = document.getElementById('res-ticket-status');
const resTicketTags = document.getElementById('res-ticket-tags');
const resDraftConfidence = document.getElementById('res-draft-confidence');
const resDraftBody = document.getElementById('res-draft-body');

// Generate initial request ID
requestIdInput.value = generateUUID();

// Regenerate Key handler
regenIdBtn.addEventListener('click', () => {
  requestIdInput.value = generateUUID();
  appendLog('info', `Generated new idempotency key: ${requestIdInput.value}`);
});

// Check Server Configuration on load
async function checkServerConfig() {
  try {
    const response = await fetch('/api/config');
    if (response.ok) {
      const config = await response.json();
      updateModeBadge(config.realMode);
    } else {
      backendModeBadge.textContent = 'LOCAL Mock DB';
      backendModeBadge.className = 'badge';
    }
  } catch (err) {
    backendModeBadge.textContent = 'Server Offline';
    backendModeBadge.style.borderColor = 'var(--accent-rose)';
    backendModeBadge.style.color = 'var(--accent-rose)';
  }
}

function updateModeBadge(isRealMode) {
  if (isRealMode) {
    backendModeBadge.textContent = '⚡ REAL Zendesk API';
    backendModeBadge.style.color = '#818cf8';
    backendModeBadge.style.borderColor = 'rgba(99, 102, 241, 0.4)';
    backendModeBadge.style.backgroundColor = 'rgba(99, 102, 241, 0.1)';
    zcliDevTip.style.display = 'flex';
  } else {
    backendModeBadge.textContent = '🤖 LOCAL Mock DB';
    backendModeBadge.style.color = 'var(--accent-emerald)';
    backendModeBadge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    backendModeBadge.style.backgroundColor = 'rgba(16, 185, 129, 0.05)';
    zcliDevTip.style.display = 'none';
  }
}

// Template Load handlers
document.querySelectorAll('.template-item').forEach(button => {
  button.addEventListener('click', () => {
    queryInput.value = button.dataset.query;
    // Generate new request ID on template select to avoid idempotency conflict
    requestIdInput.value = generateUUID();
    appendLog('info', `Loaded template and generated new idempotency key: ${requestIdInput.value}`);
    queryInput.focus();
  });
});

// Logging helpers
function appendLog(type, message, extra = null) {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;

  const timestamp = new Date().toLocaleTimeString();
  let html = `<span style="color: var(--text-muted)">[${timestamp}]</span> `;

  if (type === 'info') {
    html += `<span>${message}</span>`;
  } else if (type === 'tool_start') {
    html += `<span style="font-weight:600">🛠️ Tool Call:</span> <code>${message}</code>`;
    if (extra) {
      html += `<pre class="json-preview">${JSON.stringify(extra, null, 2)}</pre>`;
    }
  } else if (type === 'tool_success') {
    html += `<span style="font-weight:600">✅ Tool Returned:</span> <code>${message}</code>`;
    if (extra) {
      html += `<pre class="json-preview">${JSON.stringify(extra, null, 2)}</pre>`;
    }
  } else if (type === 'tool_error') {
    html += `<span style="font-weight:600">❌ Tool Error:</span> <code>${message}</code>`;
    if (extra) {
      html += `<div style="color: var(--accent-rose); margin-top: 0.25rem;">${extra}</div>`;
    }
  } else if (type === 'error') {
    html += `<span style="font-weight:600">⚠️ System Failure:</span> <span>${message}</span>`;
  } else if (type === 'complete') {
    html += `<span style="font-weight:600">✨ Triage Complete!</span> <span>${message}</span>`;
  }

  entry.innerHTML = html;
  terminalLogs.appendChild(entry);
  terminalLogs.scrollTop = terminalLogs.scrollHeight;
}

// Trigger Triage Action
triggerBtn.addEventListener('click', async () => {
  const query = queryInput.value.trim();
  const requestId = requestIdInput.value.trim();

  if (!query) {
    alert('Please enter a customer query first.');
    return;
  }
  if (!requestId) {
    alert('Idempotency key is required.');
    return;
  }

  // Clear UI states
  terminalLogs.innerHTML = '';
  resultsSection.style.display = 'none';
  setControlsEnabled(false);

  appendLog('info', `Connecting to Server-Sent Event stream for requestId: ${requestId}...`);

  // Establish SSE stream connection
  const eventSource = new EventSource(`/api/stream?requestId=${encodeURIComponent(requestId)}`);
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case 'info':
          appendLog('info', data.message);
          break;
        case 'tool_start':
          appendLog('tool_start', data.tool, data.input);
          break;
        case 'tool_success':
          appendLog('tool_success', data.tool, data.result);
          break;
        case 'tool_error':
          appendLog('tool_error', data.tool, data.error);
          break;
        case 'error':
          appendLog('error', data.message);
          eventSource.close();
          setControlsEnabled(true);
          break;
        case 'complete':
          appendLog('complete', data.result.summary);
          eventSource.close();
          displayResults(data.result);
          setControlsEnabled(true);
          break;
      }
    } catch (err) {
      console.error('Failed to parse SSE payload:', err);
    }
  };

  eventSource.onerror = (err) => {
    console.error('SSE connection error:', err);
    appendLog('error', 'SSE Stream disconnected unexpectedly.');
    eventSource.close();
    setControlsEnabled(true);
  };

  // Submit actual HTTP Post request to run triage logic
  try {
    const response = await fetch('/api/triage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, requestId })
    });

    if (!response.ok) {
      const errData = await response.json();
      appendLog('error', `Server returned error: ${errData.error || response.statusText}`);
      eventSource.close();
      setControlsEnabled(true);
    }
  } catch (fetchErr) {
    appendLog('error', `Failed to send POST request: ${fetchErr.message}`);
    eventSource.close();
    setControlsEnabled(true);
  }
});

function setControlsEnabled(enabled) {
  triggerBtn.disabled = !enabled;
  queryInput.disabled = !enabled;
  requestIdInput.disabled = !enabled;
  regenIdBtn.disabled = !enabled;
  document.querySelectorAll('.template-item').forEach(b => b.disabled = !enabled);
}

function displayResults(data) {
  const { ticket, draft, mode } = data;

  if (!ticket) return;

  resultsSection.style.display = 'grid';

  // Populating Ticket
  resTicketId.textContent = `#${ticket.id}`;
  resTicketSubject.textContent = ticket.subject;
  resTicketPriority.textContent = ticket.priority;
  resTicketPriority.className = `detail-val highlight-pill pill-${ticket.priority}`;
  resTicketStatus.textContent = ticket.status.toUpperCase();
  
  // Clean old tags
  resTicketTags.innerHTML = '';
  let tagsList = [];
  try {
    tagsList = typeof ticket.tags === 'string' ? JSON.parse(ticket.tags) : ticket.tags;
  } catch (e) {
    tagsList = ticket.tags ? ticket.tags.split(',') : [];
  }
  
  if (Array.isArray(tagsList)) {
    tagsList.forEach(t => {
      const tag = document.createElement('span');
      tag.className = 'tag-pill';
      tag.textContent = t;
      resTicketTags.appendChild(tag);
    });
  }

  // Populating Draft
  if (draft) {
    resDraftConfidence.textContent = `Confidence: ${(draft.confidence_score * 100).toFixed(0)}%`;
    resDraftBody.textContent = draft.draft_body;
  } else {
    resDraftConfidence.textContent = 'No Draft Response';
    resDraftBody.textContent = 'The agent did not output a draft response for this ticket.';
  }

  // Set the real/mock indicator label
  const modeInd = document.getElementById('ticket-mode-indicator');
  if (mode === 'claude') {
    modeInd.textContent = 'Zendesk Sandbox (Claude)';
    modeInd.style.backgroundColor = 'rgba(99, 102, 241, 0.15)';
    modeInd.style.color = '#818cf8';
  } else {
    modeInd.textContent = 'Local DB (Mock AI)';
    modeInd.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
    modeInd.style.color = 'var(--accent-emerald)';
  }

  resultsSection.scrollIntoView({ behavior: 'smooth' });
}

// Initial bootstrap
checkServerConfig();
setInterval(checkServerConfig, 5000); // Poll status every 5s
