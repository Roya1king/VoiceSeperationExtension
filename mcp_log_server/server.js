import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Configuration
const PORT = process.env.PORT || 3030;
const LOGS_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);

// In-memory buffer for fast MCP queries
const logBuffer = [];
let currentMarker = null;
let currentMarkerTimestamp = null;

// --- Express HTTP Sink ---
const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(cors({ origin: true, credentials: false }));
app.options('*', cors()); // Preflight

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/logs', (req, res) => {
    try {
        const { source = 'unknown', level = 'info', message = '', timestamp = new Date().toISOString() } = req.body;
        const entry = { source, level, message, timestamp };
        
        // Save to memory
        logBuffer.push(entry);
        if (logBuffer.length > 5000) logBuffer.shift(); // Keep last 5000

        // Append to file
        const logFile = path.join(LOGS_DIR, `${source.split('-')[0]}.log`);
        const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
        fs.appendFile(logFile, logLine, (err) => {
            if (err) console.error("Failed to write log to file", err); // Stderr is safe for MCP
        });

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '127.0.0.1', () => {
    console.error(`Log Sink HTTP server listening on http://127.0.0.1:${PORT}`); // Stderr!
});

// --- MCP Server Setup ---
const mcp = new Server(
    { name: 'mcp-log-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'get_recent_logs',
                description: 'Get the last N log entries',
                inputSchema: {
                    type: 'object',
                    properties: {
                        source: { type: 'string', description: 'Filter by source (extension or python)' },
                        limit: { type: 'number', description: 'Max lines to return', default: 100 }
                    }
                }
            },
            {
                name: 'mark',
                description: 'Insert a marker before reproducing a bug to easily fetch logs afterwards.',
                inputSchema: {
                    type: 'object',
                    properties: { label: { type: 'string' } },
                    required: ['label']
                }
            },
            {
                name: 'get_session',
                description: 'Get all logs since the last marker.',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'clear_logs',
                description: 'Clear the in-memory log buffer.',
                inputSchema: { type: 'object', properties: {} }
            }
        ]
    };
});

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    if (name === 'get_recent_logs') {
        const source = args?.source;
        const limit = args?.limit || 100;
        let logs = source ? logBuffer.filter(l => l.source.startsWith(source)) : logBuffer;
        return { content: [{ type: 'text', text: JSON.stringify(logs.slice(-limit), null, 2) }] };
    }
    
    if (name === 'mark') {
        currentMarker = args.label;
        currentMarkerTimestamp = new Date().toISOString();
        logBuffer.push({ source: 'system', level: 'info', message: `--- MARKER: ${currentMarker} ---`, timestamp: currentMarkerTimestamp });
        return { content: [{ type: 'text', text: `Marker '${currentMarker}' set at ${currentMarkerTimestamp}. Reproduce the bug now, then call get_session.` }] };
    }
    
    if (name === 'get_session') {
        if (!currentMarkerTimestamp) return { content: [{ type: 'text', text: 'No marker set.' }] };
        const sessionLogs = logBuffer.filter(l => l.timestamp >= currentMarkerTimestamp);
        return { content: [{ type: 'text', text: JSON.stringify(sessionLogs, null, 2) }] };
    }
    
    if (name === 'clear_logs') {
        logBuffer.length = 0;
        currentMarker = null;
        currentMarkerTimestamp = null;
        return { content: [{ type: 'text', text: 'Logs cleared.' }] };
    }

    throw new Error(`Unknown tool: ${name}`);
});

async function runMcp() {
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    console.error('MCP Server connected to stdio.');
}

runMcp().catch(console.error);
