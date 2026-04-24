const CONFIG = {
  GEMINI_API_KEY: "ADD_YOUR_API_KEY",
  MAPS_API_KEY: "ADD_YOUR_API_KEY",
  ALERT_COOLDOWN: 10000,
  ALERT_COOLDOWN_MS: 10000,
  ZONE_UPDATE_INTERVAL: 3000,
  AI_ANALYSIS_INTERVAL: 5000,
  SPEECH_QUEUE_DELAY: 800,
  DETECTION_INTERVAL_MS: 1000,
  GEMINI_MODEL: "gemini-2.5-flash"
};

window.voiceEnabled = false;
window.surgeCount = 0;
window.activeSurges = { left: false, center: false, right: false };
window.sessionStartTime = Date.now();
let lastAlertTime = 0;

// Dynamically load Google Maps
(function loadGoogleMaps() {
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.MAPS_API_KEY}&callback=initMap`;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
})();
let speechQueue = [];
let isSpeaking = false;
window.speechSynthesis.onvoiceschanged = () => {
  window.speechSynthesis.getVoices();
};
let lastAlertState = {
  A: "",
  B: "",
  C: ""
};
let isLoading = false;
let zoneA, zoneB, zoneC;
let aiInterval;

// 🔐 API keys are now in CONFIG

// ================= MAP =================
function initMap() {
  const location = { lat: 15.8497, lng: 74.4977 };

  const map = new google.maps.Map(document.getElementById("map"), {
    zoom: 14,
    center: location,
  });

  new google.maps.Marker({
    position: location,
    map: map,
    title: "Crowd Zone",
  });

  // Zones
  zoneA = new google.maps.Circle({
    strokeColor: "#FF0000",
    fillColor: "#FF0000",
    fillOpacity: 0.35,
    map,
    center: location,
    radius: 80,
  });

  zoneB = new google.maps.Circle({
    strokeColor: "#FFFF00",
    fillColor: "#FFFF00",
    fillOpacity: 0.35,
    map,
    center: { lat: 15.8515, lng: 74.4950 },
    radius: 80,
  });

  zoneC = new google.maps.Circle({
    strokeColor: "#00FF00",
    fillColor: "#00FF00",
    fillOpacity: 0.35,
    map,
    center: { lat: 15.8480, lng: 74.5000 },
    radius: 80,
  });

  setInterval(updateZones, CONFIG.ZONE_UPDATE_INTERVAL);
}

// ================= ZONE LOGIC =================
function simulateDensity(zone, timeMs) {
  let offset = 0;
  if (zone === 'B') offset = Math.PI * 2 / 3;
  if (zone === 'C') offset = Math.PI * 4 / 3;

  // Sine wave returning a value between 0 and 100
  // Period is ~60 seconds (timeMs / 10000)
  const sinValue = Math.sin((timeMs / 10000) + offset);
  return ((sinValue + 1) / 2) * 100;
}

function updateZones() {
  const now = Date.now();
  // Divide by 100 to map it back to 0-1 range for the zone rendering logic
  const crowdA = simulateDensity('A', now);
  const crowdB = simulateDensity('B', now);
  const crowdC = simulateDensity('C', now);
  if(window.zoneA && window.zoneB && window.zoneC) {
    updateZoneStyle(zoneA, crowdA, "A");
    updateZoneStyle(zoneB, crowdB, "B");
    updateZoneStyle(zoneC, crowdC, "C");
  }
}

function updateZoneStyle(zone, level, zoneName) {
  if(!zone) return;
  let color;
  let status;

  if (level > 0.7) {
    color = "#FF0000";
    status = "HIGH";
  } else if (level > 0.4) {
    color = "#FFFF00";
    status = "MEDIUM";
  } else {
    color = "#00FF00";
    status = "LOW";
  }

  zone.setOptions({
    fillColor: color,
    strokeColor: color,
    radius: 200 + level * 300
  });

  // 🚨 AUTO ALERT TRIGGER
  if (status === "HIGH" && lastAlertState[zoneName] !== "HIGH") {
    lastAlertState[zoneName] = "HIGH";
    generateSmartAlert(zoneName);
  }

  if (status !== "HIGH") {
    lastAlertState[zoneName] = status;
  }
}

// ================= CAMERA =================
document.addEventListener("DOMContentLoaded", () => {
  loadDetector();

  const reportBtn = document.getElementById("report-btn");
  if (reportBtn) reportBtn.addEventListener("click", generateReport);

  const closeBtn = document.getElementById("close-modal");
  if (closeBtn) closeBtn.addEventListener("click", () => {
    document.getElementById("report-modal").classList.add("hidden");
  });

  const copyBtn = document.getElementById("copy-report-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      if (window.currentReportText) {
        try {
          await navigator.clipboard.writeText(window.currentReportText);
          const orig = copyBtn.innerText;
          copyBtn.innerText = "Copied!";
          setTimeout(() => { copyBtn.innerText = orig; }, 2000);
        } catch (e) { }
      }
    });
  }

  const voiceBtn = document.getElementById("voice-toggle-btn");
  if (voiceBtn) {
    voiceBtn.addEventListener("click", () => {
      window.voiceEnabled = !window.voiceEnabled;
      voiceBtn.innerText = `🔊 Voice Alerts: ${window.voiceEnabled ? "ON" : "OFF"}`;
    });
  }

  const camBtn = document.getElementById("start-camera-btn");
  if (camBtn) {
    camBtn.addEventListener("click", () => {

      // 🔊 UNLOCK SPEECH (VERY IMPORTANT)
      const synth = window.speechSynthesis;
      const temp = new SpeechSynthesisUtterance("System ready");
      synth.speak(temp);
      synth.cancel(); // stop immediately (just unlocks audio)

      initializeFeed(); // your existing function
    });
  }

  const analyzeBtn = document.getElementById("analyze-btn");
  if (analyzeBtn) {
    analyzeBtn.addEventListener("click", analyzeCrowd);
  }
});

async function loadDetector() {
  const statusEl = document.getElementById("model-status");
  if (statusEl) statusEl.innerText = "⏳ Loading AI model...";
  try {
    window.detector = await cocoSsd.load();
    if (statusEl) statusEl.innerText = "✅ AI Model Ready";
    console.log("Model loaded");
  } catch (err) {
    console.error("Model load failed", err);
    window.detector = null;
    if (statusEl) statusEl.innerText = "⚠️ AI unavailable";
  }
}

async function initializeFeed() {
  const video = document.getElementById("webcam");
  if (!video) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });
    window.camAvailable = true;
  } catch (err) {
    window.camAvailable = false;
    let errorDiv = document.getElementById("cam-error");
    if (!errorDiv) {
      errorDiv = document.createElement("div");
      errorDiv.id = "cam-error";
      video.parentElement.appendChild(errorDiv);
    }
    errorDiv.innerText = "📷 Camera unavailable — running in simulation mode";
    errorDiv.style.display = "block";
    alert("Allow camera permission.");
  }

  if (window.camAvailable) {
    video.srcObject = stream;
    await video.play();
    video.classList.remove("hidden");

    const placeholder = document.getElementById("video-placeholder");
    if (placeholder) placeholder.classList.add("hidden");

    if (!aiInterval) {
      aiInterval = setInterval(analyzeCrowd, CONFIG.AI_ANALYSIS_INTERVAL);
    }
  }
}

// ================= AI ANALYSIS =================
async function analyzeCrowd() {
  console.log("Analyzing crowd levels...");
  const badge = document.getElementById("ai-processing-badge");
  if (badge) badge.classList.remove("hidden");

  // Determine levels based on colors
  const getLevel = (zone) => {
    if (!zone) return "LOW";
    const color = zone.get("fillColor");
    if (color === "#FF0000") return "HIGH";
    if (color === "#FFFF00") return "MEDIUM";
    return "LOW";
  };

  const statusA = getLevel(zoneA);
  const statusB = getLevel(zoneB);
  const statusC = getLevel(zoneC);

  // Sends a simple text prompt to Gemini (no image)
  const prompt = `Simulated crowd data:
Zone A: ${statusA}
Zone B: ${statusB}
Zone C: ${statusC}

Based on this data, give a short, actionable safety alert or recommendation.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            { parts: [{ text: prompt }] }
          ]
        })
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Logs full response in console
    console.log("Full Gemini Response:", data);

    // Parses response safely using optional chaining and does not crash if response is empty
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "✅ Status clear, no immediate alerts.";

    displayAlert(text, statusA === "HIGH" || statusB === "HIGH" || statusC === "HIGH" ? "danger" : "warning");

  } catch (err) {
    console.error("Gemini API Error:", err);
    // Fallback response for demo reliability
    displayAlert(`⚠️ Simulated AI Alert: Crowd levels tracked. (A: ${statusA}, B: ${statusB}, C: ${statusC}). API offline.`, "warning");
  } finally {
    if (badge) badge.classList.add("hidden");
  }
}
async function generateSmartAlert(zoneName) {
  const now = Date.now();

  if (now - lastAlertTime < CONFIG.ALERT_COOLDOWN) {
    return; // ⛔ skip if too soon
  }

  lastAlertTime = now;
  const prompt = `Crowd density is extremely high in Zone ${zoneName}. Give a short emergency safety alert for people.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ]
        }),
      }
    );

    const data = await response.json();

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      `⚠️ High crowd detected in Zone ${zoneName}`;

    document.getElementById("alerts").innerText = text;

    // 🔊 SPEAK IT
    speakAlert(text);

  } catch (err) {
    console.error(err);
  }
}


function speakAlert(message) {
  const emergencyMessage =
    "Attention please! Emergency alert! " +
    message +
    " Please move to a safer area immediately.";

  speechQueue.push(emergencyMessage);

  processSpeechQueue();
}

function processSpeechQueue() {
  const synth = window.speechSynthesis;

  if (isSpeaking || speechQueue.length === 0) return;

  isSpeaking = true;

  const message = speechQueue.shift();

  const speech = new SpeechSynthesisUtterance(message);

  speech.lang = "en-US";
  speech.rate = 0.85;
  speech.pitch = 0.8;

  // ✅ Load voices properly
  const voices = synth.getVoices();
  const preferred = voices.find(v =>
    v.name.includes("Google") ||
    v.name.includes("Male") ||
    v.name.includes("David") ||
    v.name.includes("Alex")
  );

  if (preferred) speech.voice = preferred;

  speech.onend = () => {
    isSpeaking = false;
    setTimeout(processSpeechQueue, CONFIG.SPEECH_QUEUE_DELAY);
  };

  speech.onerror = (e) => {
    console.error("Speech error:", e);
    isSpeaking = false;
  };

  synth.speak(speech);
}

function speak(text) {
  if (!window.voiceEnabled) return;
  if (!window.speechSynthesis) return;
  if (window.speechSynthesis.speaking) return;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.9;
  utterance.pitch = 1;
  utterance.volume = 1;
  window.speechSynthesis.speak(utterance);
}

function displayAlert(message, severity = "inactive") {
  const logContainer = document.getElementById("alert-log");
  if (!logContainer) return;

  const entry = document.createElement("div");
  entry.className = "alert-entry";

  const now = new Date();
  const timestamp = String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0');

  let borderColor = "#22c55e"; // green
  if (message.includes("Critical") || message.includes("High")) {
    borderColor = "#ef4444"; // red
  } else if (message.includes("Moderate")) {
    borderColor = "#eab308"; // yellow
  }

  entry.style.borderLeft = `4px solid ${borderColor}`;

  entry.innerHTML = `<span style="color: #94a3b8; font-family: monospace; margin-right: 8px;">[${timestamp}]</span> <span style="color: #f8fafc;">${message}</span>`;

  logContainer.prepend(entry);

  while (logContainer.children.length > 10) {
    logContainer.removeChild(logContainer.lastChild);
  }

  logContainer.scrollTo({ top: 0, behavior: 'smooth' });

  if (message.includes("Critical") || message.includes("High") || message.includes("SURGE")) {
    if (typeof speak === "function") {
      speak(message);
    }
  }
}

window.densityHistory = { left: [], center: [], right: [] };

function detectSurge(zone, history) {
  if (!history || history.length < 3) return false;
  const n = history.length;
  const last = history[n - 1];
  const prev1 = history[n - 2];
  const prev2 = history[n - 3];
  return last > 8 && last > prev1 && prev1 > prev2;
}

async function detectZones() {
  const video = document.getElementById("webcam");
  let canvas = document.getElementById("detection-canvas");

  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "detection-canvas";
    canvas.style.display = "none";
    document.body.appendChild(canvas);
  }

  if (video && video.videoWidth > 0 && video.videoHeight > 0) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }

  if (window.detector) {
    if (canvas.width > 0 && canvas.height > 0) {
      const predictions = await window.detector.detect(canvas);
      let left = 0, center = 0, right = 0;
      const third = canvas.width / 3;

      predictions.forEach(prediction => {
        if (prediction.class === "person" && prediction.score > 0.5) {
          const centerX = prediction.bbox[0] + (prediction.bbox[2] / 2);
          if (centerX < third) {
            left++;
          } else if (centerX < 2 * third) {
            center++;
          } else {
            right++;
          }
        }
      });
      window.zoneCounts = { left, center, right };
      updateZoneStyle();
    }
  } else {
    const now = Date.now();
    window.zoneCounts = {
      left: Math.floor(simulateDensity('A', now) / 5),
      center: Math.floor(simulateDensity('B', now) / 5),
      right: Math.floor(simulateDensity('C', now) / 5)
    };
  }

  if (window.zoneCounts) {
    ['left', 'center', 'right'].forEach(z => {
      window.densityHistory[z].push(window.zoneCounts[z]);
      if (window.densityHistory[z].length > 10) {
        window.densityHistory[z].shift();
      }
    });
  }

  updateDashboardCards();
  updateMapZones();
  if (typeof analyzeWithGemini === 'function') {
    analyzeWithGemini(window.zoneCounts);
  }
}

async function analyzeWithGemini(zoneCounts, override = false) {
  if (!zoneCounts) return;

  if (typeof window.lastGeminiCall === 'undefined') {
    window.lastGeminiCall = 0;
  }

  const cooldown = CONFIG.ALERT_COOLDOWN_MS || 10000;
  if (!override && Date.now() - window.lastGeminiCall <= cooldown) {
    return;
  }

  const promptText = `You are a crowd safety AI. Current data:
Zone A (Left): ${zoneCounts.left || 0} people
Zone B (Center): ${zoneCounts.center || 0} people
Zone C (Right): ${zoneCounts.right || 0} people
Identify the highest risk zone, state the risk level (Low/Moderate/High/Critical), and give ONE actionable recommendation in under 30 words.`;

  const model = CONFIG.GEMINI_MODEL || "gemini-2.5-flash";

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }]
        })
      }
    );
   if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP ${response.status},${errText}`);
   }

    const data = await response.json();
    console.log("Full Gemini Response:", data);

    const responseText = data?.candidates?.[0]?.content?.parts?.[0]?.text || null;

    if (responseText) {
      window.lastGeminiResponse = responseText;
      displayAlert(responseText, "danger");
      window.lastGeminiCall = Date.now();
    } else {
      throw new Error("Empty response from AI");
    }
  } catch (err) {
    console.error("analyzeWithGemini error:", err);
    displayAlert("⚠️ AI analysis temporarily unavailable", "danger");
  }
}

