# Real-Time On-Device Speaker Separation & Mixing Chrome Extension
## Production System Architecture, Requirements & Technical Specification (V2)

---

## 1. Executive Summary & Value Proposition

This project is an **on-device, zero-server-cost Chrome Extension (Manifest V3)** that performs real-time audio separation on browser media (such as YouTube videos, podcasts, and streams). 

### Core Features
* **Individual Speaker Volume Sliders:** Independently boost, reduce, or mute overlapping speakers (e.g., host vs. guest).
* **Unified Background Music & Instruments Filter:** Groups all background instruments, soundtrack beats, and non-speech ambience into a dedicated slider to eliminate annoying background music.
* **Zero Cloud Latency & $0 Operating Cost:** Runs deep learning models (Causal DPRNN/SUDO-RM-RF, Silero VAD) locally on the user's graphics card via **WebGPU (FP16)** and **ONNX Runtime Web**.
* **High-Fidelity 48kHz Stereo Preservation:** Uses a subband crossover architecture to isolate voices while keeping the background music in full-width stereo.

---

## 2. Requirements & System Compatibility

### 2.1 Hardware Requirements
* **GPU:** Modern iGPU (Intel Iris Xe, Apple Silicon) or Dedicated GPU (NVIDIA, AMD) supporting WebGPU compute shaders and `shader-f16` (FP16 math).
* **System RAM:** 4 GB minimum (8 GB recommended).
* **Local Storage:** ~50 MB for one-time cached ONNX model weights.

### 2.2 Software & Browser Requirements
* **Browser:** Google Chrome **120+**, Microsoft Edge 120+, or Chromium browsers with native WebGPU and `shader-f16` enabled.

---

## 3. Chrome Permissions & User Experience Flow

### 3.1 Chrome Permissions (`manifest.json`)
* **`tabCapture`**: Intercepts the digital audio stream (No microphone permission required).
* **`offscreen`**: Hosts the WebGPU/WebAudio environment without lagging the UI.
* **`storage`**: Caches user preferences and model weights.
* **`activeTab`**: Grants tab access only upon user gesture (clicking the extension).

### 3.2 User Flow & Pass-Through Mitigation
To solve the 2-3 second WebGPU "Cold Start" model compilation lag:
* **Transparent Audio Pass-Through:** Normal unaltered audio plays immediately upon opening the tab. 
* The extension crossfades into separated channels only once WebGPU signals `Ready`.

---

## 4. System Architecture & Audio Pipeline

```
                                [ YouTube Tab 48kHz Stereo ]
                                              │
                      Audio-Only Capture (chrome.tabCapture)
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       OFFSCREEN DOCUMENT (WebGPU & DSP)                     │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ Multiband Crossover Splitter                                          │  │
│  │ ├─ Low-Band (0-8 kHz, Downmixed to 16kHz Mono)  ───────────┐          │  │
│  │ └─ High-Band (8-24 kHz) + Stereo Side (L-R) (Bypassed) ────│────────┐ │  │
│  └────────────────────────────────────────────────────────────│────────│─┘  │
│                                                               ▼        │    │
│  ┌───────────────────────┐        Speech Detected   ┌───────────────┐  │    │
│  │ Silero VAD (WebGPU)   ├─────────────────────────►│ Causal DPRNN  │  │    │
│  └──────────┬────────────┘                          │ (FP16 WebGPU) │  │    │
│             │ Silence                               │ (<80ms delay) │  │    │
│             ▼                                       └───────┬───────┘  │    │
│     (Bypass Separation)                                     │          │    │
│                                     ┌───────────────────────┴──────┐   │    │
│                                     ▼                              ▼   │    │
│                              ┌─────────────┐                ┌─────────────┐ │
│                              │ Voice 1 Mask│                │ Voice 2 Mask│ │
│                              │ (STFT)      │                │ (STFT)      │ │
│                              └──────┬──────┘                └──────┬──────┘ │
│                                     │                              │        │
│  ┌──────────────────────────────────┴──────────────────────────────┴─────┐  │
│  │ Frame-to-Frame Cross-Correlation & Voiceprint Lock                    │  │
│  │ Tracks causal hidden states and CAM++ embeddings to prevent swapping. │  │
│  └──────────────────────────────────┬──────────────────────────────┬─────┘  │
│                                     │                              │        │
│  ┌──────────────────────────────────┴──────────────────────────────┴─────┐  │
│  │ STFT Soft Masking for Background Music & Instruments                  │  │
│  │ Bg_Mask = 1.0 - min(1.0, Voice1_Mask + Voice2_Mask)                   │  │
│  │ Music_LowBand = Bg_Mask * Original_LowBand (Prevents Comb Filtering)  │  │
│  └──────────────────────────────────┬──────────────────────────────┬─────┘  │
│                                     ▼                              ▼        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ 48kHz Stereo Reconstructor & AudioWorklet Mixer                       │  │
│  │ ├─ GainNode: Background (Music_LowBand + Bypassed High-Band/Side) ◄─│──┘ │
│  │ ├─ GainNode: Speaker 1 (Centered 16kHz upsampled)                     │  │
│  │ └─ GainNode: Speaker 2 (Centered 16kHz upsampled)                     │  │
│  └──────────────────────────────────────┬────────────────────────────────┘  │
└─────────────────────────────────────────┼───────────────────────────────────┘
                                          ▼
                                [ Audio Destination ]
```

