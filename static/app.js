'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  source: 'camera',
  mode: 'asl',
  threshold: .70,
  stream: null,
  facing: 'user',
  upload: null,
  uploadURL: null,
  autoTimer: null,
  busy: false,
  last: null,
  selected: null,
  generation: 0,
  voices: [],
};

const ui = {
  serverStatus: $('serverStatus'), serverText: $('serverText'),
  video: $('cameraVideo'), cameraEmpty: $('cameraEmpty'), viewfinder: $('viewfinder'),
  liveIndicator: $('liveIndicator'), cameraNote: $('cameraNote'),
  tabCamera: $('tabCamera'), tabUpload: $('tabUpload'),
  cameraPanel: $('cameraPanel'), uploadPanel: $('uploadPanel'),
  enableCamera: $('enableCamera'), stopCamera: $('stopCamera'), switchCamera: $('switchCamera'),
  mirrorPreview: $('mirrorPreview'),
  input: $('imageInput'), dropzone: $('uploadDropzone'), uploadPrompt: $('uploadPrompt'),
  uploadPreview: $('uploadPreview'), fileName: $('fileName'), removeFile: $('removeFile'),
  recognize: $('recognizeButton'), recognizeLabel: $('recognizeLabel'),
  autoScan: $('autoScanButton'), threshold: $('confidenceThreshold'), thresholdValue: $('thresholdValue'),
  resultStatus: $('resultStatus'), resultPlaceholder: $('resultPlaceholder'), resultContent: $('resultContent'),
  resultLabel: $('resultLabel'), resultConfidence: $('resultConfidence'), resultMessage: $('resultMessage'),
  alternativesList: $('alternativesList'), addPrediction: $('addPrediction'),
  message: $('messageText'), charCount: $('charCount'), copy: $('copyButton'), speak: $('speakButton'),
  voices: $('speechVoice'), toast: $('toast'),
};

let toastTimer;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3900);
}

function setResultStatus(label, kind='waiting') {
  ui.resultStatus.className = 'result-pill ' + kind;
  ui.resultStatus.textContent = label;
}

function setSource(source) {
  if (state.source === source) return;
  stopAutoScan();
  state.source = source;
  state.generation++;
  ui.cameraPanel.hidden = source !== 'camera';
  ui.uploadPanel.hidden = source !== 'upload';
  ui.tabCamera.classList.toggle('selected', source === 'camera');
  ui.tabUpload.classList.toggle('selected', source === 'upload');
  ui.tabCamera.setAttribute('aria-selected', String(source === 'camera'));
  ui.tabUpload.setAttribute('aria-selected', String(source === 'upload'));
  ui.autoScan.hidden = source !== 'camera';
  if (source === 'upload') stopCamera();
  ui.recognizeLabel.textContent = source === 'camera' ? 'Recognize sign' : 'Analyze image';
  clearRecognition();
}

function setMode(mode) {
  if (!['asl','isl','everyday'].includes(mode)) return;
  state.mode = mode;
  state.generation++;
  document.querySelectorAll('[data-mode]').forEach((button) => {
    const selected = button.dataset.mode === mode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  clearRecognition();
  const message = mode === 'everyday'
    ? 'ISL Everyday Life recognizes one of 44 trained words or phrases.'
    : `${mode.toUpperCase()} Alphabet recognizes one letter at a time.`;
  toast(message);
}

function clearRecognition() {
  state.last = null;
  state.selected = null;
  ui.resultPlaceholder.hidden = false;
  ui.resultContent.hidden = true;
  ui.addPrediction.disabled = true;
  setResultStatus('Waiting for sign');
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Camera access requires localhost or HTTPS and a supported browser.');
    return false;
  }
  try {
    stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: state.facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    state.stream = stream;
    ui.video.srcObject = stream;
    await ui.video.play();
    ui.video.classList.add('active');
    ui.viewfinder.hidden = false;
    ui.cameraEmpty.hidden = true;
    ui.stopCamera.disabled = false;
    ui.liveIndicator.textContent = '● Camera ready';
    ui.liveIndicator.classList.add('on');
    ui.cameraNote.textContent = 'Keep your sign inside the green corners.';
    toast('Camera on. Hold one clear sign inside the guide.');
    return true;
  } catch (error) {
    stopCamera();
    toast(`Could not start camera: ${error.name === 'NotAllowedError' ? 'permission denied' : 'check device permissions'}.`);
    return false;
  }
}

function stopCamera() {
  stopAutoScan();
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
  }
  state.stream = null;
  ui.video.pause();
  ui.video.srcObject = null;
  ui.video.classList.remove('active');
  ui.viewfinder.hidden = true;
  ui.cameraEmpty.hidden = false;
  ui.stopCamera.disabled = true;
  ui.liveIndicator.textContent = '● Camera off';
  ui.liveIndicator.classList.remove('on');
  ui.cameraNote.textContent = 'Use good lighting and a plain background.';
}

