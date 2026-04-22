console.log("UC Kea Sound Player – script.js v1.1");

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

// Correction factors: { key: { file, dBA, dBKea, label } }
let correctionFactors = {};
// Ordered list of sound keys (filename without extension) from the CSV
let soundFiles = [];

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const audioBuffers = {};

// Session log entries
let sessionLog = [];
let sessionStartTime = "";

// ── Local time formatting ──────────────────────────────
function localDateTime(date) {
  if (!date) date = new Date();
  // Format date and time separately, then get timezone name
  const datePart = date.toLocaleDateString("en-NZ", {
    day: "numeric", month: "numeric", year: "numeric"
  });
  const timePart = date.toLocaleTimeString("en-NZ", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true
  });
  // Get timezone abbreviation
  const tzPart = date.toLocaleString("en-NZ", { timeZoneName: "short" })
    .split(" ").pop();
  return `${datePart}, ${timePart} ${tzPart}`;
}

function localDateOnly(date) {
  if (!date) date = new Date();
  return date.toLocaleDateString("en-NZ"); // e.g. "23/04/2026"
}

// ── Correction Factors CSV ─────────────────────────────
// Format: filename,dBA_correction,dBKea_correction
async function loadCorrectionFactors() {
  try {
    const resp = await fetch("sounds/correction_factors.csv");
    if (!resp.ok) {
      console.warn("No correction_factors.csv found – buttons will be empty.");
      return;
    }
    const text = await resp.text();
    const lines = text.trim().split("\n");
    // Skip header row
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(",").map(s => s.trim());
      if (parts.length < 3) continue;
      const filename = parts[0];
      const dBACorr = parseFloat(parts[1]) || 0;
      const dBKeaCorr = parseFloat(parts[2]) || 0;
      // Key = full filename without extension (used in log)
      const nameNoExt = filename.replace(/\.\w+$/, "");
      // Button label = everything before the last underscore
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

  // Preload all sound files from correction factors
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

  // Preload calibration sound
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
  stopCurrentAudio();
  if (audioCtx.state === "suspended") audioCtx.resume();

  const buffer = audioBuffers[name];
  if (!buffer) {
    console.warn("No decoded buffer for:", name);
    return;
  }

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  const gainNode = audioCtx.createGain();
  const correctionGain = getFileCorrectionGain(name);
  gainNode.gain.value = calibratedGain * correctionGain;
  source.connect(gainNode).connect(audioCtx.destination);
  source.start();

  currentAudio = source;
  currentButton = button;
  button.classList.add("active");

  // Log the playback
  addLogEntry(name, correctionGain);

  source.onended = () => {
    button.classList.remove("active");
    if (currentAudio === source) {
      currentAudio = null;
      currentButton = null;
    }
  };
}

// ── Kea colour palette (from Manu) ─────────────────────
const keaColours = [
  "#6C803A", "#7B5C34", "#AB7C47", "#CCAE42",
  "#D73202", "#272318", "#D3CDBF"
];

// Returns white or black depending on background luminance
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

function toggleCalibration() {
  stopCurrentAudio();
  if (audioCtx.state === "suspended") audioCtx.resume();

  alert("Please turn your device volume all the way up before continuing.");

  const buffer = audioBuffers["_calib"];
  if (!buffer) {
    alert("No calibration sound file found. Please add calib.wav or calib.mp3 to the sounds/ folder.");
    return;
  }

  // Play calibration sound on loop using Web Audio API
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(audioCtx.destination);
  source.start();
  currentAudio = source;

  setTimeout(() => {
    const measured = prompt("Enter measured calibration level (in dB A):");
    stopCurrentAudio();
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

    // Log calibration event
    addCalibrationLogEntry(calibratedMaxDB);
  }, 2000);
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
  const entry = `${timestamp()}\tCALIBRATION\t${level} dB A\t-\t-`;
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
  const entry = `${timestamp()}\t${soundName}\t${sliderLabel}\tCorr: ${corrDB >= 0 ? "+" : ""}${corrDB} dB\tMode: ${currentMode}`;
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
    `Time\tSound\tLevel\tCorrection\tMode`,
    `────────────────────────────────────────────────────────`
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
    // Fallback
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