---

## 5. Architectural Solutions (The "Gotchas")

### 5.1 A/V Sync & Latency (<80ms)
* **Problem:** Waiting 500ms to process chunks ruins lip-sync on videos.
* **Solution:** We use **Causal Streaming Models** (e.g., streaming DPRNN or SUDO-RM-RF) operating on 32ms frames. Total algorithmic latency is **~74ms**, keeping audio perfectly in sync with the native YouTube video. **No DOM takeover or video delay is required.**

### 5.2 AI Model & Precision (FP16 vs INT8)
* **Problem:** ONNX WebGPU struggles with INT8 quantization, causing silent CPU fallbacks. Pretrained WSJ0 models fail on YouTube noise.
* **Solution:** Use **FP16 (`shader-f16`)** execution for hardware-accelerated WebGPU inference. Target a 2-speaker model trained on **WHAMR! or LibriMix** (speech + noise/reverb) for robust real-world performance.

### 5.3 STFT Background Masking (No Comb Filtering)
* **Problem:** Subtracting audio tracks in the time domain ($Original - Voices$) causes severe phase cancellation and hollow artifacts.
* **Solution:** Generate frequency-domain magnitude masks (STFT). The background music mask is $1 - M_{voice}$. Multiplying this mask against the original audio preserves original acoustic phase and eliminates vocal bleed cleanly.

### 5.4 48kHz Stereo Preservation
* **Problem:** Speech models operate at 16kHz mono. Downmixing everything makes the music sound like AM radio.
* **Solution:** The **Subband Crossover** routes only the 0-8kHz Mid channel to the AI. The 8-24kHz High-Band and Stereo Side ($L-R$) channels are preserved and remixed into the background slider, yielding **full 48kHz wide-stereo music**.

### 5.5 Speaker Permutation Tracking
* **Problem:** Model outputs can flip (Speaker 1 becomes Speaker 2 mid-sentence).
* **Solution:** We use short-term **Frame-to-Frame Cross-Correlation** on overlapping 32ms tails to prevent instant swaps, backed by long-term **CAM++ Voiceprint** embeddings updated every 2 seconds to anchor the sliders to the correct identities.

---

## 6. UI / UX Specification (Popup)

```
┌────────────────────────────────────────────────────────┐
│  🎙️ VoiceSep Engine                          [Active]  │
├────────────────────────────────────────────────────────┤
│  🎵 BACKGROUND & INSTRUMENTS                           │
│  Music / Sound Effects                                 │
│  [========■==================] 40%  [ MUTE ]           │
│  ▂▃▅ (Music VU meter)                                  │
├────────────────────────────────────────────────────────┤
│  🗣️ VOICES                                             │
│  Speaker 1 (Host)        ● [Speaking]                  │
│  [=================■=========] 80%  [ MUTE ]  [ SOLO ] │
│  ▂▃▅▇█ (Active voice meter)                            │
│                                                        │
│  Speaker 2 (Guest)       ○ [Silent]                    │
│  [=======================■===] 100% [ MUTE ]  [ SOLO ] │
│  __                                                    │
├────────────────────────────────────────────────────────┤
│  ⚙️ Latency: 74ms | WebGPU: FP16 | Causal Model        │
└────────────────────────────────────────────────────────┘
```
