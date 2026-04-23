console.log("UC Kea Sound Player – script.js v2.0");

// ── State ──────────────────────────────────────────────
let currentMode = "dBA";          // "dBA" or "dBKea"
let isCalibrated = false;
let calibratedMaxDB = null;
let sliderMinDB = -100;
let sliderMaxDB = 0;
let currentSliderDB = 0;
let calibratedGain = 1;

let currentAudio = null;
let currentButton = null;
let isSequencePlaying = false;
let isReversed = false;

// Correction factors: { key: { file, dBA, dBKea, label } }
let correctionFactors = {};
// Ordered list of sound keys (filename without extension) from the CSV
let soundFiles = [];

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const audioBuffers = {};

// Session log entries
let sessionLog = [];
let sessionStartTime = "";

const DEFAULT_SEQUENCE = "X,3,X,55,X,3,X,55";

// ── Local time formatting ──────────────────────────────
function localDateTime(date) {
  if (!date) date = new Date();
  const datePart = date.toLocaleDateString("en-NZ", {
    day: "numeric", month: "numeric", year: "numeric"
  });
  const timePart = date.toLocaleTimeString("en-NZ", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true
  });
  const tzPart = date.toLocaleString("en-NZ", { timeZoneName: "short" })
    .split(" ").pop();
  return `${datePart}, ${timePart} ${tzPart}`;
}

function localDateOnly(date) {
  if (!date) date = new Date();
  return date.toLocaleDateString("en-NZ");
}

// ── Correction Factors CSV ─────────────────────────────
async function loadCorrectionFactors() {
  try {
    const resp = await fetch("sounds/correction_factors.csv");
    if (!resp.ok) {
      console.warn("No correction_factors.csv found – buttons will be empty.");
      return;
    }
    const text = await resp.text();
    const lines = text.trim().split("\n");
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(",").map(s => s.trim());
      if (parts.length < 3) continue;
      const filename = parts[0];
      const dBACorr = parseFloat(parts[1]) || 0;
      const dBKeaCorr = parseFloat(parts[2]) || 0;
      const nameNoExt = filename.replace(/\.\w+$/, "");
      const lastUnderscore = nameNoExt.lastIndexOf("_");
      const label = lastUnderscore > 0 ? nameNoExt.substring(0, lastUnderscore) : nameNoExt;
      correctionFactors[nameNoExt] = {
        file: filename, dBA: dBACorr, dBKea: dBKeaCorr, label: label
      };
      soundFiles.push(nameNoExt);
    }
    console.log(`Loaded ${soundFiles.length} sounds from correction_factors.csv`);
  } catch (e) {
    console.error("Error loading correction factors:", e);
  }
}

// ── Preload Sounds ─────────────────────────────────────
async function preloadSounds() {
  const promises = [];

  for (const name of soundFiles) {
    const info = correctionFactors[name];
    const url = `sounds/${info.file}`;
    promises.push(
      fetch(url)
        .then(r => r.arrayBuffer())
        .then(buf => audioCtx.decodeAudioData(buf))
        .then(decoded => { audioBuffers[name] = decoded; })
        .catch(err => console.warn(`Could not load ${url}:`, err))
    );
  }

  const calibUrl = "sounds/calib.wav";
  promises.push(
    fetch(calibUrl)
      .then(r => {
        if (!r.ok) throw new Error("calib.wav not found");
        return r.arrayBuffer();
      })
      .then(buf => audioCtx.decodeAudioData(buf))
      .then(decoded => {
        audioBuffers["_calib"] = decoded;
        console.log("Calibration sound loaded: calib.wav");
      })
      .catch(err => console.warn("Could not load calib.wav:", err))
  );

  await Promise.all(promises);
}