function updateMapZones() {
  if (!window.zoneCounts) return;

  const getColor = (count) => {
    if (count < 5) return "#00C853";
    if (count >= 5 && count <= 10) return "#FFD600";
    if (count >= 11 && count <= 20) return "#FF6D00";
    return "#D50000";
  };

  if (typeof zoneA !== 'undefined' && zoneA && typeof zoneA.setOptions === 'function') {
    zoneA.setOptions({ fillColor: getColor(window.zoneCounts.left), fillOpacity: 0.5 });
  }
  if (typeof zoneB !== 'undefined' && zoneB && typeof zoneB.setOptions === 'function') {
    zoneB.setOptions({ fillColor: getColor(window.zoneCounts.center), fillOpacity: 0.5 });
  }
  if (typeof zoneC !== 'undefined' && zoneC && typeof zoneC.setOptions === 'function') {
    zoneC.setOptions({ fillColor: getColor(window.zoneCounts.right), fillOpacity: 0.5 });
  }
}

function updateDashboardCards() {
  if (!window.zoneCounts) return;

  const thresholds = [
    { id: 'zona', count: window.zoneCounts.left, zoneKey: 'left' },
    { id: 'zonb', count: window.zoneCounts.center, zoneKey: 'center' },
    { id: 'zonc', count: window.zoneCounts.right, zoneKey: 'right' }
  ];

  let anySurge = false;

  thresholds.forEach(zone => {
    let label = 'Low';
    let color = '#22c55e'; // green

    if (zone.count >= 5 && zone.count <= 10) {
      label = 'Moderate';
      color = '#eab308'; // yellow
    } else if (zone.count >= 11 && zone.count <= 20) {
      label = 'High';
      color = '#f97316'; // orange
    } else if (zone.count > 20) {
      label = 'Critical';
      color = '#ef4444'; // red
    }

    const cardEl = document.getElementById(`video-dash-${zone.id}`);
    const valEl = document.getElementById(`video-dash-val-${zone.id}`);
    const lblEl = document.getElementById(`video-dash-lbl-${zone.id}`);

    if (cardEl && valEl && lblEl) {
      valEl.innerText = zone.count;
      lblEl.innerText = label;
      lblEl.style.color = color;
      cardEl.style.borderColor = color;

      let surgeBadge = cardEl.querySelector('.surge-badge');
      const isSurge = detectSurge(zone.zoneKey, window.densityHistory[zone.zoneKey]);

      if (isSurge && !window.activeSurges[zone.zoneKey]) {
        window.surgeCount++;
        window.activeSurges[zone.zoneKey] = true;
      } else if (!isSurge && window.activeSurges[zone.zoneKey]) {
        window.activeSurges[zone.zoneKey] = false;
      }

      if (isSurge) {
        anySurge = true;
        if (!surgeBadge) {
          surgeBadge = document.createElement('div');
          surgeBadge.className = 'surge-badge';
          surgeBadge.innerText = '⚡ SURGE DETECTED';
          surgeBadge.style.color = '#ef4444';
          surgeBadge.style.fontWeight = 'bold';
          surgeBadge.style.marginTop = '8px';
          surgeBadge.style.fontSize = '0.875rem';
          cardEl.appendChild(surgeBadge);
        }
      } else if (surgeBadge) {
        surgeBadge.remove();
      }
    }
  });

  if (anySurge && typeof analyzeWithGemini === 'function') {
    analyzeWithGemini(window.zoneCounts, true);
  }
}

