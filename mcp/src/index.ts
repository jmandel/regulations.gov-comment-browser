import express, { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer } from './server';

const app = express();
app.use(express.json());

// Store SSE transports by session ID
const sseTransports: Map<string, SSEServerTransport> = new Map();

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'regulations-browser-mcp' });
});

// MCP endpoint - stateless mode
app.post('/mcp', async (req: Request, res: Response) => {
  // In stateless mode, create a new instance of transport and server for each request
  // to ensure complete isolation. A single instance would cause request ID collisions
  // when multiple clients connect concurrently.
  
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    
    res.on('close', () => {
      console.log('Request closed');
      transport.close();
      server.close();
    });
    
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// SSE notifications not supported in stateless mode
app.get('/mcp', async (_req: Request, res: Response) => {
  console.log('Received GET MCP request');
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  }));
});

// Session termination not needed in stateless mode
app.delete('/mcp', async (_req: Request, res: Response) => {
  console.log('Received DELETE MCP request');
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  }));
});

// SSE Transport Support (Legacy/Alternative)
// Establish SSE stream
app.get('/sse', async (_req: Request, res: Response) => {
  console.log('Received GET request to /sse (SSE transport)');
  
  try {
    const server = createServer();
    const transport = new SSEServerTransport('/messages', res);
    
    // Store transport by session ID
    sseTransports.set(transport.sessionId, transport);
    
    // Clean up on disconnect
    res.on('close', () => {
      console.log(`SSE connection closed for session ${transport.sessionId}`);
      sseTransports.delete(transport.sessionId);
      server.close();
    });
    
    await server.connect(transport);
  } catch (error) {
    console.error('Error setting up SSE transport:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// Handle SSE messages
app.post('/messages', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  
  if (!sessionId) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: Missing sessionId query parameter',
      },
      id: null,
    });
    return;
  }
  
  const transport = sseTransports.get(sessionId);
  
  if (!transport) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No transport found for sessionId',
      },
      id: null,
    });
    return;
  }
  
  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error('Error handling SSE message:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// Start the server
const PORT = parseInt(process.env.PORT || '3000');

app.listen(PORT, (error?: any) => {
  if (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
  console.log(`
🚀 Regulations Browser MCP Server
   
   Port: ${PORT}
   Base URL: ${process.env.REGULATIONS_BASE_URL || 'https://joshuamandel.com/regulations.gov-comment-browser'}
   
   Health: http://localhost:${PORT}/health
   
   Transport Options:
   1. Streamable HTTP (recommended):
      - MCP: http://localhost:${PORT}/mcp
   
   2. SSE (legacy/alternative):
      - Stream: http://localhost:${PORT}/sse
      - Messages: http://localhost:${PORT}/messages?sessionId=<id>
  `);
});