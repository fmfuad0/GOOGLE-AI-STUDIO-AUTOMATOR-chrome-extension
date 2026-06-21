# AI Studio Automator

**AI Studio Automator** is a powerful Chrome extension that automates bulk data processing and content generation using [Google AI Studio](https://aistudio.google.com/). 

Whether you need to extract specific tables from hundreds of PDFs, process thousands of rows from Excel/CSV files, or run batches of raw text prompts, this extension seamlessly connects your local files with the AI Studio web interface to automate the heavy lifting.

---

## 🚀 Key Features

- **Multi-Format Support:** Natively process `.xlsx`, `.xls`, `.csv`, and `.pdf` files.
- **Three Operation Modes:**
  - **Spreadsheet Mode:** Batch process rows of data. Filter by sheet and specific columns.
  - **PDF Mode:** Batch process PDFs. Attach a system prompt for specific extraction or analysis tasks (e.g., OCR, summarization).
  - **Raw Text Mode:** Run single or multiple synthetic raw text prompts directly.
- **Smart Automation:** 
  - Automatically navigates AI Studio, injects prompts/files, clicks "Run", and extracts the generated responses.
  - Automatically handles timeouts, rate limits, and errors with a built-in watchdog and retry mechanism.
- **Profile Management:** Save and switch between different prompt templates for various tasks. Includes built-in demo profiles for JSON, Markdown, Tables, and Code generation.
- **Real-Time Monitoring:** A draggable floating widget injected directly into the AI Studio page keeps you updated on progress, estimated time, and success/failure rates.
- **Rich Output Viewer & Export:** Accumulates all AI outputs into a local buffer. Includes a dedicated built-in Output Viewer to parse, format, and visualize the generated data in 5 views: Raw Text, Markdown, Code Blocks, Tables, and JSON. You can export results directly to `.txt`, `.csv`, `.xlsx`, or `.zip` archives of individual files.

---

## 💡 Common Use Cases

- **Bulk Data Transformation:** Reformatting large CSV datasets into specific JSON/XML schemas.
- **Mass Document OCR & Extraction:** Extracting structured data (like tables of contents or invoice details) from a folder of PDF files.
- **Content Generation:** Generating customized descriptions, emails, or reports row-by-row from an Excel spreadsheet.
- **Code Translation:** Converting code snippets in an Excel file from one language to another in bulk.

---

## 📖 Quick Demo OCR Operation

Follow these instructions to perform a demo Table of Content OCR operation:

1. **Open the Extension:** Click the extension icon to open the popup or side panel.
2. **Choose Prompt Profile:** Select `Table Extractor` from the profile dropdown.
3. **Enable System Prompt:** Toggle on the setting that says `Prepend system prompt before input data`.
4. **Select Mode & Add File:** Select **PDF Mode**. Drag and drop the `SAMPLE.pdf` file (located in the `./SAMPLE FILE` folder) into the input area.
5. **Run the Automation:** Click the "Run" button and let the automation widget handle the rest!
6. **View Output:** Once finished, click the `View Output` button at the bottom of the extension to open the built-in viewer and export your data.

---



## 📖 Brief Usage Guide (IN DEPTH GUIDE ATTACHED)

Using AI Studio Automator is straightforward, but requires an active AI Studio session.

1. **Open AI Studio:** Ensure you have a tab open to [aistudio.google.com](https://aistudio.google.com/).
2. **Open the Extension:** Click the extension icon to open the popup/side panel.
3. **Select Mode & Add Files:** Choose between Spreadsheet, PDF, or Raw Text mode, then drag and drop your files.
4. **Choose a Profile:** Select a built-in prompt profile or create your own custom instructions.
5. **Run:** Click "Run" and watch the automation widget on the AI Studio tab handle the rest!
6. **Download:** Once complete, download your aggregated results from the extension popup.

👉 **For an in-depth, step-by-step tutorial and core workflow explanation, please read the [USAGE_GUIDE.md](./USAGE_GUIDE.md).**

---

## ⚙️ Installation

1. Clone or download this repository to your local machine.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top right).
4. Click **Load unpacked** and select the directory containing this project (`manifest.json` should be in the root).
5. The extension will appear in your toolbar. Pin it for easy access.

---

## ⚠️ Notes & Limitations

- **Browser Window Must Stay Open:** The extension works by physically interacting with the AI Studio DOM. The AI Studio tab must remain open (though it can run in the background).
- **Rate Limits:** Google AI Studio has usage rate limits. The extension is designed to detect rate limit errors and automatically pause/retry, but extremely large batches might take time.
- **UI Changes:** Since the extension interacts with AI Studio's DOM, changes to Google's interface might require extension updates.