// ── Gain / Slider ──────────────────────────────────────
function updateGainFromSlider() {
  const slider = document.getElementById("volume");
  let rawValue = parseFloat(slider.value);

  if (isCalibrated) {
    const max = parseFloat(slider.max);
    const tolerance = 0.25;
    const snapped = (Math.abs(rawValue - max) <= tolerance)
      ? max
      : Math.round(rawValue / 5) * 5;
    slider.value = snapped;
    currentSliderDB = snapped;
    const unit = currentMode === "dBKea" ? "dB Kea" : "dB A";
    document.getElementById("dB-label").textContent = `${snapped} ${unit}`;
    const attenuation = calibratedMaxDB - snapped;
    calibratedGain = Math.pow(10, -attenuation / 20);
  } else {
    const snapped = Math.round(rawValue / 5) * 5;
    slider.value = snapped;
    currentSliderDB = snapped;
    document.getElementById("dB-label").textContent = `${snapped} dB FS`;
    calibratedGain = Math.pow(10, snapped / 20);
  }
}

// ── Sequence Parsing ───────────────────────────────────
// "X" = play sample, number = seconds of silence
// e.g. "X,3,X,55,X,3,X,55"
function parseSequence(str) {
  const parts = str.split(",").map(s => s.trim());
  const seq = [];
  for (const p of parts) {
    if (p.toUpperCase() === "X") {
      seq.push({ type: "sound" });
    } else {
      const secs = parseFloat(p);
      if (!isNaN(secs) && secs > 0) {
        seq.push({ type: "silence", seconds: secs });
      }
    }
  }
  return seq;
}

// ── Buffer Assembly ────────────────────────────────────
// Build a single AudioBuffer from sequence + source sample
function buildSequenceBuffer(sampleBuffer, sequence, reverse) {
  const sampleRate = sampleBuffer.sampleRate;
  const numChannels = sampleBuffer.numberOfChannels;

  // Get sample data (optionally reversed)
  const sampleData = [];
  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = sampleBuffer.getChannelData(ch).slice();
    if (reverse) channelData.reverse();
    sampleData.push(channelData);
  }
  const sampleLength = sampleData[0].length;

  // Calculate total length
  let totalFrames = 0;
  for (const step of sequence) {
    if (step.type === "sound") {
      totalFrames += sampleLength;
    } else {
      totalFrames += Math.round(step.seconds * sampleRate);
    }
  }

  // Create output buffer
  const output = audioCtx.createBuffer(numChannels, totalFrames, sampleRate);

  // Fill it
  let offset = 0;
  for (const step of sequence) {
    if (step.type === "sound") {
      for (let ch = 0; ch < numChannels; ch++) {
        output.getChannelData(ch).set(sampleData[ch], offset);
      }
      offset += sampleLength;
    } else {
      // Silence: just advance offset (buffer is zero-filled by default)
      offset += Math.round(step.seconds * sampleRate);
    }
  }

  return output;
}

// ── UI State During Sequence Playback ──────────────────
function setButtonsDisabled(disabled) {
  const container = document.getElementById("buttons-container");
  const buttons = container.querySelectorAll("button");
  buttons.forEach(btn => {
    btn.disabled = disabled;
    btn.style.opacity = disabled ? "0.4" : "1";
  });
  // Also disable calibration during playback
  const calibBtn = document.getElementById("calibrate-btn");
  if (calibBtn) calibBtn.disabled = disabled;
}

function showStopButton() {
  let stopBtn = document.getElementById("stop-btn");
  if (!stopBtn) {
    stopBtn = document.createElement("button");
    stopBtn.id = "stop-btn";
    stopBtn.className = "stop-btn";
    stopBtn.textContent = "Stop";
    stopBtn.onclick = stopSequence;
    document.getElementById("sequence-controls").appendChild(stopBtn);
  }
  stopBtn.style.display = "inline-block";
}

function hideStopButton() {
  const stopBtn = document.getElementById("stop-btn");
  if (stopBtn) stopBtn.style.display = "none";
}

function stopSequence() {
  stopCurrentAudio();
  isSequencePlaying = false;
  setButtonsDisabled(false);
  hideStopButton();
}