if (!window.detectionIntervalId) {
  window.detectionIntervalId = setInterval(detectZones, CONFIG.DETECTION_INTERVAL_MS);
}

async function generateReport() {
  const modal = document.getElementById('report-modal');
  const reportBody = document.getElementById('report-body');
  const copyBtn = document.getElementById('copy-report-btn');

  if (!modal || !reportBody || !copyBtn) return;

  modal.classList.remove('hidden');
  reportBody.innerHTML = "Generating...";
  copyBtn.classList.add('hidden');

  const durationMinutes = Math.floor((Date.now() - window.sessionStartTime) / 60000);

  const getPeak = (key) => {
    const history = window.densityHistory[key];
    if (!history || history.length === 0) return 0;
    return Math.max(...history);
  };

  const alertLog = document.getElementById('alert-log');
  let alerts = [];
  if (alertLog) {
    const entries = alertLog.querySelectorAll('.alert-entry');
    for (let i = 0; i < Math.min(3, entries.length); i++) {
      const text = entries[i].innerText.replace(/\[\d{2}:\d{2}:\d{2}\]/, '').trim();
      alerts.push(text);
    }
  }
  if (alerts.length === 0) alerts.push("No alerts triggered.");

  const promptText = `Generate a formal crowd safety incident report with:
- Session duration: ${durationMinutes} minutes
- Peak counts per zone: Zone A (${getPeak('left')}), Zone B (${getPeak('center')}), Zone C (${getPeak('right')})
- Number of surge events: ${window.surgeCount}
- Last 3 AI recommendations: ${alerts.join(" | ")}
Format as Summary, Findings, Recommendations under 200 words.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${CONFIG.GEMINI_MODEL || "gemini-2.5-flash"}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
      }
    );
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Error generating report.";

    reportBody.innerHTML = `<div style="white-space: pre-wrap; font-family: sans-serif;">${text}</div>`;
    window.currentReportText = text;
    copyBtn.classList.remove('hidden');
  } catch (err) {
    console.error(err);
    reportBody.innerHTML = "Failed to generate report.";
  }
}