let audioCtx;
let workletNode;
let worker;

function log(level, message, details) {
    const entry = {
        type: 'ENGINE_LOG',
        source: 'extension-offscreen',
        level,
        message,
        details: details || null,
        timestamp: new Date().toISOString()
    };
    const output = `[VoiceSep offscreen] ${message}`;
    if (level === 'error') console.error(output, details || '');
    else if (level === 'warn') console.warn(output, details || '');
    else console.info(output, details || '');
    chrome.runtime.sendMessage(entry).catch(() => {});
}

chrome.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'CAPTURE_STREAM_ID') {
        startAudioProcessing(message.streamId);
    } else if (message.type === 'RESET_BUFFER' && worker) {
        worker.postMessage({ type: 'reset' });
    }
});

async function startAudioProcessing(streamId) {
    try {
    log('info', 'Opening captured tab audio stream');
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId
                }
            },
            video: false
        });

        audioCtx = new AudioContext({ sampleRate: 48000 });
        await audioCtx.resume();
        const source = audioCtx.createMediaStreamSource(stream);

        await audioCtx.audioWorklet.addModule('worklet.js');
        workletNode = new AudioWorkletNode(audioCtx, 'voice-sep-processor', {
            outputChannelCount: [2]
        });

        worker = new Worker('worker.js');
        log('info', 'Audio worklet and worker created');

        const { port1, port2 } = new MessageChannel();
        worker.postMessage({ type: 'INIT_PORT', port: port1 }, [port1]);
        workletNode.port.postMessage({ type: 'INIT_PORT', port: port2 }, [port2]);

        source.connect(workletNode);
        workletNode.connect(audioCtx.destination);
        chrome.runtime.sendMessage({ type: 'CAPTURE_READY' });
    
        chrome.runtime.onMessage.addListener((msg) => {
            if (msg.type === 'UPDATE_GAINS') {
                workletNode.port.postMessage(msg);
            }
        });
        workletNode.port.onmessage = (event) => {
            if (event.data.type === 'ENGINE_STATE') {
                chrome.runtime.sendMessage({
                    type: 'ENGINE_STATE',
                    state: event.data.state,
                    reason: event.data.reason
                });
            } else if (event.data.type === 'log') {
                log(event.data.level, event.data.message, event.data.details);
            }
        };
    } catch (error) {
        log('error', 'Audio processing setup failed', error.message);
        chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: error.message });
    }
}
