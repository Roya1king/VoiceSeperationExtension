# Voice Separation Extension - V1 AI-Executable Build Specification (Final Gold)

## 1. Executive Summary & V1 Scope

To ensure V1 is robust, performant, and 100% executable by an AI agent, the scope is strictly limited to the most valuable, achievable feature:

* **V1 Core Goal:** Separate **All Vocals** from **Background Music/Effects** in real-time.
* **Latency & UX:** ~150ms end-to-end latency (measured as `AudioContext.currentTime` at capture minus output). No DOM hacks. Zero-copy architecture.
* **Privacy & Legal:** All processing is on-device. No audio leaves the machine. `tabCapture` is justified for Chrome Web Store as: *"Used only to separate vocals from background music in the active tab at the user's explicit request. No audio is recorded or transmitted."*

---

## 2. Real-Time DSP & Audio Pipeline Contract

### 2.1 Zero-Copy IPC Handshake (No SharedArrayBuffer)
`SharedArrayBuffer` requires COOP/COEP headers which break YouTube. The `AudioWorklet` must communicate directly with the `WebGPU Worker` via a `MessageChannel`. 
**Crucial:** The AudioWorklet cannot create a `MessageChannel` natively. The Main Thread must broker it:

```javascript
// Main thread (offscreen.js) broker:
const { port1, port2 } = new MessageChannel();
worker.postMessage({ port: port1 }, [port1]);
audioWorkletNode.port.postMessage({ port: port2 }, [port2]);

// AudioWorklet (worklet.js) receiver:
this.port.onmessage = (e) => { this.workerPort = e.data.port; };
```
*Transfer 64ms chunks (1024 floats = 4KB) via `this.workerPort.postMessage({ chunk }, [chunk.buffer])`.*

### 2.2 Pre-Processing (Pure JS Resampling)
MV3 CSP (`wasm-unsafe-eval`) makes loading WASM inside an `AudioWorklet` fragile. 
* **Contract:** Implement a **Pure JS 64-tap Polyphase FIR Resampler** to decimate 48kHz stereo down to 16kHz mono. (JS execution costs ~0.2ms per frame, which is negligible).

### 2.3 Overlap-Add & COLA Normalization
* **Windowing:** The AI outputs 1024-sample chunks. Apply a **50% Hann Window** (1024 window, 512 hop).
* **Overlap-Add:** Add the first 512 samples to the tail of the previous chunk's output buffer.
* **COLA Scaling:** *CRITICAL:* A 50% Hann window sums to 2.0. You must **divide the summed output by 2.0** to satisfy Constant Overlap-Add (COLA) and prevent gain doubling/clipping.
* **Stereo Handling (V1 Fallback):** Upsample the 16kHz output to 48kHz. Output Vocals as centered mono (`L += vocals, R += vocals`). Output Background as mono. (Full stereo reconstruction moved to V2).

---

## 3. Worker State Machine & VAD Gating

To prevent the GPU from burning battery on silence, **Silero VAD** must run in the WebGPU Worker (using the `wasm` ORT provider, not WebGPU). The Worker manages a strict state machine, communicating state to the Worklet:

`WorkerState = 'warming' | 'separating' | 'vad_bypass' | 'fallback'`

| State | Worklet Output Behavior |
| :--- | :--- |
| `warming` | Original Audio $\to$ Background slider (Gain 1); Vocals (Gain 0) |
| `separating` | AI Separated Stems $\to$ Vocals & Background sliders |
| `vad_bypass` | Original Audio $\to$ Background slider (Bypasses WebGPU) |
| `fallback` | Original Audio $\to$ Background slider (Graceful failure) |
*(The Worklet must smoothly crossfade over 100ms during any state transition to prevent clicks).*

---

## 4. ML Model Architecture & Training Contract

### 4.1 Stateless Sliding Window TCN
The model uses a stateless sliding window (simplifies ONNX export). 

| Parameter | High-Quality Tier (Default) | Low-Quality Tier (Fallback) |
| :--- | :--- | :--- |
| **Input Window** | 2048 samples (128ms) | 2048 samples (128ms) |
| **Output Chunk** | 1024 samples (64ms) | 1024 samples (64ms) |
| **Encoder** | 256 channels | 128 channels |
| **TCN Layers** | 8 layers | 6 layers |
| **TCN Channels** | 128 channels | 64 channels |
| **Parameters** | ~3 Million | ~800 K |
| **Target RTF** | $< 0.6$ on iGPU | $< 0.3$ on iGPU |
| **ONNX Input** | `input_audio`: float32 `[1, 1, 2048]` | Same |
| **ONNX Output**| `stems`: float32 `[1, 2, 1024]` | Same |

