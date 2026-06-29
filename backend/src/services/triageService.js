import Anthropic from '@anthropic-ai/sdk';
import { prisma } from './database.js';
import { zendeskClient } from './zendeskClient.js';

// Schema declarations for Claude Tools
const TOOLS = [
  {
    name: 'search_knowledge_base',
    description: 'Search the local Help Center knowledge base for articles that can resolve the customer query. Use this tool if the customer query asks a question or reports an issue that might have an existing solution/policy.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query containing keywords relevant to the customer request.' }
      },
      required: ['query']
    }
  },
  {
    name: 'create_zendesk_ticket',
    description: 'Create a new support ticket in Zendesk. The ticket should include the customer\'s subject, description, priority based on sentiment analysis (low, normal, high, urgent), and tags classifying the ticket.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Concise summary of the issue.' },
        description: { type: 'string', description: 'Detailed description of the customer query and context.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Priority level based on tone, urgency, and severity of issue.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to categorize the issue (e.g. ["billing", "refund", "bug", "password_reset", "api"]).' }
      },
      required: ['subject', 'description', 'priority', 'tags']
    }
  },
  {
    name: 'draft_agent_response',
    description: 'Pre-write a response for the human agent to send to the customer. This should include the ticket ID (which you get from creating a ticket), the drafted reply body, a confidence score (0.0 to 1.0), and suggested tags. You MUST search the knowledge base first if the customer has a specific question, and utilize any relevant KB articles to make the response highly accurate.',
    input_schema: {
      type: 'object',
      properties: {
        ticketId: { type: 'integer', description: 'The ID of the ticket that was just created.' },
        draftBody: { type: 'string', description: 'The drafted email response to the customer. Maintain a helpful, empathetic, and professional tone.' },
        confidenceScore: { type: 'number', description: 'Confidence level of the draft response accuracy (0.0 to 1.0) based on KB matches.' },
        suggestedTags: { type: 'array', items: { type: 'string' }, description: 'Refined suggested tags for this response.' }
      },
      required: ['ticketId', 'draftBody', 'confidenceScore', 'suggestedTags']
    }
  }
];

const SYSTEM_PROMPT = `
You are the Intelligent CX Triage Agent. Your job is to process incoming customer support requests and triage them in Zendesk.

CRITICAL WORKFLOW CONSTRAINTS:
1. You MUST ALWAYS create a Zendesk ticket for every query by calling the "create_zendesk_ticket" tool. This is mandatory for every incoming message.
2. If the query involves a question, setup help, or billing issue, you MUST search the Help Center using the "search_knowledge_base" tool BEFORE creating the ticket so you have context for your draft.
3. After calling "create_zendesk_ticket" and receiving a ticket ID, you MUST immediately call the "draft_agent_response" tool to save your drafted reply for the human support agent in the database.
4. DO NOT provide the full customer support instructions or detailed answer directly in your final chat reply. Instead, save the detailed answer inside the "draftBody" of the "draft_agent_response" tool call.
5. Your final text response should ONLY be a brief summary of the actions you performed (e.g. ticket created, tags applied, and draft saved).

Follow this strict tool execution sequence:
1. [Optional] search_knowledge_base (based on query relevance)
2. [Mandatory] create_zendesk_ticket
3. [Mandatory] draft_agent_response
`;