// ── Audio Playback ─────────────────────────────────────
function stopCurrentAudio() {
  if (currentAudio && currentAudio.stop) {
    try { currentAudio.stop(); } catch (e) {}
  }
  currentAudio = null;
  if (currentButton) currentButton.classList.remove("active");
  currentButton = null;
}

function getFileCorrectionGain(name) {
  const info = correctionFactors[name];
  if (!info) return 1;
  const corrDB = currentMode === "dBKea" ? info.dBKea : info.dBA;
  return Math.pow(10, corrDB / 20);
}

function playSound(name, button) {
  // Don't allow if a sequence is already playing
  if (isSequencePlaying) return;

  stopCurrentAudio();
  // Stop calibration if it's running
  if (calibrationSource) {
    stopCalibrationSound();
    const calibBtn = document.getElementById("calibrate-btn");
    calibBtn.textContent = "Calibration";
    calibBtn.classList.remove("active");
  }
  if (audioCtx.state === "suspended") audioCtx.resume();

  const buffer = audioBuffers[name];
  if (!buffer) {
    console.warn("No decoded buffer for:", name);
    return;
  }

  // Parse sequence
  const seqInput = document.getElementById("sequence-input");
  const seqStr = seqInput ? seqInput.value.trim() : "X";
  const sequence = parseSequence(seqStr);

  if (sequence.length === 0) {
    console.warn("Empty sequence");
    return;
  }

  // Save sequence to localStorage
  localStorage.setItem("keaSequence", seqStr);

  // Build the assembled buffer
  const assembledBuffer = buildSequenceBuffer(buffer, sequence, isReversed);

  // Play it
  const source = audioCtx.createBufferSource();
  source.buffer = assembledBuffer;
  const gainNode = audioCtx.createGain();
  const correctionGain = getFileCorrectionGain(name);
  gainNode.gain.value = calibratedGain * correctionGain;
  source.connect(gainNode).connect(audioCtx.destination);
  source.start();

  currentAudio = source;
  currentButton = button;
  button.classList.add("active");
  isSequencePlaying = true;
  setButtonsDisabled(true);
  // Keep the active button visually distinct even when "disabled"
  button.style.opacity = "1";
  showStopButton();

  // Log the playback
  addLogEntry(name, correctionGain);

  source.onended = () => {
    button.classList.remove("active");
    if (currentAudio === source) {
      currentAudio = null;
      currentButton = null;
    }
    isSequencePlaying = false;
    setButtonsDisabled(false);
    hideStopButton();
  };
}

// ── Kea colour palette (from Manu) ─────────────────────
const keaColours = [
  "#6C803A", "#7B5C34", "#AB7C47", "#CCAE42",
  "#D73202", "#272318", "#D3CDBF"
];

function contrastText(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.5 ? "#000000" : "#ffffff";
}

// ── Build Sound Buttons ────────────────────────────────
function createButtons() {
  const container = document.getElementById("buttons-container");
  container.innerHTML = "";

  soundFiles.forEach((name, i) => {
    const bg = keaColours[i % keaColours.length];
    const btn = document.createElement("button");
    btn.textContent = correctionFactors[name].label;
    btn.style.backgroundColor = bg;
    btn.style.color = contrastText(bg);
    btn.dataset.keaColor = bg;
    btn.onclick = () => playSound(name, btn);
    container.appendChild(btn);
  });
}

// ── Forward / Reverse Toggle ───────────────────────────
function toggleDirection() {
  isReversed = !isReversed;
  localStorage.setItem("keaReversed", isReversed ? "true" : "false");
  const btn = document.getElementById("direction-btn");
  btn.textContent = isReversed ? "Reverse" : "Forward";
  btn.classList.toggle("active", isReversed);
}

// ── Mode Toggle (dB A / dB Kea) ────────────────────────
function setMode(mode) {
  currentMode = mode;
  localStorage.setItem("keaMode", mode);
  document.getElementById("btn-dba").classList.toggle("active", mode === "dBA");
  document.getElementById("btn-dbkea").classList.toggle("active", mode === "dBKea");
  updateGainFromSlider();
}