async function switchCamera() {
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  if (state.stream) await startCamera();
  else toast('Camera preference changed. Enable camera to continue.');
}

function makeCameraFile() {
  return new Promise((resolve, reject) => {
    const w = ui.video.videoWidth;
    const h = ui.video.videoHeight;
    if (!state.stream || !w || !h) {
      reject(new Error('Start your camera first.'));
      return;
    }
    // Crop the center hand guide (square); no mirror is applied to inference.
    const side = Math.floor(Math.min(w * .60, h * .82));
    const x = Math.floor((w - side) / 2);
    const y = Math.floor((h - side) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(ui.video, x, y, side, side, 0, 0, 512, 512);
    canvas.toBlob((blob) => blob
      ? resolve(new File([blob], 'camera-sign.jpg', { type: 'image/jpeg' }))
      : reject(new Error('Could not capture image.')), 'image/jpeg', .88);
  });
}

function setUploadFile(file) {
  if (!file) return;
  if (!['image/png','image/jpeg','image/webp','image/bmp'].includes(file.type)) {
    toast('Choose a JPG, PNG, WEBP or BMP image.');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toast('Image is larger than 8 MB. Choose a smaller photo.');
    return;
  }
  if (state.uploadURL) URL.revokeObjectURL(state.uploadURL);
  state.upload = file;
  state.uploadURL = URL.createObjectURL(file);
  ui.uploadPreview.src = state.uploadURL;
  ui.uploadPreview.hidden = false;
  ui.uploadPrompt.hidden = true;
  ui.fileName.textContent = `${file.name} · ${(file.size/1024/1024).toFixed(2)} MB`;
  ui.removeFile.hidden = false;
  clearRecognition();
}

function removeUpload() {
  state.upload = null;
  if (state.uploadURL) URL.revokeObjectURL(state.uploadURL);
  state.uploadURL = null;
  ui.input.value = '';
  ui.uploadPreview.hidden = true;
  ui.uploadPreview.removeAttribute('src');
  ui.uploadPrompt.hidden = false;
  ui.fileName.textContent = 'No image selected';
  ui.removeFile.hidden = true;
  clearRecognition();
}

function getCandidates() {
  return state.last?.top_predictions || [];
}

function chooseCandidate(index) {
  state.selected = getCandidates()[index] || null;
  if (!state.selected) return;
  ui.resultLabel.textContent = state.selected.label;
  ui.resultLabel.classList.toggle('phrase', state.mode === 'everyday');
  const confidence = state.selected.confidence;
  ui.resultConfidence.textContent = (confidence * 100).toFixed(1) + '%';
  const confident = confidence >= state.threshold;
  ui.addPrediction.disabled = !confident;
  ui.resultMessage.textContent = confident
    ? 'You can add this sign after checking that it matches your gesture.'
    : 'Below your selected score threshold. Try better lighting, another sign, or correct the message manually.';
  setResultStatus(confident ? 'Ready to review' : 'Review carefully', confident ? 'good' : 'low');

  ui.alternativesList.replaceChildren();
  getCandidates().forEach((candidate, candidateIndex) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'candidate' + (candidateIndex === index ? ' selected' : '');
    button.title = 'Select ' + candidate.label;
    button.setAttribute('aria-pressed', String(candidateIndex === index));
    const label = document.createElement('span');
    label.className = 'candidate-label';
    label.textContent = candidate.label;
    const track = document.createElement('span');
    track.className = 'candidate-track';
    const fill = document.createElement('span');
    fill.className = 'candidate-fill';
    fill.style.width = (candidate.confidence * 100).toFixed(1) + '%';
    track.append(fill);
    const score = document.createElement('span');
    score.className = 'candidate-pct';
    score.textContent = (candidate.confidence * 100).toFixed(1) + '%';
    button.append(label, track, score);
    button.addEventListener('click', () => chooseCandidate(candidateIndex));
    ui.alternativesList.append(button);
  });
}

