# On-Device Visual Perception for Light-Weight Browser Agents

> **Smart India Hackathon (SIH26171)** — Privacy-Preserving Autonomous Browser Agent with Precision Client-Side PII Redaction.

A lightweight Chrome extension and reasoning engine that enables autonomous web task execution without sacrificing user privacy. Built to solve SIH26171, this system guarantees that all visual perception, facial biometric detection, and identity token redacting occur strictly on-device inside the browser sandbox before any network transmission: **only cryptographically verified, sanitized visual frames and non-sensitive structural topologies are ever transmitted to the reasoning server.**

---

## Live Server

The reasoning backend is deployed live at:
**[https://visual-pereption.onrender.com](https://visual-pereption.onrender.com)**

> [!NOTE]
> This live Render backend is already configured as the extension's default server URL in `chrome.storage.local`. **Zero backend installation or server configuration is required to test and evaluate the extension.**

- **Health check endpoint**: [https://visual-pereption.onrender.com/health](https://visual-pereption.onrender.com/health)
- **Hosted interactive demo page**: [https://visual-pereption.onrender.com/demo/vendor-registration.html](https://visual-pereption.onrender.com/demo/vendor-registration.html)

---

## Install the Extension

Follow these steps to install the unpacked extension in Google Chrome in under two minutes:

1. **Clone or download this repository** to your local machine:
   ```bash
   git clone https://github.com/sathvik0548/Visual-Pereption.git
   ```
2. **Open Chrome** and navigate to `chrome://extensions` in the address bar.
3. **Enable "Developer mode"** using the toggle switch located in the top-right corner.
4. **Click "Load unpacked"** in the top-left toolbar.
5. **Select the `extension/` folder** from the root of this cloned repository (the directory containing `manifest.json`).
6. **The extension icon should now appear in the toolbar** (click the puzzle-piece extensions icon and pin **Browser Agent** for quick access).

---

## Try It

Experience the end-to-end privacy redaction and autonomous execution pipeline on our realistic procurement testbed:

1. **Open the Demo Page**:
   Navigate to the hosted vendor portal:
   👉 **[https://visual-pereption.onrender.com/demo/vendor-registration.html](https://visual-pereption.onrender.com/demo/vendor-registration.html)**
   *(Alternatively, if running locally, open [server/demo/vendor-registration.html](server/demo/vendor-registration.html) in Chrome).*

2. **Open the Extension**:
   Click the **Browser Agent** extension icon in your Chrome toolbar. The popup panel will open.

3. **Provide Task Instruction**:
   Type the following instruction into the prompt input (or click **"Demo Mode"** / **"Analyze Screen"**):
   ```text
   Fill out the vendor registration form with valid test credentials and submit
   ```

4. **What to Expect**:
   - **Pipeline Stages Lighting Up**: Watch the stage progress indicators transition in real time: `DOM SCAN` ➔ `LOCAL INFERENCE` (Florence-2 / BlazeFace) ➔ `REDACT CANVAS` ➔ `AGENT REASONING` ➔ `EXECUTION`.
   - **Redaction Panel**: In the visual preview, all high-sensitivity PII fields (Aadhaar numbers, PAN, GSTIN, bank IFSC codes, telephone numbers, and profile photos/faces) are physically masked with opaque black bounding boxes on an offscreen HTML5 canvas.
   - **Leak Verification Result**: A zero-leak audit badge confirms that raw PII never left the client sandbox. The cloud VLM receives only sanitized visual frames accompanied by an abstract `AgentRequestV1` Redaction Manifest.
   - **Autonomous Action Highlights**: The agent steps through form elements, highlighting interacted fields in green and safely substituting localized credentials from client-side memory.

---

## Architecture

The system enforces a zero-trust, edge-native privacy architecture spanning on-device browser components and a swappable reasoning server:

```
[ Active Webpage ]
       │
       ▼  (1) Capture visible tab + scan live DOM attributes
[ Chrome MV3 Extension ]
       │
       ▼  (2) Offscreen document sandbox (WebGPU / WASM)
[ Florence-2 OCR + BlazeFace Face Detector + RegEx Structural Validators ]
       │
       ▼  (3) Physical black-box canvas masking & manifest generation
[ Sanitized AgentRequestV1 Frame + Redaction Manifest ]
       │  (Only sanitized data leaves device; raw PII never transmitted)
       ▼
[ Cloud / Deployed Reasoning Server (POST /analyze) ]
       │
       ▼  (4) Multi-modal planning over non-sensitive structural topology
[ Multi-Step Action Execution Plan ]
       │
       ▼  (5) Local client dispatch
[ Content Script DOM Dispatcher with Isolated Credential Injection ]
```

### Key Pipeline Stages
- **Capture**: Captures the active viewport screenshot alongside deterministic DOM layout geometry.
- **Local Detection**: Runs Florence-2 OCR, WebGPU/WASM acceleration, and BlazeFace biometric facial recognition directly within an isolated offscreen document.
- **Redaction**: Physically draws opaque redaction blocks over all detected PII (Aadhaar, PAN, GSTIN, IFSC, mobile, credit cards, emails, passwords, and faces) on an offscreen canvas.
- **Verification**: Asserts a zero-leak verification check across the outgoing payload to guarantee no unmasked PII substrings escape the local client.
- **Server Reasoning**: Transmits the sanitized frame and structural manifest (`AgentRequestV1`) to the reasoning server (Groq/Gemini/Ollama) to synthesize an action trajectory.
- **Execution**: The content script executes DOM mutations (typing, clicking, selecting) step-by-step with real-time visual highlights while drawing credentials exclusively from local browser memory.

For an in-depth breakdown of algorithmic design, schema specifications, and security threat models, read the [Technical Solution Whitepaper](solution.md) and review the [Technical Evaluation Report](docs/SIH26171_Technical_Evaluation_Report.pdf).

---

## Running the Server Locally *(Optional, for Development Only)*

Running a local server is **optional** and only required if you plan to modify backend prompt logic, implement new VLM providers, or work entirely offline with local LLMs (e.g. Ollama):

1. **Navigate to the server directory and install dependencies**:
   ```bash
   cd server
   npm install
   ```

2. **Configure environment variables (optional)**:
   Create a `server/.env` file with your preferred API keys:
   ```env
   PORT=3000
   GROQ_API_KEY=your_groq_api_key_here
   VLM_MODE=cloud
   ```

3. **Start the local server**:
   ```bash
   npm start
   # or for automatic reloading:
   npm run dev
   ```

4. **Point the extension to localhost**:
   In the extension popup under **Server Settings**, change the URL to `http://localhost:3000` (or leave blank to automatically reset to the live Render backend).
