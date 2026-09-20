importScripts('node_modules/onnxruntime-web/dist/ort.min.js');

let session = null;
let workletPort = null;
let windowBuffer = new Float32Array(2048);
let inferenceBusy = false;
const ENABLE_MODEL_OUTPUT = false;

function log(level, message, details) {
    const entry = {
        type: 'log',
        source: 'extension-worker',
        level,
        message,
        details: details || null,
        timestamp: new Date().toISOString()
    };
    const output = `[VoiceSep worker] ${message}`;
    if (level === 'error') console.error(output, details || '');
    else if (level === 'warn') console.warn(output, details || '');
    else console.info(output, details || '');
    if (workletPort) workletPort.postMessage(entry);
}

function errorMessage(error) {
    return error && error.message ? error.message : String(error);
}

async function initWebGPU() {
    try {
        if (!ENABLE_MODEL_OUTPUT) {
            throw new Error('Model output disabled: model.onnx was exported with untrained random weights. Using clean pass-through audio.');
        }
        log('info', 'Checking WebGPU support');
        if (!navigator.gpu) {
            throw new Error('WebGPU is unavailable in the worker. Enable hardware acceleration in Chrome or use a current Chrome/Edge version.');
        }
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error('WebGPU returned no adapter. Check hardware acceleration and GPU drivers.');
        }
        if (!adapter.features.has('shader-f16')) {
            throw new Error('This GPU does not support WebGPU FP16 (shader-f16).');
        }
        ort.env.wasm.wasmPaths = new URL('node_modules/onnxruntime-web/dist/', self.location.href).toString();
        log('info', 'Configured local ONNX Runtime assets', ort.env.wasm.wasmPaths);
        log('info', 'Loading model.onnx');
        session = await ort.InferenceSession.create('model.onnx', {
            executionProviders: ['webgpu'],
            graphOptimizationLevel: 'all'
        });
        log('info', 'Model loaded; waiting for audio frames');
        if (workletPort) workletPort.postMessage({ type: 'state', state: 'warming', reason: 'Model loaded; waiting for audio frames.' });
    } catch (e) {
        const reason = errorMessage(e);
        log('error', 'Separation initialization failed', reason);
        if (workletPort) workletPort.postMessage({ type: 'state', state: 'fallback', reason });
    }
}

self.onmessage = (e) => {
    if (e.data.type === 'INIT_PORT') {
        workletPort = e.data.port;
        workletPort.onmessage = handleAudioChunk;
        log('info', 'Worker connected to audio worklet');
        initWebGPU();
    } else if (e.data.type === 'reset') {
        windowBuffer.fill(0);
        log('info', 'Audio window reset');
    }
};

async function handleAudioChunk(e) {
    if (e.data.type !== 'chunk') return;
    const chunk = e.data.chunk;
    
    // Shift rolling window and append new 1024 samples
    windowBuffer.copyWithin(0, 1024);
    windowBuffer.set(chunk, 1024);

    if (!session) return; // Still warming up or fallback
    if (inferenceBusy) return; // The session does not support overlapping runs.

    try {
        // Pseudo-VAD check would go here for vad_bypass
        inferenceBusy = true;
        const inputWindow = windowBuffer.slice();
        const input = new ort.Tensor('float32', inputWindow, [1, 1, 2048]);
        const out = await session.run({ input_audio: input });
        
        workletPort.postMessage({ type: 'state', state: 'separating' });
        
        const stems = out.stems.data;
        const vocals = stems.slice(0, 1024);
        const background = stems.slice(1024, 2048);
        
        workletPort.postMessage({ type: 'audio', vocals, background }, [vocals.buffer, background.buffer]);
    } catch (err) {
        const reason = errorMessage(err);
        log('error', 'Inference failed; using pass-through audio', reason);
        workletPort.postMessage({ type: 'state', state: 'fallback', reason });
    } finally {
        inferenceBusy = false;
    }
}