// ── Calibration ────────────────────────────────────────
function showTestButton() {
  let testButton = document.getElementById("test-sound");
  if (!testButton) {
    testButton = document.createElement("button");
    testButton.id = "test-sound";
    testButton.textContent = "Test Calibrated Sound";
    testButton.className = "calibrate";
    testButton.onclick = () => {
      stopCurrentAudio();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const buffer = audioBuffers["_calib"];
      if (!buffer) {
        console.warn("No calibration sound buffer available");
        return;
      }
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = calibratedGain;
      source.connect(gainNode).connect(audioCtx.destination);
      source.start();
      currentAudio = source;
      currentButton = testButton;
      testButton.classList.add("active");
      source.onended = () => {
        testButton.classList.remove("active");
        if (currentAudio === source) {
          currentAudio = null;
          currentButton = null;
        }
      };
    };
    document.querySelector(".controls").appendChild(testButton);
  }
}

let calibrationSource = null;

function toggleCalibration() {
  const calibBtn = document.getElementById("calibrate-btn");

  if (calibrationSource) {
    stopCalibrationSound();
    calibBtn.textContent = "Calibration";
    calibBtn.classList.remove("active");

    const measured = prompt("Enter measured calibration level (in dB A):");
    if (!measured || isNaN(measured)) return;

    calibratedMaxDB = parseFloat(measured);
    isCalibrated = true;
    sliderMaxDB = calibratedMaxDB;
    sliderMinDB = Math.floor(calibratedMaxDB / 5) * 5 - 60;

    const slider = document.getElementById("volume");
    slider.min = sliderMinDB;
    slider.max = sliderMaxDB;
    slider.step = 0.1;
    slider.value = sliderMaxDB;

    document.getElementById("mode-badge").textContent = "Calibrated Mode";
    updateGainFromSlider();
    showTestButton();

    localStorage.setItem("keaCalibration", JSON.stringify({
      level: calibratedMaxDB,
      timestamp: new Date().toISOString()
    }));

    addCalibrationLogEntry(calibratedMaxDB);
    return;
  }

  stopCurrentAudio();
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }

  const buffer = audioBuffers["_calib"];
  if (!buffer) {
    alert("No calibration sound file found. Please add calib.wav to the sounds/ folder.");
    return;
  }

  alert("Turn your device volume all the way up, then tap OK to play the calibration tone.");

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(audioCtx.destination);
  source.start();
  calibrationSource = source;

  calibBtn.textContent = "Stop & Enter Level";
  calibBtn.classList.add("active");
}

function stopCalibrationSound() {
  if (calibrationSource) {
    try { calibrationSource.stop(); } catch (e) {}
    calibrationSource = null;
  }
}

function applyStoredCalibration(data) {
  calibratedMaxDB = data.level;
  isCalibrated = true;
  sliderMaxDB = calibratedMaxDB;
  sliderMinDB = Math.floor(calibratedMaxDB / 5) * 5 - 60;

  const slider = document.getElementById("volume");
  slider.min = sliderMinDB;
  slider.max = sliderMaxDB;
  slider.step = 0.1;
  slider.value = sliderMaxDB;

  document.getElementById("mode-badge").textContent = "Calibrated Mode";
  updateGainFromSlider();
  showTestButton();
}

// ── Session Log ────────────────────────────────────────
function timestamp() {
  return localDateTime();
}

function addCalibrationLogEntry(level) {
  const entry = `${timestamp()}\tCALIBRATION\t${level} dB A\t-\t-\t-\t-`;
  sessionLog.push(entry);
  renderLog();
}

