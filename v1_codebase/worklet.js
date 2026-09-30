class VoiceSepProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.workerPort = null;
        this.state = 'warming'; 
        this.gains = { vocals: 0.8, background: 0.8 };
        
        // Rolling buffer for 3:1 decimation (48k -> 16k)
        // V1 Fallback to naive decimation instead of full FIR to save space, but should be polyphase FIR
        this.inputBuffer = new Float32Array(4096);
        this.inputPtr = 0;
        
        // 50% Hann overlap-add for 64ms output (1024 window, 512 hop)
        this.olaBufferVocals = new Float32Array(1024);
        this.olaBufferBg = new Float32Array(1024);
        this.outputRead16 = 0;
        
        this.port.onmessage = (e) => {
            if (e.data.type === 'INIT_PORT') {
                this.workerPort = e.data.port;
                this.workerPort.onmessage = this.handleWorkerMessage.bind(this);
            } else if (e.data.type === 'UPDATE_GAINS') {
                this.gains.vocals = e.data.vocals;
                this.gains.background = e.data.background;
            }
        };
    }

    handleWorkerMessage(e) {
        if (e.data.type === 'log') {
            this.port.postMessage(e.data);
        } else if (e.data.type === 'state') {
            this.state = e.data.state;
            this.port.postMessage({ type: 'ENGINE_STATE', state: this.state, reason: e.data.reason });
        } else if (e.data.type === 'audio') {
            const vocals = e.data.vocals;
            const bg = e.data.background;
            for (let i = 0; i < 1024; i++) {
                const hann = 0.5 * (1 - Math.cos(2 * Math.PI * i / 1023));
                // COLA division by 2.0
                const vocalSample = Number.isFinite(vocals[i]) ? vocals[i] : 0;
                const backgroundSample = Number.isFinite(bg[i]) ? bg[i] : 0;
                this.olaBufferVocals[i] += (vocalSample * hann) / 2.0;
                this.olaBufferBg[i] += (backgroundSample * hann) / 2.0;
            }
        }
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || !input[0] || !this.workerPort) return true;

        const leftIn = input[0];
        const rightIn = input[1] || input[0];
        const outL = output[0];
        const outR = output[1];

        // Decimate 3:1 (Simple placeholder)
        for (let i = 0; i < leftIn.length; i += 3) {
            const mono = (leftIn[i] + rightIn[i]) * 0.5;
            this.inputBuffer[this.inputPtr++] = mono;
            
            if (this.inputPtr >= 1024) {
                const chunk = this.inputBuffer.slice(0, 1024);
                this.workerPort.postMessage({ type: 'chunk', chunk }, [chunk.buffer]);
                
                this.olaBufferVocals.copyWithin(0, 512);
                this.olaBufferVocals.fill(0, 512);
                this.olaBufferBg.copyWithin(0, 512);
                this.olaBufferBg.fill(0, 512);
                this.outputRead16 = Math.max(0, this.outputRead16 - 512);
                
                this.inputPtr = 512;
                this.inputBuffer.copyWithin(0, 512);
            }
        }

        for (let i = 0; i < outL.length; i++) {
            if (this.state === 'separating') {
                const idx16 = this.outputRead16 + Math.floor(i / 3);
                const v = idx16 < 1024 ? this.olaBufferVocals[idx16] : 0;
                const b = idx16 < 1024 ? this.olaBufferBg[idx16] : 0;
                // Output Vocals as centered mono, Background as mono
                const mixed = (v * this.gains.vocals) + (b * this.gains.background);
                const limited = Math.max(-1, Math.min(1, Number.isFinite(mixed) ? mixed : 0));
                outL[i] = limited;
                outR[i] = limited;
            } else {
                // Pass-through / vad_bypass / fallback
                // Until real stems are available, never let a stem control mute the source.
                outL[i] = leftIn[i];
                outR[i] = rightIn[i];
            }
        }
        if (this.state === 'separating') {
            this.outputRead16 += Math.ceil(outL.length / 3);
        }
        return true;
    }
}
registerProcessor('voice-sep-processor', VoiceSepProcessor);