### 4.2 PyTorch Training Hyperparameters (AI Executable)
To train this model from scratch safely for commercial use, use this exact recipe:

| Param | Value |
| :--- | :--- |
| **Datasets (Vocals)** | LibriSpeech (CC BY 4.0), VCTK (CC BY 4.0) |
| **Datasets (Background)**| FMA (CC BY), Jamendo (CC BY), DEMAND (CC BY) |
| **Batch Size & LR** | Batch 16, Adam Optimizer, LR $3e^{-4}$ |
| **LR Schedule** | Cosine Annealing, 200 epochs |
| **Train/Val Split** | 95% / 5% |
| **RIR Dataset** | OpenSLR26 + OpenSLR28 (simulates room reverb) |
| **Mixing SNR Range**| Uniform random between -5 dB to +15 dB |
| **Hardware Target** | 1x A100 40GB (Est. ~72 hours) |

---

## 5. WebGPU Inference Contract (Javascript)

The AI must generate the ONNX Runtime Web wrapper exactly matching this pattern:

```javascript
// 1. Hardware Check & Fallback
const adapter = await navigator.gpu.requestAdapter();
if (!adapter || !adapter.features.has('shader-f16')) {
    workerPort.postMessage({ type: 'state', state: 'fallback', reason: 'No FP16 WebGPU' });
    return;
}

// 2. Initialization
const session = await ort.InferenceSession.create(modelUrl, {
  executionProviders: ['webgpu'],
  graphOptimizationLevel: 'all'
}); // Do NOT use 'gpu-buffer' preferred output to ensure safe CPU readback

// 3. Reset Listener (Fired by background.js on video seek/pause)
self.onmessage = (e) => {
    if (e.data.type === 'reset') { windowBuffer.fill(0); }
};

// 4. Inference Loop (Inside Worker)
const input = new ort.Tensor('float32', windowBuffer, [1, 1, 2048]);
const out = await session.run({ input_audio: input });

const stems = out.stems.data;
const vocals = stems.slice(0, 1024);
const background = stems.slice(1024, 2048);

workerPort.postMessage({ type: 'audio', vocals, background }, [vocals.buffer, background.buffer]);
```

---

## 6. UI / UX Specification (Popup)

```text
┌────────────────────────────────────────────────────────┐
│  🎙️ VoiceSep Engine                          [Active]  │
├────────────────────────────────────────────────────────┤
│  🎵 BACKGROUND MUSIC & EFFECTS                         │
│  [========■==================] 40%         [ MUTE ]    │
│  ▂▃▅ (VU meter)                                        │
├────────────────────────────────────────────────────────┤
│  🗣️ ALL VOCALS                                         │
│  [=================■=========] 80%         [ MUTE ]    │
│  ▂▃▅▇█ (VU meter)                                      │
├────────────────────────────────────────────────────────┤
│  ⚙️ Latency: 150ms | WebGPU: FP16 | VAD: Active        │
└────────────────────────────────────────────────────────┘
```

---

## 7. Test Plan & Acceptance Criteria

The AI must generate a test harness validating the following before marking V1 complete:

* **Unit Tests:** 
  * FIR Resampler SNR $> 80\text{dB}$.
  * COLA scaling (a constant DC input must produce a constant DC output of equal amplitude).
* **Integration Tests:** 
  * Trigger `fallback` state and verify audio plays normally without clicking.
  * Verify `MessageChannel` transfers 1024 floats in $< 1\text{ms}$.
* **ML Tests:** 
  * Run SI-SDR on a held-out test mix. Target $> 12\text{dB}$ improvement.
  * Benchmark RTF (Real-Time Factor). Must be $< 0.6$ on Intel Iris Xe or Apple M1.
* **Manual QA:** 
  * Seek the YouTube video $\to$ ensures background reset fires, no audio glitched loops.
  * Play a 10-second silent video $\to$ ensures VAD state switches to `vad_bypass`.

---

## 8. AI Agent Execution Plan (File Generation Order)

1. **Permissions:** `manifest.json` (MV3, `tabCapture`, `offscreen`).
2. **Plumbing:** `background.js` (Message passing for seek/pause) & `offscreen.html`.
3. **Audio Capture:** `offscreen.js` (Main thread broker for MessageChannel).
4. **DSP Glue:** `worklet.js` (JS FIR Resampler, COLA/Hann, State machine crossfading).
5. **Inference:** `worker.js` (Silero VAD gating, WebGPU ONNX execution, Fallback logic).
6. **UI:** `popup.html` / `popup.js` (Sync sliders).
7. **ML Training:** `train.py` (PyTorch Causal TCN definition and hyperparameter recipe).