function addLogEntry(soundName, correctionGain) {
  const corrDB = correctionFactors[soundName]
    ? (currentMode === "dBKea" ? correctionFactors[soundName].dBKea : correctionFactors[soundName].dBA)
    : 0;
  const sliderLabel = isCalibrated
    ? `${currentSliderDB} ${currentMode === "dBKea" ? "dB Kea" : "dB A"}`
    : `${currentSliderDB} dB FS`;
  const seqInput = document.getElementById("sequence-input");
  const seqStr = seqInput ? seqInput.value.trim() : "X";
  const direction = isReversed ? "Rev" : "Fwd";
  const entry = `${timestamp()}\t${soundName}\t${sliderLabel}\tCorr: ${corrDB >= 0 ? "+" : ""}${corrDB} dB\t${currentMode}\t${direction}\t${seqStr}`;
  sessionLog.push(entry);
  renderLog();
}

function buildFullLog() {
  const header = [
    `UC Kea Sound Player – Session Log`,
    `Session started: ${sessionStartTime}`,
    `Calibration: ${isCalibrated ? calibratedMaxDB + " dB A" : "Uncalibrated"}`,
    `Mode: ${currentMode}`,
    ``,
    `Time\tSound\tLevel\tCorrection\tMode\tDirection\tSequence`,
    `────────────────────────────────────────────────────────────────────────`
  ];
  return header.join("\n") + "\n" + sessionLog.join("\n");
}

function renderLog() {
  const el = document.getElementById("log-output");
  el.textContent = buildFullLog();
  el.scrollTop = el.scrollHeight;
}

function copyLog() {
  const text = buildFullLog();
  navigator.clipboard.writeText(text).then(() => {
    alert("Log copied to clipboard.");
  }).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    alert("Log copied to clipboard.");
  });
}

function downloadLog() {
  const text = buildFullLog();
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kea_session_log_${localDateOnly()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function emailLog() {
  const text = buildFullLog();
  const subject = encodeURIComponent(`Kea Sound Player Log – ${localDateOnly()}`);
  const body = encodeURIComponent(text);
  window.location.href = `mailto:?subject=${subject}&body=${body}`;
}

function clearLog() {
  if (!confirm("Clear the session log?")) return;
  sessionLog = [];
  sessionStartTime = localDateTime();
  renderLog();
}

// ── Init ───────────────────────────────────────────────
window.onload = async () => {
  sessionStartTime = localDateTime();

  await loadCorrectionFactors();
  await preloadSounds();

  createButtons();

  // Restore mode
  const savedMode = localStorage.getItem("keaMode");
  if (savedMode === "dBA" || savedMode === "dBKea") {
    currentMode = savedMode;
  }
  setMode(currentMode);

  // Set up slider
  const slider = document.getElementById("volume");
  slider.min = -100;
  slider.max = 0;
  slider.step = 0.1;
  slider.value = 0;
  slider.addEventListener("input", updateGainFromSlider);
  slider.addEventListener("change", updateGainFromSlider);
  slider.addEventListener("touchend", updateGainFromSlider);
  updateGainFromSlider();

  // Restore sequence
  const savedSeq = localStorage.getItem("keaSequence");
  const seqInput = document.getElementById("sequence-input");
  seqInput.value = savedSeq || DEFAULT_SEQUENCE;
  seqInput.addEventListener("change", () => {
    localStorage.setItem("keaSequence", seqInput.value.trim());
  });

  // Restore direction
  const savedDir = localStorage.getItem("keaReversed");
  if (savedDir === "true") {
    isReversed = true;
    const dirBtn = document.getElementById("direction-btn");
    dirBtn.textContent = "Reverse";
    dirBtn.classList.add("active");
  }

  // Hide stop button initially
  hideStopButton();

  // Restore calibration
  const storedCal = localStorage.getItem("keaCalibration");
  if (storedCal) {
    const data = JSON.parse(storedCal);
    const formatted = localDateTime(new Date(data.timestamp));
    const msg = `You last calibrated this device to ${data.level} dB A on ${formatted}. Use this calibration?`;
    if (confirm(msg)) {
      alert("Remember to turn your device volume to full.");
      applyStoredCalibration(data);
    }
  }

  renderLog();
};