function displayPrediction(data) {
  state.last = data;
  ui.resultPlaceholder.hidden = true;
  ui.resultContent.hidden = false;
  chooseCandidate(0);
}

async function recognize({ live = false } = {}) {
  if (state.busy) return;
  const requestMode = state.mode;
  const generation = state.generation;
  let file;
  try {
    if (state.source === 'camera') {
      if (!state.stream) {
        const active = await startCamera();
        if (!active) return;
      }
      file = await makeCameraFile();
    } else {
      file = state.upload;
      if (!file) {
        toast('Choose a sign image first.');
        return;
      }
    }
    if (generation !== state.generation) return;
    state.busy = true;
    ui.recognize.disabled = true;
    ui.recognizeLabel.textContent = 'Analyzing…';
    setResultStatus('Analyzing image');
    const data = new FormData();
    data.append('file', file);
    data.append('mode', requestMode);
    data.append('threshold', state.threshold.toFixed(2));
    const response = await fetch('/api/predict', { method: 'POST', body: data });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || 'Recognition failed');
    if (generation === state.generation && requestMode === state.mode) {
      displayPrediction(result);
    }
  } catch (error) {
    setResultStatus('Try again', 'error');
    if (!live) toast(error.message || 'Recognition failed');
  } finally {
    state.busy = false;
    ui.recognize.disabled = false;
    ui.recognizeLabel.textContent = state.source === 'camera' ? 'Recognize sign' : 'Analyze image';
  }
}

function stopAutoScan() {
  if (state.autoTimer !== null) clearInterval(state.autoTimer);
  state.autoTimer = null;
  ui.autoScan.setAttribute('aria-pressed', 'false');
  ui.autoScan.classList.remove('pressed');
  ui.autoScan.textContent = '◌ Start live scan';
}

async function toggleAutoScan() {
  if (state.autoTimer !== null) { stopAutoScan(); return; }
  if (!state.stream) {
    const ok = await startCamera();
    if (!ok) return;
  }
  ui.autoScan.classList.add('pressed');
  ui.autoScan.setAttribute('aria-pressed', 'true');
  ui.autoScan.textContent = '■ Stop live scan';
  await recognize({ live: true });
  state.autoTimer = setInterval(() => recognize({ live: true }), 1700);
}

function updateCharCount() {
  const count = [...ui.message.value].length;
  ui.charCount.textContent = `${count} character${count === 1 ? '' : 's'}`;
  try { sessionStorage.setItem('signbridgeDraft', ui.message.value); } catch (_error) { /* private mode */ }
}

function appendText(text, kind) {
  const current = ui.message.value;
  if (kind === 'letter') {
    ui.message.value = current + text.toUpperCase();
  } else {
    const space = current && !/\s$/.test(current) ? ' ' : '';
    ui.message.value = current + space + text;
  }
  updateCharCount();
  ui.message.focus();
  ui.message.setSelectionRange(ui.message.value.length, ui.message.value.length);
}

function addPrediction() {
  if (!state.selected || state.selected.confidence < state.threshold) {
    toast('Select a confident sign, or type a correction in the message.');
    return;
  }
  appendText(state.selected.label, state.mode === 'everyday' ? 'phrase' : 'letter');
  toast(`Added “${state.selected.label}” to your message.`);
}

function speakMessage() {
  const text = ui.message.value.trim();
  if (!text) { toast('Write or recognize a message first.'); return; }
  if (!('speechSynthesis' in window)) { toast('Speech is not supported by this browser.'); return; }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-IN';
  utterance.rate = .93;
  const voiceIndex = ui.voices.value;
  if (voiceIndex !== '' && state.voices[Number(voiceIndex)]) {
    utterance.voice = state.voices[Number(voiceIndex)];
    utterance.lang = utterance.voice.lang;
  }
  window.speechSynthesis.speak(utterance);
}

function populateVoices() {
  if (!window.speechSynthesis) return;
  state.voices = window.speechSynthesis.getVoices();
  const previous = ui.voices.value;
  ui.voices.replaceChildren();
  const defaultOption = new Option('Browser default (English)', '');
  ui.voices.append(defaultOption);
  state.voices.forEach((voice, index) => {
    if (voice.lang.toLowerCase().startsWith('en')) {
      ui.voices.append(new Option(`${voice.name} · ${voice.lang}`, String(index)));
    }
  });
  if ([...ui.voices.options].some((option) => option.value === previous)) ui.voices.value = previous;
}

