const micSelect = document.getElementById('mic-select');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusDiv = document.getElementById('status');
const funnySlider = document.getElementById('funny-slider');
const funnyValue = document.getElementById('funny-value');
const glitchFrequencyInput = document.getElementById('glitch-frequency');
const soundFrequencyInput = document.getElementById('sound-frequency');
const outputDeviceSelect = document.getElementById('output-device');
const playbackToggle = document.getElementById('playback-toggle');
const helpBtn = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const closeHelp = document.getElementById('close-help');

let audioContext;
let source;
let stream;
let selectedDeviceId = null;
let distortion;
let glitchNode;
let glitchTimer;
let glitchActive = false;
let lastGlitchType = null;
let glitchFrequency = parseFloat(glitchFrequencyInput.value) || 2.5;

let soundGlitchTimer;
let soundGlitchActive = false;
let soundGlitchBuffer = null;
let soundGlitchPlayIndex = 0;
let soundGlitchName = null;
let soundGlitchSamplesLeft = 0;

// List of available sound files in the sounds folder
let SOUND_FILES = [];
const SOUND_FOLDER = 'sounds/';
const SOUNDS_MANIFEST = SOUND_FOLDER + 'sounds.json';
const EFFECTS = [
  'bitcrush', 'stutter', 'mute', 'pitch', 'extra-distortion',
  'repeat-last-ms', 'reverse', 'static-noise', 'mic-peak',
  'echo', 'catchup'
];
let enabledSounds = {};
let enabledEffects = {};
EFFECTS.forEach(e => enabledEffects[e] = true);

async function loadSoundManifest() {
  try {
    const resp = await fetch(SOUNDS_MANIFEST);
    SOUND_FILES = await resp.json();
    SOUND_FILES.forEach(f => enabledSounds[f] = true);
    renderCheckboxes();
  } catch (e) {
    statusDiv.textContent = 'error: could not load sounds.json';
    SOUND_FILES = [];
  }
}

function renderCheckboxes() {
  // Sound checkboxes
  const soundDiv = document.getElementById('sound-checkboxes');
  soundDiv.innerHTML = '<b>sounds:</b>';
  SOUND_FILES.forEach(f => {
    const id = 'sound-cb-' + f.replace(/[^a-z0-9]/gi, '-');
    const label = document.createElement('label');
    label.htmlFor = id;
    label.innerText = f;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = enabledSounds[f];
    cb.addEventListener('change', () => {
      enabledSounds[f] = cb.checked;
    });
    label.prepend(cb);
    soundDiv.appendChild(label);
  });
  // Effect checkboxes
  const effectDiv = document.getElementById('effect-checkboxes');
  effectDiv.innerHTML = '<b>effects:</b>';
  EFFECTS.forEach(e => {
    const id = 'effect-cb-' + e;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.innerText = e;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = enabledEffects[e];
    cb.addEventListener('change', () => {
      enabledEffects[e] = cb.checked;
    });
    label.prepend(cb);
    effectDiv.appendChild(label);
  });
}

async function listMicrophones() {
  micSelect.innerHTML = '';
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === 'audioinput');
  mics.forEach(mic => {
    const option = document.createElement('option');
    option.value = mic.deviceId;
    option.textContent = mic.label || `microphone ${micSelect.length + 1}`;
    micSelect.appendChild(option);
  });
  if (mics.length === 0) {
    statusDiv.textContent = 'no microphones found';
    startBtn.disabled = true;
  } else {
    statusDiv.textContent = '';
    startBtn.disabled = false;
  }
}

micSelect.addEventListener('change', () => {
  selectedDeviceId = micSelect.value;
});

