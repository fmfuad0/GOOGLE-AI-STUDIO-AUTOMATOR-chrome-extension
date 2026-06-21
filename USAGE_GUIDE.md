# AI Studio Automator - In-Depth Usage Guide

This guide provides a comprehensive, step-by-step walkthrough of how to set up, configure, and run bulk automation tasks using the **AI Studio Automator** extension.

---

## 1. Prerequisites

- **Google Chrome** installed.
- The **AI Studio Automator** extension installed and enabled.
- A logged-in session at [Google AI Studio](https://aistudio.google.com/). 
  > **Note:** You *must* have at least one active tab open to AI Studio for the automation to work. The extension communicates directly with this tab.

---

## 2. Step-by-Step Workflow

### Step 1: Prepare Your Workspace
1. Open Google Chrome.
2. Open a new tab and go to `aistudio.google.com`. Make sure you are signed in.
3. Click the extension icon in your Chrome toolbar to open the Automator interface. (You can also open it as a Side Panel for easier access).

### Step 2: Select Your Input Mode
At the top of the extension UI, select your desired **Input Mode**:

* **Spreadsheet Mode (`.xlsx`, `.xls`, `.csv`)**
  * **Best for:** Row-by-row data transformation, bulk content generation based on list inputs.
* **PDF Mode (`.pdf`)**
  * **Best for:** Document OCR, summarization, or extracting structured data from multiple PDFs.
* **Raw Text Mode**
  * **Best for:** Testing single prompts or sending bulk text directly without a file.

### Step 3: Upload Your Data
* Drag and drop your files into the designated dropzone, or click to browse.
* If using **Spreadsheet Mode**, you can:
  * Select which **Sheet** to process.
  * Check/Uncheck specific **Columns** to include or ignore.
  * Set **Rows per prompt** (e.g., send 50 rows at a time to stay within context limits).

### Step 4: Configure Your Prompt (Profiles)
* Select a **Profile** from the dropdown. Profiles act as the "System Instructions" for the AI.
* You can use the built-in Demo profiles (e.g., JSON, Markdown, Table output) or create a **custom profile** with your own specific instructions.
* *Tip:* If using **PDF Mode**, you can toggle the "Prepend system prompt before input data" setting to attach your profile instructions alongside the uploaded documents.

### Step 5: Advanced Settings
* **Batch Delay:** Set a delay (in seconds) between batches to prevent triggering AI Studio's rate limits too quickly.
* **New Chat per Batch:** Toggle whether the extension should create a fresh chat session for every batch, preventing context pollution between runs.

### Step 6: Run the Automation
1. Click the **Run** button.
2. Switch to your AI Studio tab. You will see a dark, floating widget in the bottom left corner.
3. The extension will automatically:
   - Inject your file(s) and prompt text.
   - Click the "Run" button in AI Studio.
   - Wait for the generation to finish.
   - Extract the generated response text.
   - Save the response to the local Output Buffer.
   - Loop to the next batch.

### Step 7: Viewing & Exporting Data
1. Open the extension popup once the job is complete (or paused).
2. Look at the **Output Info** section. It will display the size of your generated data.
3. Click the **View Output** (or Download) button. This opens the **built-in Output Viewer**.
4. Inside the Output Viewer, you can select different views to parse and format the data:
   - **Text:** View the raw text block. Exports as a single `.txt` file containing the raw, unfiltered response data. This can be kept and used as a backup file for future reference or parsing.
   - **Markdown:** Renders Markdown elements. Exports as a `.zip` of `.md` files.
   - **Code:** Renders syntax-highlighted code blocks. Exports as a `.zip` with appropriate file extensions (e.g., `.js`, `.py`).
   - **Table:** Automatically detects Markdown tables/CSV and renders HTML tables. Exports as a `.zip` of `.csv` or `.xlsx` files.
   - **JSON:** Pretty-prints JSON data. Exports as a `.zip` of `.json` files.
5. Click the **Download** button inside the viewer to download the formatted outputs.
6. When starting a completely new project, remember to click **Clear** in the popup to empty the buffer.

---

## 3. Understanding the Core Workflow (Under the Hood)

If you are encountering issues or want to optimize your processing, it helps to understand how the extension operates:

### DOM Injection & Extraction
The extension uses a Content Script (`content.js`) injected into AI Studio. Instead of using an API (which costs money), it physically mimics human actions:
1. It manipulates the DOM to inject your prompt into the input textarea (bypassing Angular/React UI blockages).
2. It uploads base64-encoded PDFs via the File Input or Drag-and-Drop fallback.
3. It clicks the "Run" button (or sends `Ctrl+Enter`).
4. It monitors the "Stop" button to know when generation is happening.
5. It reads the model's output container to grab the text, stripping UI elements like the "Copy" button.

### State Management & Watchdog
The Background Script (`background.js`) acts as the conductor:
* **The Queue:** Files are stored locally using IndexedDB (`lib/idb.js`), meaning you can queue hundreds of files without crashing your browser memory.
* **Watchdog Timer:** AI Studio can sometimes freeze or take extremely long. The background script runs a 35-minute watchdog. If a batch gets stuck, the watchdog refreshes the page and automatically retries the batch up to 2 times.
* **Rate Limits:** The content script scans for "Rate limit", "Quota exceeded", or "Internal Error" messages. If detected, it pauses the job and schedules an automatic retry.

### Safe Pausing
You can click **Pause** in the extension at any time. The script will finish the *current* batch it is processing, and then halt before sending the next one. This allows you to safely stop work, close your laptop, and click **Resume** later.

---

## 4. Troubleshooting

* **Widget stuck on "Waiting for generation..." or "Injecting...":** 
  * AI Studio might be experiencing high load. If the watchdog timer (35 mins) doesn't kick in, refresh the AI Studio tab manually. The extension will automatically resume.
* **Getting "Rate Limit" errors frequently:**
  * Increase the **Batch Delay** setting in the extension popup to give the AI Studio API more breathing room between chunks.
* **The AI Studio UI changed and the extension isn't clicking Run:**
  * Since the extension relies on DOM manipulation, changes by Google to the AI Studio interface might require an extension update. Check for updates on the repository.
