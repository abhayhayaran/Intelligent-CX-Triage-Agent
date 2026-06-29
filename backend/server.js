import './src/instrumentation.js'; // Must be imported first to auto-instrument later imports
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { triageService } from './src/services/triageService.js';
import { zendeskClient } from './src/services/zendeskClient.js';
import { prisma } from './src/services/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from local backend directory or parent root directory
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve the Developer Console UI statically
app.use(express.static(path.join(__dirname, 'src/public')));

// Store active Server-Sent Event (SSE) clients mapped by requestId
const sseClients = new Map();

/**
 * SSE Endpoint for streaming Claude's process steps
 */
app.get('/api/stream', (req, res) => {
  const { requestId } = req.query;
  if (!requestId) {
    return res.status(400).json({ error: 'requestId parameter is required for streaming.' });
  }

  // Setup headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Prevent proxy buffering
  });

  // Send initial message
  res.write(`data: ${JSON.stringify({ type: 'info', message: 'Stream connected. Awaiting triage pipeline...' })}\n\n`);

  // Save the connection
  sseClients.set(requestId, res);

  req.on('close', () => {
    sseClients.delete(requestId);
  });
});

/**
 * Get current application config / credentials mode
 */
app.get('/api/config', (req, res) => {
  return res.json({
    realMode: zendeskClient.isRealMode()
  });
});

/**
 * Trigger triage pipeline
 */
app.post('/api/triage', async (req, res) => {
  const { query, requestId } = req.body;

  if (!query || !requestId) {
    return res.status(400).json({ error: 'Both query and requestId (idempotency key) are required.' });
  }

  // Define progress callback that sends events via SSE to the matching client
  const onProgress = (event) => {
    const client = sseClients.get(requestId);
    if (client) {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  try {
    const result = await triageService.processTriage(requestId, query, onProgress);
    
    // Send complete event before response finishes
    onProgress({ type: 'complete', result });

    return res.status(200).json(result);
  } catch (err) {
    onProgress({ type: 'error', message: err.message });
    return res.status(err.message.includes('Conflict') ? 409 : 500).json({ error: err.message });
  }
});

/**
 * Get all tickets (used by React ZAF app standalone testing)
 */
app.get('/api/tickets', async (req, res) => {
  try {
    const tickets = await prisma.ticket.findMany({
      orderBy: { id: 'desc' }
    });
    // Format to align with tags payload parsing expectations
    const formattedTickets = tickets.map(t => ({
      id: t.id,
      subject: t.subject,
      description: t.description,
      priority: t.priority,
      status: t.status,
      tags: t.tags,
      created_at: t.createdAt.toISOString()
    }));
    return res.json(formattedTickets);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get ticket details (used by React ZAF Sidebar App)
 */
app.get('/api/tickets/:id', async (req, res) => {
  try {
    const ticket = await zendeskClient.getTicket(req.params.id);
    return res.json(ticket);
  } catch (err) {
    console.error(err);
    return res.status(404).json({ error: err.message });
  }
});

/**
 * Get cached draft response for a ticket (used by React ZAF Sidebar App)
 */
app.get('/api/tickets/:id/draft', async (req, res) => {
  try {
    const draft = await zendeskClient.getDraftResponse(req.params.id);
    if (!draft) {
      return res.status(404).json({ error: 'No draft response found for this ticket.' });
    }
    return res.json(draft);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Update draft response (manually modified by agent in React ZAF App)
 */
app.post('/api/tickets/:id/draft', async (req, res) => {
  const { draftBody, confidenceScore, suggestedTags } = req.body;
  try {
    const updatedDraft = await zendeskClient.saveDraftResponse(req.params.id, {
      draftBody,
      confidenceScore: confidenceScore || 1.0,
      suggestedTags: suggestedTags || []
    });
    return res.json({ success: true, draft: updatedDraft });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚀 Intelligent CX Triage Server running on port ${PORT}`);
  console.log(`📺 Developer Console: http://localhost:${PORT}`);
  console.log(`⚡ Mode: ${zendeskClient.isRealMode() ? 'REAL Zendesk API' : 'LOCAL Mock DB'}`);
  console.log(`==================================================`);
});