export const triageService = {
  /**
   * Orchestrates the agent loop
   */
  async processTriage(requestId, query, onProgress) {
    if (!requestId) {
      throw new Error('Request ID is required for idempotency tracking.');
    }

    // 1. Enforce Idempotency constraint using a Prisma Transaction
    let existingRequest;
    try {
      await prisma.$transaction(async (tx) => {
        existingRequest = await tx.idempotencyKey.findUnique({
          where: { key: requestId }
        });
        if (!existingRequest) {
          // Reserve the key with a 'pending' status
          await tx.idempotencyKey.create({
            data: { key: requestId, status: 'pending' }
          });
        }
      });
    } catch (err) {
      throw new Error(`Database transaction error checking idempotency: ${err.message}`);
    }

    // If request already exists, return the cached result or throw conflict
    if (existingRequest) {
      if (existingRequest.status === 'completed') {
        console.log(`[Idempotency] Key ${requestId} hit. Returning cached response.`);
        onProgress({ type: 'info', message: `Idempotency hit! Returning cached ticket for key: ${requestId}` });
        return JSON.parse(existingRequest.responsePayload);
      } else if (existingRequest.status === 'pending') {
        console.warn(`[Idempotency] Key ${requestId} is already processing.`);
        throw new Error('Conflict: A request with this ID is already in progress.');
      } else {
        // If it failed before, update to pending to allow retry
        await prisma.idempotencyKey.update({
          where: { key: requestId },
          data: { status: 'pending' }
        });
      }
    }

    try {
      let finalResult;
      const apiKey = process.env.ANTHROPIC_API_KEY;

      if (apiKey && apiKey !== 'your_anthropic_api_key_here') {
        // Run Real Claude Agent
        finalResult = await this.runRealClaude(query, onProgress);
      } else {
        // Run Simulated Agent
        finalResult = await this.runMockAgent(query, onProgress);
      }

      // Update idempotency to completed
      await prisma.idempotencyKey.update({
        where: { key: requestId },
        data: {
          status: 'completed',
          responsePayload: JSON.stringify(finalResult)
        }
      });

      return finalResult;
    } catch (err) {
      console.error('Triage agent loop failed:', err);
      // Clean up idempotency so user can retry
      await prisma.idempotencyKey.update({
        where: { key: requestId },
        data: { status: 'failed' }
      }).catch(dbErr => console.error('Failed to clean up idempotency key:', dbErr));
      throw err;
    }
  },

  /**
   * Real Claude SDK Agent Execution
   */
  async runRealClaude(query, onProgress) {
    onProgress({ type: 'info', message: 'Starting Claude Orchestration Loop...' });
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    
    let messages = [{ role: 'user', content: query }];
    let continueLoop = true;
    let createdTicket = null;
    let savedDraft = null;
    let finalSummary = '';

    while (continueLoop) {
      onProgress({ type: 'info', message: 'Invoking Claude...' });
      const response = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS
      });
    // 'claude-3-5-sonnet-20240620'
    // 'claude-3-opus-20240229'
    // 'claude-3-sonnet-20240229'
    // 'claude-3-haiku-20240307'
    // 'claude-2.1'
    // 'claude-2.0'
    // 'claude-instant-1.2'

      // Add Claude's response to the message history
      messages.push({ role: 'assistant', content: response.content });

      const toolCalls = response.content.filter(block => block.type === 'tool_use');

      if (toolCalls.length > 0) {
        const toolResults = [];

        for (const toolCall of toolCalls) {
          const { name, input, id: toolUseId } = toolCall;
          onProgress({ 
            type: 'tool_start', 
            tool: name, 
            input 
          });

          let result;
          try {
            if (name === 'search_knowledge_base') {
              result = await zendeskClient.searchKnowledgeBase(input.query);
            } else if (name === 'create_zendesk_ticket') {
              createdTicket = await zendeskClient.createTicket({
                subject: input.subject,
                description: input.description,
                priority: input.priority,
                tags: input.tags
              });
              result = createdTicket;
            } else if (name === 'draft_agent_response') {
              savedDraft = await zendeskClient.saveDraftResponse(input.ticketId, {
                draftBody: input.draftBody,
                confidenceScore: input.confidenceScore,
                suggestedTags: input.suggestedTags
              });
              result = savedDraft;
            } else {
              throw new Error(`Unknown tool: ${name}`);
            }

            onProgress({ 
              type: 'tool_success', 
              tool: name, 
              result 
            });

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: JSON.stringify(result)
            });
          } catch (toolErr) {
            console.error(`Tool execution failed [${name}]:`, toolErr);
            onProgress({ 
              type: 'tool_error', 
              tool: name, 
              error: toolErr.message 
            });

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: JSON.stringify({ error: toolErr.message }),
              is_error: true
            });
          }
        }

        // Add tool results to message history
        messages.push({ role: 'user', content: toolResults });
      } else {
        // Claude is done calling tools, final reply is text
        continueLoop = false;
        const textBlock = response.content.find(block => block.type === 'text');
        if (textBlock) {
          finalSummary = textBlock.text;
        }
      }
    }

    return {
      success: true,
      mode: 'claude',
      ticket: createdTicket,
      draft: savedDraft,
      summary: finalSummary
    };
  },

  /**
   * Simulated Agent Execution (Runs if Anthropic API Key is not set)
   */
  async runMockAgent(query, onProgress) {
    onProgress({ type: 'info', message: 'Starting Simulated Claude Agent (No API Key found)...' });
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    await sleep(800);

    // 1. Analyze category
    const lowercaseQuery = query.toLowerCase();
    let category = 'general';
    let searchWord = '';

    if (lowercaseQuery.includes('refund') || lowercaseQuery.includes('bill') || lowercaseQuery.includes('charge')) {
      category = 'billing';
      searchWord = 'billing';
    } else if (lowercaseQuery.includes('password') || lowercaseQuery.includes('login') || lowercaseQuery.includes('reset')) {
      category = 'account';
      searchWord = 'password';
    } else if (lowercaseQuery.includes('domain') || lowercaseQuery.includes('dns') || lowercaseQuery.includes('cname')) {
      category = 'technical';
      searchWord = 'domain';
    } else if (lowercaseQuery.includes('api') || lowercaseQuery.includes('token') || lowercaseQuery.includes('limit')) {
      category = 'technical';
      searchWord = 'api';
    }

    // 2. Perform search_knowledge_base
    onProgress({ 
      type: 'tool_start', 
      tool: 'search_knowledge_base', 
      input: { query: searchWord || 'policy' } 
    });
    
    await sleep(1000);
    const kbResults = await zendeskClient.searchKnowledgeBase(searchWord || 'policy');
    
    onProgress({ 
      type: 'tool_success', 
      tool: 'search_knowledge_base', 
      result: kbResults 
    });

    // 3. Perform create_zendesk_ticket
    const priority = lowercaseQuery.includes('urgent') || lowercaseQuery.includes('immediate') || lowercaseQuery.includes('frustrated') ? 'urgent' : 'normal';
    const subject = `Triaged: issue regarding ${category}`;
    const tags = [category, 'triaged'];
    if (priority === 'urgent') tags.push('high_priority');

    onProgress({ 
      type: 'tool_start', 
      tool: 'create_zendesk_ticket', 
      input: { subject, description: query, priority, tags } 
    });

    await sleep(1000);
    const ticket = await zendeskClient.createTicket({
      subject,
      description: query,
      priority,
      tags
    });

    onProgress({ 
      type: 'tool_success', 
      tool: 'create_zendesk_ticket', 
      result: ticket 
    });

    // 4. Perform draft_agent_response
    let articleInfo = kbResults.length > 0 ? kbResults[0].body : 'Please refer to standard guidelines.';
    let draftBody = `Hi there,\n\nThank you for reaching out. I understand you have a question regarding ${category}.\n\nBased on our guidelines: ${articleInfo}\n\nOur support team has logged this under Ticket #${ticket.id} with ${priority} priority. We will follow up shortly.\n\nBest regards,\nCustomer Support AI`;
    
    onProgress({ 
      type: 'tool_start', 
      tool: 'draft_agent_response', 
      input: { ticketId: ticket.id, draftBody, confidenceScore: kbResults.length > 0 ? 0.9 : 0.4, suggestedTags: tags } 
    });

    await sleep(1000);
    const draft = await zendeskClient.saveDraftResponse(ticket.id, {
      draftBody,
      confidenceScore: kbResults.length > 0 ? 0.9 : 0.4,
      suggestedTags: tags
    });

    onProgress({ 
      type: 'tool_success', 
      tool: 'draft_agent_response', 
      result: draft 
    });

    await sleep(500);
    
    const summary = `Successfully completed triaging request. Created mock ticket #${ticket.id} with ${priority} priority and drafted an appropriate customer response based on help center policies.`;
    onProgress({ type: 'info', message: 'Triage complete!' });

    return {
      success: true,
      mode: 'mock',
      ticket,
      draft,
      summary
    };
  }
};
