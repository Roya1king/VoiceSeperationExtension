const startButton = document.getElementById('startBtn');
const status = document.getElementById('status');
const logOutput = document.getElementById('log');
const sliders = [document.getElementById('bgVol'), document.getElementById('vocVol')];

function renderEngineState(state, reason) {
    const separating = state === 'separating';
    sliders.forEach((slider) => {
        slider.disabled = !separating;
    });
    if (separating) {
        status.textContent = 'Separation active';
    } else if (state === 'fallback') {
        status.textContent = `Pass-through active: ${reason || 'separation unavailable'}`;
    } else if (state === 'warming') {
        status.textContent = 'Loading separation model...';
    }
}

function renderLog(entry) {
    if (!entry) return;
    const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '--:--:--';
    const details = entry.details ? `\n${entry.details}` : '';
    logOutput.textContent = `[${time}] ${entry.level.toUpperCase()}: ${entry.message}${details}`;
}

function renderState(state, error) {
    if (state === 'starting') {
        startButton.textContent = 'Starting...';
        startButton.disabled = true;
        status.textContent = 'Connecting to tab audio...';
    } else if (state === 'active') {
        startButton.textContent = 'Capturing';
        startButton.disabled = true;
        status.textContent = 'Pass-through active; separation is not ready';
    } else if (state === 'error') {
        startButton.textContent = 'Start Capture';
        startButton.disabled = false;
        status.textContent = error || 'Capture failed';
    } else {
        startButton.textContent = 'Start Capture';
        startButton.disabled = false;
        status.textContent = 'Not capturing';
    }
}

startButton.addEventListener('click', () => {
    renderState('starting');
    chrome.runtime.sendMessage({ type: 'START_CAPTURE' });
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'CAPTURE_STATE') {
        renderState(message.state, message.error);
    } else if (message.type === 'ENGINE_STATE') {
        renderEngineState(message.state, message.reason);
    } else if (message.type === 'ENGINE_LOG') {
        renderLog(message);
    }
});

chrome.runtime.sendMessage({ type: 'GET_LATEST_LOG' }, renderLog);

chrome.runtime.sendMessage({ type: 'GET_CAPTURE_STATE' }, (response) => {
    if (response) {
        renderState(response.state);
        if (response.engineState) renderEngineState(response.engineState);
    }
});

function updateGains() {
    const vocals = parseFloat(document.getElementById('vocVol').value);
    const bg = parseFloat(document.getElementById('bgVol').value);
    chrome.runtime.sendMessage({ type: 'UPDATE_GAINS', vocals, background: bg });
}

document.getElementById('vocVol').addEventListener('input', updateGains);
document.getElementById('bgVol').addEventListener('input', updateGains);

document.getElementById('muteVoc').addEventListener('click', () => {
    document.getElementById('vocVol').value = 0;
    updateGains();
});
document.getElementById('muteBg').addEventListener('click', () => {
    document.getElementById('bgVol').value = 0;
    updateGains();
});

sliders.forEach((slider) => {
    slider.disabled = true;
});
