console.log("[Content Script] Starting VoxSyn injection...");

// --- CONFIGURATION ---

// Updated selector: target any editable area but skip ones with a limited max length.
const TARGET_EDITABLE_SELECTOR = "textarea, input[type='text'], [contenteditable='true']";

// Define a minimum maxlength (if set) below which we do not inject the button.
const MIN_MAXLENGTH = 100;

// We'll now get the API key from localStorage (if previously set).
let OPENAI_API_KEY = localStorage.getItem("openapi_token") || "";

// --- UTILITY FUNCTIONS ---

// Function to post-process transcription text for known mis-transcriptions.
function correctMedicalTerms(text) {
  const corrections = {
    "cabbage": "CABG",
    "a fib": "AFib"
    // Add more mappings as needed.
  };

  let correctedText = text;
  for (const [wrong, right] of Object.entries(corrections)) {
    const regex = new RegExp(`\\b${wrong}\\b`, "gi");
    correctedText = correctedText.replace(regex, right);
  }
  return correctedText;
}

// Returns a Promise that resolves once the user has entered and saved their token.
function showApiKeyPopup() {
  return new Promise((resolve) => {
    // Create the modal overlay
    const modal = document.createElement("div");
    modal.id = "api-key-modal";
    Object.assign(modal.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      backgroundColor: "rgba(0,0,0,0.5)",
      zIndex: "1000000",
      display: "flex",
      justifyContent: "center",
      alignItems: "center"
    });

    // Create the modal content container
    const modalContent = document.createElement("div");
    Object.assign(modalContent.style, {
      backgroundColor: "#fff",
      padding: "20px",
      borderRadius: "5px",
      boxShadow: "0 2px 10px rgba(0,0,0,0.1)"
    });

    // Create label and input field for the token.
    const label = document.createElement("label");
    label.innerText = "Enter your OpenAPI token:";
    label.style.display = "block";
    label.style.marginBottom = "10px";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "sk-...";
    input.style.width = "300px";
    input.style.marginBottom = "10px";

    // Create the save button.
    const saveBtn = document.createElement("button");
    saveBtn.innerText = "Save";
    saveBtn.style.marginLeft = "10px";

    // Append elements.
    modalContent.appendChild(label);
    modalContent.appendChild(input);
    modalContent.appendChild(saveBtn);
    modal.appendChild(modalContent);
    document.body.appendChild(modal);

    // On save, store the token and remove the modal.
    saveBtn.addEventListener("click", () => {
      const token = input.value.trim();
      if (token) {
        localStorage.setItem("openapi_token", token);
        OPENAI_API_KEY = token;
        document.body.removeChild(modal);
        resolve();
      } else {
        alert("Please enter a valid token.");
      }
    });
  });
}

// --- CORE FUNCTIONALITY ---

function createDictateButtonForEditable(el, index) {
  console.log(`[Content Script] Creating 'D' button for editable element #${index}`, el);

  // Create the button.
  const dictateBtn = document.createElement("button");
  dictateBtn.innerText = "D";
  Object.assign(dictateBtn.style, {
    backgroundColor: "#4CAF50", // green
    color: "#fff",
    border: "none",
    borderRadius: "50%",
    width: "30px",
    height: "30px",
    cursor: "pointer",
    fontSize: "16px",
    fontWeight: "bold",
    position: "absolute",
    zIndex: "999999",
    pointerEvents: "auto",
    bottom: "5px",
    right: "5px"
  });

  // Ensure the parent container is positioned relative.
  const parent = el.parentNode;
  const parentStyle = window.getComputedStyle(parent);
  if (parentStyle.position === "static") {
    parent.style.position = "relative";
    console.log(`[Content Script] Set parent position to 'relative' for element #${index}.`);
  }
  parent.appendChild(dictateBtn);

  // Variables to manage recording state.
  let isRecording = false;
  let mediaRecorder = null;
  let recordedChunks = [];

  dictateBtn.addEventListener("click", async () => {
    console.log(`[Content Script] 'D' button #${index} clicked. isRecording=${isRecording}`);

    // If no API key is set, prompt the user.
    if (!OPENAI_API_KEY) {
      console.log("[D Button] No API key found. Prompting user...");
      await showApiKeyPopup();
    }

    if (!isRecording) {
      // Start recording.
      try {
        console.log("[D Button] Requesting microphone access...");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("[D Button] Microphone access granted.");

        mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
        recordedChunks = [];

        mediaRecorder.ondataavailable = (evt) => {
          if (evt.data.size > 0) {
            recordedChunks.push(evt.data);
          }
        };

        mediaRecorder.onstop = async () => {
          console.log("[D Button] Recording stopped. Sending audio to Whisper...");

          const audioBlob = new Blob(recordedChunks, { type: "audio/webm" });
          if (!OPENAI_API_KEY) {
            console.warn("[D Button] API key missing. Cannot call Whisper API.");
            return;
          }

          try {
            const formData = new FormData();
            formData.append("file", audioBlob, "audio.webm");
            formData.append("model", "whisper-1");

            const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
              method: "POST",
              headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
              body: formData
            });

            if (!resp.ok) {
              const errText = await resp.text();
              console.error("[D Button] Whisper API error:", resp.status, errText);
              alert("Error from Whisper API: " + errText);
              return;
            }

            const data = await resp.json();
            console.log("[D Button] Transcription:", data.text);

            const processedText = correctMedicalTerms(data.text || "");
            // Append or set the text depending on the element type.
            if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
              const currentText = el.value.trim();
              el.value = currentText ? currentText + " " + processedText : processedText;
            } else if (el.isContentEditable) {
              const currentText = el.innerText.trim();
              el.innerText = currentText ? currentText + " " + processedText : processedText;
            }
          } catch (err) {
            console.error("[D Button] Error uploading to Whisper:", err);
          }
        };

        mediaRecorder.start();
        console.log("[D Button] Recording started.");
        isRecording = true;
        dictateBtn.style.backgroundColor = "#f44336"; // red indicates recording.
      } catch (err) {
        console.error("[D Button] Error accessing microphone:", err);
        alert("Mic access denied or unavailable.");
      }
    } else {
      // Stop recording.
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
      }
      isRecording = false;
      dictateBtn.style.backgroundColor = "#4CAF50"; // revert back to green.
    }
  });
}

function injectDictateButtons() {
  const elements = document.querySelectorAll(TARGET_EDITABLE_SELECTOR);
  console.log(`[Content Script] Found ${elements.length} editable elements.`);

  elements.forEach((el, index) => {
    // Skip if already processed.
    if (el.dataset.dictateInjected === "true") return;

    // If the element has a maxlength and it's less than our threshold, skip it.
    if (el.hasAttribute("maxlength") && parseInt(el.getAttribute("maxlength"), 10) < MIN_MAXLENGTH) {
      return;
    }

    el.dataset.dictateInjected = "true";
    createDictateButtonForEditable(el, index);
  });
}

// Use MutationObserver to handle dynamically added editable elements.
const observer = new MutationObserver(injectDictateButtons);
observer.observe(document.body, { childList: true, subtree: true });

// Do an initial pass to inject buttons.
injectDictateButtons();

console.log("[Content Script] VoxSyn injection logic loaded...");