function makeDistortionCurve(amount) {
  const k = typeof amount === 'number' ? amount : 0;
  const n_samples = 44100;
  const curve = new Float32Array(n_samples);
  const deg = Math.PI / 180;
  let i = 0;
  for (; i < n_samples; ++i) {
    const x = (i * 2) / n_samples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

funnySlider.addEventListener('input', () => {
  funnyValue.textContent = funnySlider.value;
  if (distortion) {
    distortion.curve = makeDistortionCurve(funnySlider.value * 10);
  }
});

function getRandomGlitchType() {
  const types = EFFECTS.filter(e => enabledEffects[e]);
  if (types.length === 0) return null;
  let pick;
  do {
    pick = types[Math.floor(Math.random() * types.length)];
  } while (pick === lastGlitchType && types.length > 1);
  lastGlitchType = pick;
  return pick;
}

function getRandomEnabledSound() {
  const enabled = SOUND_FILES.filter(f => enabledSounds[f]);
  if (enabled.length === 0) return null;
  return enabled[Math.floor(Math.random() * enabled.length)];
}

const soundEffectBuffers = {};

async function loadSoundEffect(context, name) {
  if (soundEffectBuffers[name]) return soundEffectBuffers[name];
  try {
    const response = await fetch(SOUND_FOLDER + name);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    soundEffectBuffers[name] = audioBuffer;
    return audioBuffer;
  } catch (e) {
    return null;
  }
}

function createGlitchNode(context) {
  const node = context.createScriptProcessor(1024, 1, 1);
  let glitchType = null;
  let glitchTime = 0;
  let stutterBuffer = [];
  let stutterIndex = 0;
  let stutterActive = false;
  let repeatLastMsBuffer = [];
  let repeatLastMsActive = false;
  let reverseBuffer = [];
  let reverseActive = false;
  // echo
  let echoBuffer = new Float32Array(44100 * 0.3); // 300ms echo
  let echoIndex = 0;
  // sound effect
  let sfxBuffer = null;
  let sfxPlayIndex = 0;
  let sfxName = null;
  // catchup
  let catchupState = 'idle'; // 'idle', 'muting', 'catchingup'
  let catchupBuffer = [];
  let catchupMuteSamples = 0;
  let catchupPlaySamples = 0;
  let catchupPlayIndex = 0;
  node.onaudioprocess = async function(e) {
    const input = e.inputBuffer.getChannelData(0);
    const output = e.outputBuffer.getChannelData(0);
    // --- Sound glitch mixing ---
    let soundMix = new Float32Array(input.length);
    let loudOverride = (soundGlitchActive && soundGlitchName && soundGlitchName.toLowerCase() === 'loud.mp3');
    if (soundGlitchActive && soundGlitchBuffer) {
      // Set volume: LOUD.mp3 gets 4.0, others get 0.5
      let sfxVolume = (soundGlitchName && soundGlitchName.toLowerCase() === 'loud.mp3') ? 4.0 : 0.5;
      for (let i = 0; i < input.length; i++) {
        let sample = soundGlitchBuffer.getChannelData(0)[soundGlitchPlayIndex] || 0;
        sample *= sfxVolume;
        sample += (Math.random() * 2 - 1) * 0.05;
        if (i > 0) sample = (sample + soundMix[i - 1]) / 2;
        soundMix[i] = sample;
        soundGlitchPlayIndex++;
        soundGlitchSamplesLeft--;
        if (soundGlitchPlayIndex >= soundGlitchBuffer.length) {
          soundGlitchActive = false;
          soundGlitchBuffer = null;
          soundGlitchPlayIndex = 0;
          soundGlitchName = null;
          soundGlitchSamplesLeft = 0;
          break;
        }
      }
    }
    // --- End sound glitch mixing ---
    if (loudOverride) {
      for (let i = 0; i < input.length; i++) output[i] = soundMix[i];
      return;
    }
    if (!glitchActive) {
      for (let i = 0; i < input.length; i++) output[i] = input[i] + soundMix[i];
      catchupState = 'idle';
      catchupBuffer = [];
      catchupMuteSamples = 0;
      catchupPlaySamples = 0;
      catchupPlayIndex = 0;
      return;
    }
    switch (glitchType) {
      case 'bitcrush': {
        for (let i = 0; i < input.length; i++) {
          output[i] = Math.round(input[i] * 7) / 7;
        }
        break;
      }
      case 'stutter': {
        if (!stutterActive) {
          stutterBuffer = Array.from(input);
          stutterIndex = 0;
          stutterActive = true;
        }
        for (let i = 0; i < input.length; i++) {
          output[i] = stutterBuffer[stutterIndex];
          stutterIndex = (stutterIndex + 1) % stutterBuffer.length;
        }
        break;
      }
      case 'mute': {
        for (let i = 0; i < input.length; i++) output[i] = 0;
        break;
      }
      case 'pitch': {
        for (let i = 0; i < input.length; i++) {
          output[i] = input[Math.floor(i * 1.2) % input.length];
        }
        break;
      }
      case 'extra-distortion': {
        for (let i = 0; i < input.length; i++) {
          let v = input[i] * 4;
          output[i] = Math.max(-0.3, Math.min(0.3, v));
        }
        break;
      }
      case 'repeat-last-ms': {
        // 1ms at 44100Hz = 44 samples
        const ms = 44;
        if (!repeatLastMsActive) {
          repeatLastMsBuffer = input.slice(-ms);
          repeatLastMsActive = true;
        }
        for (let i = 0; i < input.length; i++) {
          output[i] = repeatLastMsBuffer[i % ms] || 0;
        }
        break;
      }
      case 'reverse': {
        if (!reverseActive) {
          reverseBuffer = Array.from(input).reverse();
          reverseActive = true;
        }
        for (let i = 0; i < input.length; i++) {
          output[i] = reverseBuffer[i];
        }
        break;
      }
      case 'static-noise': {
        for (let i = 0; i < input.length; i++) {
          output[i] = (Math.random() * 2 - 1) * 0.2;
        }
        break;
      }
      case 'mic-peak': {
        // Amplify and hard clip
        for (let i = 0; i < input.length; i++) {
          let v = input[i] * 10;
          output[i] = Math.max(-1, Math.min(1, v));
        }
        break;
      }
      case 'echo': {
        for (let i = 0; i < input.length; i++) {
          const dry = input[i];
          const wet = echoBuffer[echoIndex];
          output[i] = dry + 0.5 * wet;
          echoBuffer[echoIndex] = dry + 0.5 * wet;
          echoIndex = (echoIndex + 1) % echoBuffer.length;
        }
        break;
      }
      case 'catchup': {
        // States: 'muting' (buffer input, output silence), then 'catchingup' (play buffer at 4x speed over 0.25s), then done
        const sampleRate = 44100;
        if (catchupState === 'idle') {
          catchupState = 'muting';
          catchupBuffer = [];
          catchupMuteSamples = sampleRate * 1.0; // 1 second
          catchupPlaySamples = sampleRate * 0.25; // 0.25 seconds
          catchupPlayIndex = 0;
        }
        if (catchupState === 'muting') {
          // Buffer input, output silence
          for (let i = 0; i < input.length; i++) {
            if (catchupBuffer.length < catchupMuteSamples) {
              catchupBuffer.push(input[i]);
            }
            output[i] = 0;
          }
          if (catchupBuffer.length >= catchupMuteSamples) {
            catchupState = 'catchingup';
            catchupPlayIndex = 0;
            // Prevent new glitches from starting
            glitchActive = true;
          }
        } else if (catchupState === 'catchingup') {
          // Play buffer at 4x speed over 0.25s, output only catchup (not mixed with live mic)
          for (let i = 0; i < input.length; i++) {
            let catchupSample = 0;
            if (catchupPlayIndex < catchupMuteSamples) {
              // 4x speed: skip 4 samples for each output sample
              catchupSample = catchupBuffer[Math.floor(catchupPlayIndex)] || 0;
              catchupPlayIndex += 4;
            }
            output[i] = catchupSample * 1.2; // a bit louder for clarity
          }
          if (catchupPlayIndex >= catchupMuteSamples) {
            catchupState = 'idle';
            catchupBuffer = [];
            catchupMuteSamples = 0;
            catchupPlaySamples = 0;
            catchupPlayIndex = 0;
            glitchActive = false; // end glitch after catchup
          }
        }
        break;
      }
      default: {
        for (let i = 0; i < input.length; i++) output[i] = input[i] + soundMix[i];
      }
    }
    if (glitchType !== 'stutter') stutterActive = false;
    if (glitchType !== 'repeat-last-ms') repeatLastMsActive = false;
    if (glitchType !== 'reverse') reverseActive = false;
    if (glitchType !== 'catchup' && catchupState !== 'idle') {
      catchupState = 'idle';
      catchupBuffer = [];
      catchupMuteSamples = 0;
      catchupPlaySamples = 0;
      catchupPlayIndex = 0;
    }
    if (glitchType !== 'echo') {
      echoBuffer.fill(0);
      echoIndex = 0;
    }
    if (glitchType !== 'echo') {
      sfxBuffer = null;
      sfxPlayIndex = 0;
      sfxName = null;
    }
  };
  node.setGlitch = function(type) {
    glitchType = type;
    if (type === 'catchup') {
      statusDiv.textContent = 'glitch: catchup (muting, then fast-forward)';
    }
  };
  return node;
}

function startGlitchLoop() {
  if (glitchTimer) clearTimeout(glitchTimer);
  function triggerGlitch() {
    const glitchType = getRandomGlitchType();
    glitchActive = true;
    if (glitchNode) glitchNode.setGlitch(glitchType);
    statusDiv.textContent = `glitch: ${glitchType}`;
    setTimeout(() => {
      glitchActive = false;
      if (glitchNode) glitchNode.setGlitch(null);
      statusDiv.textContent = 'playing back microphone';
      glitchFrequency = parseFloat(glitchFrequencyInput.value) || 2.5;
      glitchTimer = setTimeout(triggerGlitch, glitchFrequency * 1000 + Math.random() * 1000);
    }, 200 + Math.random() * 400); // glitch lasts 200-600ms
  }
  glitchFrequency = parseFloat(glitchFrequencyInput.value) || 2.5;
  glitchTimer = setTimeout(triggerGlitch, glitchFrequency * 1000 + Math.random() * 1000);
}

function stopGlitchLoop() {
  if (glitchTimer) clearTimeout(glitchTimer);
  glitchActive = false;
  if (glitchNode) glitchNode.setGlitch(null);
}

function startSoundGlitchLoop(audioContext) {
  if (soundGlitchTimer) clearTimeout(soundGlitchTimer);
  function triggerSoundGlitch() {
    const soundName = getRandomEnabledSound();
    if (!soundName) {
      soundGlitchActive = false;
      return;
    }
    soundGlitchName = soundName;
    soundGlitchBuffer = soundEffectBuffers[soundGlitchName];
    soundGlitchPlayIndex = 0;
    soundGlitchSamplesLeft = soundGlitchBuffer ? soundGlitchBuffer.length : 0;
    soundGlitchActive = true;
    statusDiv.textContent = `sound glitch: ${soundGlitchName}`;
    // Schedule next
    const soundFrequency = parseFloat(soundFrequencyInput.value) || 8;
    soundGlitchTimer = setTimeout(triggerSoundGlitch, soundFrequency * 1000 + Math.random() * 1000);
  }
  const soundFrequency = parseFloat(soundFrequencyInput.value) || 8;
  soundGlitchTimer = setTimeout(triggerSoundGlitch, soundFrequency * 1000 + Math.random() * 1000);
}

function stopSoundGlitchLoop() {
  if (soundGlitchTimer) clearTimeout(soundGlitchTimer);
  soundGlitchActive = false;
  soundGlitchBuffer = null;
  soundGlitchPlayIndex = 0;
  soundGlitchName = null;
  soundGlitchSamplesLeft = 0;
}

glitchFrequencyInput.addEventListener('input', () => {
  glitchFrequency = parseFloat(glitchFrequencyInput.value) || 2.5;
  if (glitchTimer) {
    startGlitchLoop(); // restart loop with new frequency
  }
});

soundFrequencyInput.addEventListener('input', () => {
  const soundFrequency = parseFloat(soundFrequencyInput.value) || 8;
  if (soundGlitchTimer) {
    startSoundGlitchLoop(audioContext);
  }
});

// Populate output device dropdown
async function listOutputDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const outputs = devices.filter(d => d.kind === 'audiooutput');
  outputDeviceSelect.innerHTML = '';
  outputs.forEach(device => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `output ${outputDeviceSelect.length + 1}`;
    outputDeviceSelect.appendChild(option);
  });
  if (outputs.length > 0) {
    selectedOutputDeviceId = outputs[0].deviceId;
  }
}

