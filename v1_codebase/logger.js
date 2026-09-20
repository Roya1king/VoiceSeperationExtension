// Centralized Logger for Chrome Extension (v1_codebase/logger.js)
// Usage: Import this into background.js, offscreen.js, popup.js, etc.

let isLogging = false;
const LOG_URL = 'http://localhost:3030/logs';

function sendLog(source, level, args) {
    if (isLogging) return; // Prevent infinite loops
    isLogging = true;
    
    // Stringify errors safely
    const message = args.map(arg => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'object') return JSON.stringify(arg);
        return String(arg);
    }).join(' ');

    const payload = {
        source,
        level,
        message,
        timestamp: new Date().toISOString()
    };

    fetch(LOG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true // Crucial for service workers
    }).catch(() => {
        // Silently fail if server is down, do not trigger another error
    }).finally(() => {
        isLogging = false;
    });
}

// Override console globally
export function initLogger(sourceName) {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args) => { origLog(...args); sendLog(sourceName, 'info', args); };
    console.warn = (...args) => { origWarn(...args); sendLog(sourceName, 'warn', args); };
    console.error = (...args) => { origError(...args); sendLog(sourceName, 'error', args); };
    
    console.log(`[${sourceName}] Logger initialized.`);
}
