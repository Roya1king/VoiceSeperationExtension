let creating; // Promise for offscreen creation
let activeCaptureTabId = null;
let captureState = 'idle';
let engineState = 'idle';
let latestLog = null;

function sendLogToMcp(entry) {
  fetch('http://127.0.0.1:3030/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: entry.source || 'extension',
      level: entry.level || 'info',
      message: entry.details ? `${entry.message} | ${entry.details}` : entry.message,
      timestamp: entry.timestamp || new Date().toISOString()
    })
  }).catch(() => {
    // Logging is optional; do not interrupt audio if the local MCP server is offline.
  });
}

function publishCaptureState(state, error) {
  captureState = state;
  chrome.runtime.sendMessage({ type: 'CAPTURE_STATE', state, error }).catch(() => {});
}

async function setupOffscreenDocument(path) {
  if (await chrome.offscreen.hasDocument()) return;
  if (creating) { await creating; return; }
  creating = chrome.offscreen.createDocument({
    url: path,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio for voice separation'
  });
  await creating;
  creating = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_CAPTURE') {
    chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
      const tabId = tabs[0].id;
      if (activeCaptureTabId === tabId) {
        publishCaptureState('active');
        return;
      }

      publishCaptureState('starting');
      try {
        await setupOffscreenDocument('offscreen.html');
      } catch (error) {
        publishCaptureState('error', error.message);
        return;
      }
      
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        if (chrome.runtime.lastError) {
          console.warn('Unable to capture tab:', chrome.runtime.lastError.message);
          publishCaptureState('error', chrome.runtime.lastError.message);
          return;
        }

        activeCaptureTabId = tabId;
        publishCaptureState('active');
        chrome.runtime.sendMessage({ type: 'CAPTURE_STREAM_ID', streamId });
      });
    });
  } else if (message.type === 'GET_CAPTURE_STATE') {
    sendResponse({ state: captureState, engineState });
    return true;
  } else if (message.type === 'GET_LATEST_LOG') {
    sendResponse(latestLog);
    return true;
  } else if (message.type === 'CAPTURE_ERROR') {
    publishCaptureState('error', message.error);
  } else if (message.type === 'ENGINE_STATE') {
    engineState = message.state;
    chrome.runtime.sendMessage({
      type: 'ENGINE_STATE',
      state: message.state,
      reason: message.reason
    }).catch(() => {});
  } else if (message.type === 'ENGINE_LOG') {
    latestLog = message;
    console.info(`[VoiceSep] ${message.message}`, message.details || '');
    sendLogToMcp(message);
    chrome.runtime.sendMessage(message).catch(() => {});
  } else if (message.type === 'OFFSCREEN_CLOSED') {
    activeCaptureTabId = null;
    publishCaptureState('idle');
  } else if (message.type === 'video-seek' || message.type === 'video-pause') {
      chrome.runtime.sendMessage({ type: 'RESET_BUFFER' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeCaptureTabId === tabId) {
    activeCaptureTabId = null;
    publishCaptureState('idle');
  }
});
