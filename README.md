# Order Signal

A static Web Speech API benchmark for English and Mandarin–English restaurant orders. No runtime dependencies or application backend.

## Run locally

With Node 20 or newer, run `npm run dev` and open the printed localhost URL. Run `npm run check`, `npm test`, and `npm run build` for validation. The production artifact is `dist/`. `npm run preview` serves that artifact. Assets are relative to the page, including under `/web-speech-benchmark/`.

## Live site

[Open Order Signal on GitHub Pages](https://llllucario.github.io/web-speech-benchmark/).

## Test on a phone

1. Open the deployed HTTPS URL in iOS Safari or Android Chrome. Record the browser and device details shown in the support section.
2. Select a prompt, language, and input method. Tap **Start recognition**, grant the browser's permission, and wait for **Listening**.
3. Read the order aloud or play a corresponding recording from another device using **External audio playback**.
4. Tap **End recognition** on the same button or let the browser finish. Edit the text in **Transcript** after recognition ends. Review timing, error rates, and alignment under the benchmark results.
5. Save the run and export JSON or CSV. To check the restart flow, start another run, end it, wait for the transcript, then tap **Reset** and start again. Reset is available when recognition has ended and the transcript contains recognized text. You can also start another run directly. Repeat on both Safari and Chrome on iPhone. Repeat with permission denied and silence to check failure handling.

Constructor detection indicates API presence. Recognition may depend on browser permissions, device configuration, connectivity and the browser's own speech service. AudioTrack is restricted to eligible desktop Chrome configurations. A file is decoded in Web Audio and routed through a media destination to `start(track)`. Verify the result against a known recording in a quiet room. Failures never retry through the microphone.

If iPhone recognition stops returning text after the first run, fully close and reopen the browser. For **Live speech**, enable **iPhone compatibility mode**. Tap Start, wait for the spoken prompt and Listening, say one order, and pause for the browser to end the run. The option uses single-utterance recognition. The ready prompt is logged separately from the recognition start timing. [WebKit reproduction and workaround](https://bugs.webkit.org/show_bug.cgi?id=321436#c9)

## Dataset and batch workflow

The built-in dataset contains 30 English orders across ten categories and six Mandarin–English prompts. In **Benchmark**, choose **Try 中文 + English** to open a mixed prompt. If the browser has an older saved dataset, this adds missing built-in mixed prompts by ID while preserving existing cases. Try the same prompt under both `zh-CN` and `en-AU`. Web Speech API receives one recognition language tag per run, and code-switching quality depends on the browser and speech service. [Web Speech API specification](https://webaudio.github.io/web-speech-api/#dom-speechrecognition-lang) In **Dataset**, edit the references, lexical phrases, notes and optional audio references, add custom cases, or replace the dataset from JSON. The export envelope is `{"schemaVersion":1,"cases":[...]}`. An array of cases is also accepted. Each case requires a unique string `id`, a `category`, and a `reference`. Optional fields are `audio` (URL or filename), `notes`, `criticalTerms` (array of phrases), and `completed` (boolean). A filename is metadata, and audio files must be selected locally for AudioTrack tests.

Open **Batch setup** in **Benchmark**. Enter the network and environment, select a set of prompts, then choose **Start new session**. Empty selection sequences all prompts. Start and save each attempt, then use **Next case** or **Repeat case**. Changing the language, network, environment or input mode starts a new session at the next recognition attempt. Runs capture a snapshot of the reference and settings. Dataset edits and imports leave saved runs intact. Each recognition requires a separate explicit start.

Open **Results** to select a session, review saved runs and compare sessions. Export complete sessions, individual attempts, grouped metrics and raw events in JSON or CSV. JSON preserves raw strings exactly. CSV cells with spreadsheet formula prefixes receive an apostrophe to preserve their treatment as text. Exports can include user-agent, device signals and transcript text.

## Measurements

Event offsets use `performance.now()` from the start of the attempt. Measurements are differences between observed browser events, and speech boundaries are approximate. Missing events and reversed intervals produce N/A. The end-of-speech metrics use the last speech-end event and, for final-result latency, the first new final result after it.

For references containing Han characters, the benchmark uses mixed error rate (MER). Each Han character and English word counts as one token. MER uses the same edit-distance formula over those tokens and is reported separately from WER. The scorer keeps simplified and traditional forms distinct and never translates a transcript. [MER definition](https://dihana.cps.unizar.es/proceedings/ICASSP/2012/pdfs/0004889.pdf)

WER counts word substitutions, deletions and insertions using Levenshtein alignment, divided by reference word count. Word accuracy is 1 − WER and can be negative. Normalized is the default. Both modes ignore case and punctuation. Normalized also maps number words zero–twenty to digits and strips selected filler tokens. Critical phrases use contiguous lexical matches and retain filler tokens. Raw browser segments are available in JSON. User corrections are saved and exported as a separate edited transcript. Benchmark scores use the original browser output.

A successful run has a non-blank final transcript, no recorded errors and a browser, manual or audio-ended termination. WER includes failed runs with scorable references, including deletion-only results when the browser returns no final transcript. Average WER and MER are means across runs scored with their respective metric. P50 and P95 use linear interpolation at rank `(n − 1) × p` across finite values. Latency tables show valid and missing counts per input method. Browser-local storage holds saved records. Export them before clearing site data. WAV and MP3 availability depends on the browser's decoder.

## Architecture and deployment

`site/app.js` binds the interface. `site/recognition.js` manages the recognition and audio lifecycle. `site/benchmark.js` handles scoring, statistics and export. `site/dataset.js` defines and validates prompts. GitHub Actions runs checks and tests, builds the static artifact, and deploys through GitHub Pages.


## Compatibility checks

Syntax checks, deterministic unit tests and the production build run in CI. Actual iOS Safari and Android Chrome speech recognition, event availability, and desktop Chrome AudioTrack playback require testing on those browsers. A detected constructor or a successful site deployment indicates capability or delivery respectively. Check recognition separately with spoken audio and a known input recording.

References: [SpeechRecognition.start()](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/start), [browser compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json), [GitHub Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