async function copyMessage() {
  const text = ui.message.value.trim();
  if (!text) { toast('Nothing to copy yet.'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast('Message copied to clipboard.');
  } catch (_error) {
    ui.message.focus();
    ui.message.select();
    const copied = document.execCommand('copy');
    toast(copied ? 'Message copied.' : 'Select and copy the message manually.');
  }
}

async function loadAppInfo() {
  try {
    const [healthResponse, modelsResponse] = await Promise.all([
      fetch('/api/health'), fetch('/api/models')
    ]);
    if (!healthResponse.ok || !modelsResponse.ok) throw new Error('Backend unavailable');
    const health = await healthResponse.json();
    const data = await modelsResponse.json();
    ui.serverStatus.classList.add('ready');
    ui.serverText.textContent = `${health.models_loaded}/3 models ready`;
    renderModelCards(data.models);
  } catch (_error) {
    ui.serverStatus.classList.add('error');
    ui.serverText.textContent = 'Backend offline';
    toast('Model server is offline. Start the Python website server first.');
  }
}

function renderModelCards(models) {
  const holder = $('modelCards');
  holder.replaceChildren();
  models.forEach((model) => {
    const card = document.createElement('article');
    card.className = 'metric-card';
    const name = document.createElement('p'); name.textContent = model.name;
    const accuracy = document.createElement('strong'); accuracy.textContent = (model.test_accuracy * 100).toFixed(2) + '%';
    const note = document.createElement('small'); note.textContent = `Test accuracy · ${model.test_images.toLocaleString()} images · ${model.class_count} classes`;
    card.append(name, accuracy, note);
    holder.append(card);
  });
}

function registerEvents() {
  ui.tabCamera.addEventListener('click', () => setSource('camera'));
  ui.tabUpload.addEventListener('click', () => setSource('upload'));
  ui.enableCamera.addEventListener('click', startCamera);
  ui.stopCamera.addEventListener('click', stopCamera);
  ui.switchCamera.addEventListener('click', switchCamera);
  ui.mirrorPreview.addEventListener('change', () => ui.video.classList.toggle('mirrored', ui.mirrorPreview.checked));
  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });
  ui.threshold.addEventListener('input', () => {
    state.threshold = Number(ui.threshold.value) / 100;
    ui.thresholdValue.textContent = ui.threshold.value + '%';
    if (state.selected) chooseCandidate(getCandidates().indexOf(state.selected));
  });
  ui.input.addEventListener('change', () => setUploadFile(ui.input.files[0]));
  ui.removeFile.addEventListener('click', removeUpload);
  for (const eventName of ['dragenter','dragover']) {
    ui.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault(); ui.dropzone.classList.add('dragover');
    });
  }
  for (const eventName of ['dragleave','drop']) {
    ui.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault(); ui.dropzone.classList.remove('dragover');
      if (eventName === 'drop') setUploadFile(event.dataTransfer.files[0]);
    });
  }
  ui.recognize.addEventListener('click', () => recognize());
  ui.autoScan.addEventListener('click', toggleAutoScan);
  ui.addPrediction.addEventListener('click', addPrediction);
  ui.message.addEventListener('input', updateCharCount);
  $('spaceButton').addEventListener('click', () => appendText(' ', 'letter'));
  $('backspaceButton').addEventListener('click', () => {
    ui.message.value = [...ui.message.value].slice(0, -1).join('');
    updateCharCount(); ui.message.focus();
  });
  $('clearButton').addEventListener('click', () => {
    if (!ui.message.value) return;
    if (window.confirm('Clear your message?')) { ui.message.value = ''; updateCharCount(); }
  });
  ui.copy.addEventListener('click', copyMessage);
  ui.speak.addEventListener('click', speakMessage);
  $('stopSpeech').addEventListener('click', () => window.speechSynthesis?.cancel());
  document.querySelectorAll('[data-phrase]').forEach((button) => {
    button.addEventListener('click', () => appendText(button.dataset.phrase, 'phrase'));
  });
  if ('speechSynthesis' in window) {
    populateVoices(); window.speechSynthesis.onvoiceschanged = populateVoices;
  }
  try { ui.message.value = sessionStorage.getItem('signbridgeDraft') || ''; } catch (_error) { /* private mode */ }
  updateCharCount();
  window.addEventListener('pagehide', () => { stopCamera(); window.speechSynthesis?.cancel(); });
}

registerEvents();
loadAppInfo();