outputDeviceSelect.addEventListener('change', () => {
  selectedOutputDeviceId = outputDeviceSelect.value;
  // In browser, setSinkId is only supported on HTMLMediaElement, not AudioContext
  // In Electron/Tauri, native code is needed for true routing
});

playbackToggle.addEventListener('change', () => {
  // This will be checked in the audio routing logic
});

helpBtn.addEventListener('click', () => {
  helpModal.style.display = 'flex';
});
closeHelp.addEventListener('click', () => {
  helpModal.style.display = 'none';
});

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  statusDiv.textContent = 'starting...';
  try {
    if (audioContext) audioContext.close();
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined }
    });
    // Preload all sound effects
    for (const sfx of SOUND_FILES) {
      soundEffectBuffers[sfx] = await loadSoundEffect(audioContext, sfx);
    }
    source = audioContext.createMediaStreamSource(stream);
    distortion = audioContext.createWaveShaper();
    distortion.curve = makeDistortionCurve(funnySlider.value * 10);
    distortion.oversample = '4x';
    glitchNode = createGlitchNode(audioContext);
    source.connect(distortion);
    distortion.connect(glitchNode);
    // Playback routing
    if (playbackToggle.checked) {
      // In browser, we can only play to default output
      glitchNode.connect(audioContext.destination);
      // In Electron/Tauri, native code can route to selectedOutputDeviceId
    } else {
      // Disconnect from destination (no local playback)
      try { glitchNode.disconnect(audioContext.destination); } catch {}
    }
    statusDiv.textContent = 'playing back microphone';
    startGlitchLoop();
    startSoundGlitchLoop(audioContext);
  } catch (err) {
    statusDiv.textContent = 'error: ' + err.message;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

stopBtn.addEventListener('click', () => {
  if (source) source.disconnect();
  if (distortion) distortion.disconnect();
  if (glitchNode) glitchNode.disconnect();
  if (audioContext) audioContext.close();
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
  stopGlitchLoop();
  stopSoundGlitchLoop();
  statusDiv.textContent = 'stopped';
  startBtn.disabled = false;
  stopBtn.disabled = true;
});

window.addEventListener('DOMContentLoaded', async () => {
  await listMicrophones();
  selectedDeviceId = micSelect.value;
  await loadSoundManifest();
  await listOutputDevices();
}); 