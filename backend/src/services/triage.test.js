import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from './database.js';
import { triageService } from './triageService.js';

// Enforce test node environment
process.env.NODE_ENV = 'test';

const resetDatabase = async () => {
  // Clear tables in topological order (child dependencies first due to foreign keys)
  await prisma.draftResponse.deleteMany({});
  await prisma.ticket.deleteMany({});
  await prisma.idempotencyKey.deleteMany({});
  await prisma.kBArticle.deleteMany({});

  // Seed Knowledge Base articles required by triage mock engine
  await prisma.kBArticle.createMany({
    data: [
      { 
        title: 'Billing & Refund Policy', 
        body: 'We offer full refunds for cancellations within 14 days of purchase. Refunds take 5-7 business days to process back to your original payment method. For cancellations after 14 days, we provide pro-rated account credits instead of cash refunds.', 
        category: 'billing' 
      },
      { 
        title: 'Connecting your Custom Domain', 
        body: 'To connect a custom domain: 1. Go to Settings > Domains. 2. Enter your domain. 3. Add an A record pointing to 192.0.2.1 and a CNAME record for www pointing to domains.example.com. DNS propagation can take up to 24 hours.', 
        category: 'technical' 
      },
      { 
        title: 'Resetting Account Password', 
        body: 'If you forgot your password, click "Forgot Password" on the login screen. You will receive an email with a secure link to reset it. Reset links expire after 2 hours. If you do not see the email, check your spam folder.', 
        category: 'account' 
      },
      { 
        title: 'API Access and Token Limits', 
        body: 'API access tokens can be created under Settings > API. We enforce a rate limit of 100 requests per minute per token. If you exceed this rate, you will receive a 429 Too Many Requests response. For high-volume needs, contact sales.', 
        category: 'technical' 
      },
      { 
        title: 'Updating Payment Method', 
        body: 'To update your credit card or payment details: 1. Go to Billing > Payment Methods. 2. Click "Add Card" or "Edit". 3. Update your details and click Save. All billing transactions are securely handled through Stripe with 256-bit encryption.', 
        category: 'billing' 
      }
    ]
  });
};

describe('PostgreSQL System Tests (Transactions & Constraints via Prisma)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('should successfully commit data changes during standard transactions', async () => {
    let ticket;
    await prisma.$transaction(async (tx) => {
      ticket = await tx.ticket.create({
        data: {
          subject: 'Test Subject',
          description: 'Test Desc',
          priority: 'normal',
          tags: '[]'
        }
      });
    });

    const savedTicket = await prisma.ticket.findUnique({
      where: { id: ticket.id }
    });
    expect(savedTicket).not.toBeNull();
    expect(savedTicket.subject).toBe('Test Subject');
  });

  it('should completely roll back database changes if an error is thrown within a transaction', async () => {
    let ticketId;
    try {
      await prisma.$transaction(async (tx) => {
        const t = await tx.ticket.create({
          data: {
            subject: 'Rollback Subject',
            description: 'Test Desc',
            priority: 'normal',
            tags: '[]'
          }
        });
        ticketId = t.id;
        throw new Error('Forced simulation crash');
      });
    } catch (err) {
      expect(err.message).toBe('Forced simulation crash');
    }

    if (ticketId) {
      const savedTicket = await prisma.ticket.findUnique({
        where: { id: ticketId }
      });
      expect(savedTicket).toBeNull(); // Reverted successfully
    }
  });

  it('should enforce UNIQUE constraint on duplicate idempotency keys', async () => {
    await prisma.idempotencyKey.create({
      data: {
        key: 'key123',
        status: 'completed',
        responsePayload: '{}'
      }
    });

    // Attempting duplicate insert should fail unique key checks
    await expect(async () => {
      await prisma.idempotencyKey.create({
        data: {
          key: 'key123',
          status: 'pending',
          responsePayload: '{}'
        }
      });
    }).rejects.toThrow();
  });
});

describe('AI Triage Pipeline & Idempotency Engine (Prisma/Postgres)', () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ZENDESK_API_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should execute mock triage pipeline and generate ticket & draft when credentials are empty', async () => {
    const requestId = 'req-triage-test-1';
    const customerQuery = 'My domain connection has been dropping frequently since yesterday.';
    const progressLogs = [];

    const result = await triageService.processTriage(
      requestId,
      customerQuery,
      (evt) => progressLogs.push(evt)
    );

    // 1. Validate progress logs
    expect(progressLogs.length).toBeGreaterThanOrEqual(4);
    expect(progressLogs[0].type).toBe('info');
    expect(progressLogs[0].message).toContain('Simulated Claude Agent');

    const toolStarts = progressLogs.filter(e => e.type === 'tool_start');
    expect(toolStarts.length).toBe(3);

    // 2. Validate ticket records
    const ticket = await prisma.ticket.findUnique({
      where: { id: result.ticket.id }
    });
    expect(ticket).not.toBeNull();
    expect(ticket.tags).toContain('technical');
    expect(ticket.priority).toBe('normal');

    // 3. Validate draft response records
    const draft = await prisma.draftResponse.findUnique({
      where: { ticketId: result.ticket.id }
    });
    expect(draft).not.toBeNull();
    expect(draft.draftBody).toContain('technical');
  });

  it('should serve cached response immediately and skip execution loop on duplicate requestId (Idempotency)', async () => {
    const requestId = 'req-triage-idempotency-2';
    const customerQuery = 'Help me reset my login password.';

    // First execution
    const firstResult = await triageService.processTriage(requestId, customerQuery, () => {});
    
    // Second execution with identical requestId
    const progressLogs = [];
    const secondResult = await triageService.processTriage(
      requestId,
      customerQuery,
      (evt) => progressLogs.push(evt)
    );

    // 1. Results should be identical
    expect(secondResult.ticket.id).toBe(firstResult.ticket.id);

    // 2. Cache hit check
    expect(progressLogs).toHaveLength(1);
    expect(progressLogs[0].type).toBe('info');
    expect(progressLogs[0].message).toContain('Idempotency hit');
  });
});
