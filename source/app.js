(() => {
  "use strict";

  const app = document.querySelector("#app");
  const appTitle = document.querySelector("#app-title");
  const screenShell = document.querySelector("#screen-shell");
  const learningScreen = document.querySelector("#learning-screen");
  const resultScreen = document.querySelector("#result-screen");
  const padStage = document.querySelector(".pad-stage");
  const canvas = document.querySelector("#handwriting-pad");
  const resultBox = document.querySelector("#recognized-text");
  const questionText = document.querySelector("#question-text");
  const progressText = document.querySelector("#progress-text");
  const progressBar = document.querySelector("#progress-bar");
  const slotPosition = document.querySelector("#slot-position");
  const clearButton = document.querySelector("#clear-button");
  const undoButton = document.querySelector("#undo-button");
  const advanceButton = document.querySelector("#advance-button");
  const reviewButton = document.querySelector("#review-button");
  const reviewMenu = document.querySelector("#review-menu");
  const settingsButton = document.querySelector("#settings-button");
  const settingsOverlay = document.querySelector("#settings-overlay");
  const settingsCloseButton = document.querySelector("#settings-close-button");
  const layoutSelect = document.querySelector("#layout-select");
  const clearStatsButton = document.querySelector("#clear-stats-button");
  const resultList = document.querySelector("#result-list");
  const scoreSummary = document.querySelector("#score-summary");
  const retryButton = document.querySelector("#retry-button");
  const explanationOverlay = document.querySelector("#explanation-overlay");
  const explanationTitle = document.querySelector("#explanation-title");
  const explanationText = document.querySelector("#explanation-text");
  const context = canvas.getContext("2d");
  const strokeCounts = window.JP_STROKE_COUNTS || {};
  const quizPackage = safeJsonParse(
    document.querySelector("#digicanji-quiz-data")?.textContent || "{}",
    {},
  );
  const embeddedQuestionRows = Array.isArray(quizPackage.questions)
    ? quizPackage.questions
    : [];
  const quizId = String(quizPackage.quizId || "digicanji-quiz")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "digicanji-quiz";

  const LANGUAGE_CANDIDATES = [{ languages: ["ja"] }, { languages: ["ja-JP"] }];
  const SUPPORTED_POINTER_TYPES = new Set(["mouse", "touch", "stylus"]);
  const MIN_LINE_WIDTH = 6;
  const MAX_LINE_WIDTH = 12;
  const LINE_WIDTH_RATIO = 0.024;
  const INK_COLOR = "#f4f0df";
  const DRAG_START_DISTANCE_MOUSE = 8;
  const DRAG_START_DISTANCE_TOUCH = 10;
  const MIN_RECOGNITION_INK_LENGTH = 36;
  const RECOGNITION_DRAW_DELAY_MS = 140;
  const RECOGNITION_FINISH_DELAY_MS = 70;
  const RECOGNITION_RETRY_DELAY_MS = 120;
  const STABILITY_CONFIRM_DELAY_MS = 260;
  const STABILITY_MIN_CONFIRMATIONS = 2;
  const COMPLEX_STROKE_STABILITY_THRESHOLD = 12;
  const MAX_SESSION_QUESTIONS = 10;
  const RESULT_REVEAL_INTERVAL_MS = 280;
  const STORAGE_KEYS = Object.freeze({
    settings: "digicanji.settings.v2",
    stats: `digicanji.stats.v2.${quizId}`,
  });
  const SUPPLEMENTAL_STROKE_COUNTS = Object.freeze({
    "鱸": 27,
  });

  const EDUCATIONAL_GLYPH_NORMALIZATION = Object.freeze({
    "來": "来",
    "學": "学",
    "國": "国",
    "體": "体",
    "會": "会",
    "變": "変",
    "讀": "読",
    "寫": "写",
    "廣": "広",
    "氣": "気",
    "澤": "沢",
    "邊": "辺",
    "邉": "辺",
    "齊": "斉",
    "齋": "斎",
  });

  const STRUCTURAL_ALTERNATIVE_RULES = Object.freeze([
    {
      source: "晴",
      target: "睛",
      test: hasLikelyLeftEyeComponent,
    },
    {
      source: "錆",
      target: "鯖",
      test: hasLikelyLeftFishComponent,
    },
    {
      source: "鳥",
      target: "烏",
      test: hasLikelyCrowStructure,
    },
    {
      source: "天",
      target: "夭",
      test: hasLikelyYouStructure,
    },
  ]);

  const GOOGLE_HANDWRITING_URLS = [
    "https://www.google.com/inputtools/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8",
    "https://inputtools.google.com/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8",
  ];

  function createInputRecord() {
    return {
      strokes: [],
      text: "",
      message: "",
      state: "message",
    };
  }

  const SHINNYOU_CHARS = new Set(
    Array.from(
      "込辻迂迄迅迎近返迫迭述迷追退送逃逆途透逐逓通逝速造逢連逮週進逸遅遇遊運遍過道達違遠遣適遭遮遷選遺避還邁辺邊迦迩逗這逞逡逵逶逹遁遂遜遼遽邂邃邇邉",
    ),
  );

  function safeJsonParse(value, fallback) {
    try {
      return JSON.parse(value) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function loadSettings() {
    const stored = safeJsonParse(safeStorageGet(STORAGE_KEYS.settings), {});
    const layout = ["horizontal", "vertical-wide", "vertical-portable"].includes(stored.layout)
      ? stored.layout
      : "horizontal";
    const handedness = stored.handedness === "left" ? "left" : "right";
    return { layout, handedness };
  }

  function loadStats() {
    const stored = safeJsonParse(safeStorageGet(STORAGE_KEYS.stats), {});
    return stored && typeof stored === "object" ? stored : {};
  }

  const initialSettings = loadSettings();
  const state = {
    nativeRecognizer: null,
    nativeDrawing: null,
    pendingPointerId: null,
    pendingStartPoint: null,
    pendingStartTime: 0,
    pendingPointerType: "",
    activePointerId: null,
    activeStrokePoints: null,
    lastPoint: null,
    strokeStartTime: 0,
    slotMode: 1,
    activeSlotIndex: 0,
    slots: [createInputRecord()],
    freeInput: createInputRecord(),
    strokes: [],
    recognitionTimer: 0,
    recognitionSerial: 0,
    isRecognizing: false,
    isBusyIndicatorVisible: false,
    needsRecognition: false,
    nativeFailed: false,
    googleFailed: false,
    nextRecognitionDelay: RECOGNITION_RETRY_DELAY_MS,
    candidateStability: {
      text: "",
      signature: "",
      firstSeenAt: 0,
      confirmations: 0,
    },
    canvasCssSize: {
      width: 0,
      height: 0,
    },
    questions: [],
    session: [],
    currentQuestionIndex: 0,
    stats: loadStats(),
    settings: initialSettings,
    resultsCommitted: false,
    resultTimers: [],
  };

  const messages = {
    loading: "準備中...",
    empty: "手書きしてください",
    noCandidate: "候補なし",
    networkUnavailable: "描画はできますが、認識に接続できません",
  };

  state.strokes = state.slots[0].strokes;

  function isHiraganaOnlyText(text) {
    return /^[ぁ-ゖゝゞ]+$/u.test(String(text || "").normalize("NFKC"));
  }

  function isFreeMode() {
    return state.session[state.currentQuestionIndex]?.inputMode === "free";
  }

  function getVisibleSlotCount() {
    return Math.max(1, state.slots.length);
  }

  function getActiveInputRecord() {
    return state.slots[state.activeSlotIndex] || state.slots[0];
  }

  function forEachInputRecord(callback) {
    if (state.session.length > 0) {
      state.session.forEach((item) => item.slots.forEach(callback));
      return;
    }
    state.slots.forEach(callback);
  }

  function refreshActiveStrokesReference() {
    state.strokes = getActiveInputRecord().strokes;
  }

  function getLiveResultText() {
    if (isFreeMode()) {
      return state.slots[0]?.text || messages.empty;
    }
    const chars = state.slots.map((record) => record.text || "□").join("");
    return chars || messages.empty;
  }

  function renderResultArea() {
    resultBox.replaceChildren();
    resultBox.dataset.mode = isFreeMode() ? "free" : "slots";
    resultBox.dataset.state = "slots";
    const count = getVisibleSlotCount();
    const grid = document.createElement("span");
    grid.className = "slot-grid";
    grid.style.setProperty("--slot-count", String(count));

    for (let index = 0; index < count; index += 1) {
      const record = state.slots[index];
      const slot = document.createElement("span");
      slot.className = "character-slot";
      slot.dataset.index = String(index);

      if (isFreeMode()) {
        slot.classList.add("is-free-slot");
      }

      if (index === state.activeSlotIndex) {
        slot.classList.add("is-active");
      }

      if (record.text) {
        slot.textContent = record.text;
      } else if (index === state.activeSlotIndex && record.message && record.message !== messages.empty) {
        const message = document.createElement("span");
        message.className = "slot-message";
        message.textContent = record.message;
        slot.append(message);
      } else if (isFreeMode()) {
        const label = document.createElement("span");
        label.className = "free-slot-label";
        label.textContent = "フリー";
        slot.append(label);
      }

      grid.append(slot);
    }

    resultBox.append(grid);
    resultBox.setAttribute("aria-label", getLiveResultText());
    updateBusyIndicator();
  }

  function setResult(text, stateName = "result") {
    const record = getActiveInputRecord();

    if (stateName === "result") {
      record.text = isFreeMode()
        ? String(text || "").normalize("NFKC")
        : Array.from(String(text || ""))[0] || "";
      record.message = "";
      record.state = "result";
    } else {
      record.message = text;
      record.state = "message";
      if (text !== messages.empty && text !== messages.loading) {
        record.text = "";
      }
    }

    renderResultArea();
    updateReviewMenu();
  }

  function clearActiveRecognition() {
    const record = getActiveInputRecord();
    record.text = "";
    record.message = "";
    record.state = "message";
    renderResultArea();
  }

  function updateBusyIndicator() {
    const isBusy = Boolean(state.isBusyIndicatorVisible);
    resultBox.querySelectorAll(".character-slot").forEach((slot) => {
      const index = Number(slot.dataset.index);
      slot.dataset.busy = isBusy && index === state.activeSlotIndex ? "true" : "false";
    });
  }

  function setBusy(isBusy) {
    state.isBusyIndicatorVisible = Boolean(isBusy);
    updateBusyIndicator();
  }
  function isVerticalLayout() {
    return state.settings.layout !== "horizontal";
  }

  function isPortableLayout() {
    return state.settings.layout === "vertical-portable";
  }

  function isPortableRotationActive() {
    return app.dataset.portableRotated === "true";
  }

  function getPortableRotation() {
    return isPortableRotationActive() ? "clockwise" : "none";
  }

  let layoutFitFrame = 0;

  function fitScreenLayout() {
    layoutFitFrame = 0;
    const shellRect = screenShell.getBoundingClientRect();
    const shouldRotatePortable =
      isPortableLayout() && shellRect.height > shellRect.width && shellRect.width > 0;

    app.dataset.portableRotated = shouldRotatePortable ? "true" : "false";

    [learningScreen, resultScreen].forEach((screen) => {
      if (shouldRotatePortable) {
        screen.style.width = `${shellRect.height}px`;
        screen.style.height = `${shellRect.width}px`;
      } else {
        screen.style.removeProperty("width");
        screen.style.removeProperty("height");
      }
    });

    padStage.style.removeProperty("width");
    padStage.style.removeProperty("height");
    padStage.style.removeProperty("place-self");

    if (state.settings.layout === "horizontal" && !learningScreen.hidden) {
      padStage.style.width = "100%";
      padStage.style.height = "100%";
      padStage.style.placeSelf = "stretch";
      const available = padStage.getBoundingClientRect();
      const side = Math.max(1, Math.min(available.width, available.height));
      padStage.style.width = `${side}px`;
      padStage.style.height = `${side}px`;
      padStage.style.placeSelf = "center";
    }

    fitQuestionText();
    resizeCanvas();
  }

  function scheduleLayoutFit() {
    if (layoutFitFrame) {
      window.cancelAnimationFrame(layoutFitFrame);
    }
    layoutFitFrame = window.requestAnimationFrame(fitScreenLayout);
  }

  function getLogicalCanvasSize() {
    return {
      width: Math.max(1, canvas.clientWidth),
      height: Math.max(1, canvas.clientHeight),
    };
  }

  function resizeCanvas() {
    const logicalSize = getLogicalCanvasSize();
    const ratio = window.devicePixelRatio || 1;
    const previousSize = state.canvasCssSize;
    const sizeChanged =
      Math.abs(previousSize.width - logicalSize.width) > 0.5 ||
      Math.abs(previousSize.height - logicalSize.height) > 0.5;

    if (sizeChanged && previousSize.width > 0 && previousSize.height > 0) {
      scaleStoredInk(previousSize, logicalSize);
      resetNativeDrawing();
      resetCandidateStability();
    }

    state.canvasCssSize = logicalSize;
    canvas.width = Math.max(1, Math.round(logicalSize.width * ratio));
    canvas.height = Math.max(1, Math.round(logicalSize.height * ratio));

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawAllStrokes();
  }

  function scaleStoredInk(fromSize, toSize) {
    const scaleX = toSize.width / fromSize.width;
    const scaleY = toSize.height / fromSize.height;

    if (Math.abs(scaleX - 1) < 0.005 && Math.abs(scaleY - 1) < 0.005) {
      return;
    }

    forEachInputRecord((record) => {
      record.strokes.forEach((stroke) => {
        stroke.forEach((point) => {
          point.x *= scaleX;
          point.y *= scaleY;
        });
      });
    });

    if (state.pendingStartPoint) {
      state.pendingStartPoint.x *= scaleX;
      state.pendingStartPoint.y *= scaleY;
    }
  }

  function getLineWidth() {
    const shorterSide = Math.min(canvas.clientWidth || 0, canvas.clientHeight || 0);

    return Math.max(
      MIN_LINE_WIDTH,
      Math.min(MAX_LINE_WIDTH, shorterSide * LINE_WIDTH_RATIO),
    );
  }

  function clearCanvas() {
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  }

  function drawAllStrokes() {
    clearCanvas();
    state.strokes.forEach((stroke) => {
      stroke.forEach((point, index) => {
        drawPoint(point, index === 0 ? null : stroke[index - 1]);
      });
    });
  }

  function drawPoint(point, previousPoint) {
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = INK_COLOR;
    context.fillStyle = INK_COLOR;
    const lineWidth = getLineWidth();

    context.lineWidth = lineWidth;

    if (!previousPoint) {
      context.beginPath();
      context.arc(point.x, point.y, lineWidth / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }

    context.beginPath();
    context.moveTo(previousPoint.x, previousPoint.y);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function getCanvasPoint(event) {
    const point = getCanvasCoordinates(event);

    return {
      ...point,
      t: Math.round(performance.now() - state.strokeStartTime),
    };
  }

  function getCanvasCoordinates(event) {
    const localWidth = Math.max(1, canvas.clientWidth);
    const localHeight = Math.max(1, canvas.clientHeight);

    // A transformed ancestor can make getBoundingClientRect()-based pointer mapping
    // disagree with the coordinates reported by some iOS Chromium browsers.
    // offsetX/offsetY are already expressed in the canvas' untransformed local
    // coordinate system, so prefer them whenever the event is still targeted at
    // the captured canvas. Safari and desktop browsers retain the fallback below.
    const hasLocalOffset =
      event?.target === canvas &&
      Number.isFinite(event.offsetX) &&
      Number.isFinite(event.offsetY);

    if (hasLocalOffset) {
      return {
        x: Math.min(Math.max(event.offsetX, 0), localWidth),
        y: Math.min(Math.max(event.offsetY, 0), localHeight),
      };
    }

    const rect = canvas.getBoundingClientRect();
    const displayX = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const displayY = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);

    if (getPortableRotation() === "clockwise") {
      return {
        x: (displayY / Math.max(1, rect.height)) * localWidth,
        y: ((rect.width - displayX) / Math.max(1, rect.width)) * localHeight,
      };
    }

    return {
      x: (displayX / Math.max(1, rect.width)) * localWidth,
      y: (displayY / Math.max(1, rect.height)) * localHeight,
    };
  }

  function hasInk() {
    return state.strokes.some((stroke) => stroke.length > 1);
  }

  function getTotalInkLength() {
    return state.strokes.reduce((total, stroke) => total + getStrokeLength(stroke), 0);
  }

  function hasMeaningfulInk() {
    const bounds = getInkBounds();

    if (!bounds) {
      return false;
    }

    return (
      hasInk() &&
      getTotalInkLength() >= MIN_RECOGNITION_INK_LENGTH &&
      Math.max(bounds.width, bounds.height) >= MIN_RECOGNITION_INK_LENGTH * 0.55
    );
  }

  function getCanvasGuide() {
    const logicalSize = getLogicalCanvasSize();
    return {
      width: Math.max(1, Math.round(logicalSize.width)),
      height: Math.max(1, Math.round(logicalSize.height)),
    };
  }

  async function queryNativeSupport(constraint) {
    const query =
      navigator.queryHandwritingRecognizer ||
      navigator.queryHandwritingRecognizerSupport;

    if (typeof query !== "function") {
      return true;
    }

    try {
      return Boolean(await query.call(navigator, constraint));
    } catch {
      return true;
    }
  }

  async function createNativeRecognizer() {
    if (
      !window.isSecureContext ||
      typeof navigator.createHandwritingRecognizer !== "function" ||
      typeof window.HandwritingStroke !== "function"
    ) {
      return null;
    }

    for (const constraint of LANGUAGE_CANDIDATES) {
      try {
        if (await queryNativeSupport(constraint)) {
          return await navigator.createHandwritingRecognizer(constraint);
        }
      } catch {
        // Try the next language tag, then fall back to Google Input Tools.
      }
    }

    return null;
  }

  function getInputType() {
    const pointerType = canvas.dataset.lastPointerType;
    return SUPPORTED_POINTER_TYPES.has(pointerType) ? pointerType : undefined;
  }

  function ensureNativeDrawing() {
    if (!state.nativeRecognizer || state.nativeFailed) {
      return null;
    }

    if (!state.nativeDrawing) {
      const hints = {
        recognitionType: isFreeMode() ? "text" : "per-character",
        inputType: getInputType(),
        alternatives: 1,
      };

      Object.keys(hints).forEach((key) => {
        if (hints[key] === undefined) {
          delete hints[key];
        }
      });

      try {
        state.nativeDrawing = state.nativeRecognizer.startDrawing(hints);
      } catch {
        state.nativeDrawing = state.nativeRecognizer.startDrawing({
          recognitionType: "text",
          alternatives: 1,
        });
      }
    }

    state.nativeDrawing.clear();

    for (const stroke of state.strokes) {
      if (stroke.length === 0) {
        continue;
      }

      const nativeStroke = new HandwritingStroke();
      stroke.forEach((point) => {
        nativeStroke.addPoint({
          x: point.x,
          y: point.y,
          t: point.t,
        });
      });
      state.nativeDrawing.addStroke(nativeStroke);
    }

    return state.nativeDrawing;
  }

  async function recognizeWithNative() {
    const drawing = ensureNativeDrawing();

    if (!drawing) {
      return [];
    }

    try {
      const predictions = await drawing.getPrediction();
      return normalizeCandidates(
        predictions?.map((prediction) => prediction?.text) || [],
      );
    } catch {
      state.nativeFailed = true;
      state.nativeDrawing = null;
      return [];
    }
  }

  function buildGoogleInk() {
    return state.strokes
      .filter((stroke) => stroke.length > 0)
      .map((stroke) => [
        stroke.map((point) => Math.round(point.x)),
        stroke.map((point) => Math.round(point.y)),
        stroke.map((point) => Math.round(point.t)),
      ]);
  }

  async function postGooglePayload(url, payload, contentType) {
    const response = await fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: {
        "Content-Type": contentType,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Google handwriting request failed: ${response.status}`);
    }

    return response.json();
  }

  function extractCandidatesFromGoogleResponse(data) {
    if (!Array.isArray(data) || data[0] !== "SUCCESS") {
      return [];
    }

    const candidates = [];

    function walk(value) {
      if (typeof value === "string") {
        const text = value.trim();
        if (text) {
          candidates.push(text);
        }
        return;
      }

      if (Array.isArray(value)) {
        value.forEach(walk);
      }
    }

    walk(data[1]);
    return normalizeCandidates(candidates);
  }

  async function recognizeWithGoogle() {
    const guide = getCanvasGuide();
    const payload = {
      device: navigator.userAgent,
      options: "enable_pre_space",
      requests: [
        {
          writing_guide: {
            writing_area_width: guide.width,
            writing_area_height: guide.height,
          },
          ink: buildGoogleInk(),
          language: "ja",
        },
      ],
    };

    const contentTypes = ["text/plain;charset=UTF-8", "application/json"];

    for (const url of GOOGLE_HANDWRITING_URLS) {
      for (const contentType of contentTypes) {
        try {
          const data = await postGooglePayload(url, payload, contentType);
          const candidates = extractCandidatesFromGoogleResponse(data);

          if (candidates.length > 0) {
            state.googleFailed = false;
            return candidates;
          }
        } catch {
          // Try the next endpoint/content-type pair.
        }
      }
    }

    state.googleFailed = true;
    return [];
  }

  function normalizeCandidates(candidates) {
    const seen = new Set();
    const normalized = [];

    for (const candidate of candidates) {
      const rawText = String(candidate || "").trim();
      const text = !isFreeMode() && getCharacterLength(rawText) === 1
        ? EDUCATIONAL_GLYPH_NORMALIZATION[rawText] || rawText
        : rawText;

      if (!text || seen.has(text)) {
        continue;
      }

      seen.add(text);
      normalized.push(text);
    }

    return normalized;
  }

  function getCharStrokeCount(char) {
    const count = Number.isFinite(strokeCounts[char])
      ? strokeCounts[char]
      : SUPPLEMENTAL_STROKE_COUNTS[char];

    return Number.isFinite(count) ? count : null;
  }

  function getCandidateStrokeCount(text) {
    let total = 0;

    for (const char of Array.from(text)) {
      const count = getCharStrokeCount(char);

      if (!Number.isFinite(count)) {
        return null;
      }

      total += count;
    }

    return total || null;
  }

  function isCjkIdeograph(char) {
    return /^[\u3400-\u9fff]$/u.test(char);
  }

  function hasUnknownKanjiStrokeCount(text) {
    return Array.from(text).some((char) => {
      return isCjkIdeograph(char) && !Number.isFinite(getCharStrokeCount(char));
    });
  }

  function isKanaOnly(text) {
    return /^[\u3040-\u30ffー]+$/u.test(text);
  }

  function isJapaneseCandidate(text) {
    return (
      /[\u3040-\u30ff\u3400-\u9fff]/u.test(text) &&
      /^[\u3040-\u30ff\u3400-\u9fff々〆〤ヶヵー]+$/u.test(text)
    );
  }

  function getCharacterLength(text) {
    return Array.from(text).length;
  }

  function isAllowedCandidateForCurrentMode(text) {
    return isFreeMode()
      ? isHiraganaOnlyText(text)
      : getCharacterLength(text) === 1;
  }

  function getStrokeTolerance(expectedCount, text) {
    if (isKanaOnly(text)) {
      return 1;
    }

    return 0;
  }

  function getStrokeLength(stroke) {
    let length = 0;

    for (let index = 1; index < stroke.length; index += 1) {
      length += getDistance(stroke[index - 1], stroke[index]);
    }

    return length;
  }

  function getDistance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function getInkBounds() {
    const points = state.strokes.flat().filter(Boolean);

    if (points.length === 0) {
      return null;
    }

    const bounds = points.reduce(
      (acc, point) => ({
        left: Math.min(acc.left, point.x),
        right: Math.max(acc.right, point.x),
        top: Math.min(acc.top, point.y),
        bottom: Math.max(acc.bottom, point.y),
      }),
      {
        left: Infinity,
        right: -Infinity,
        top: Infinity,
        bottom: -Infinity,
      },
    );

    return {
      ...bounds,
      width: Math.max(1, bounds.right - bounds.left),
      height: Math.max(1, bounds.bottom - bounds.top),
    };
  }

  function clusterNumericBands(values, minGap) {
    const sorted = values
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    const clusters = [];

    sorted.forEach((value) => {
      const cluster = clusters[clusters.length - 1];

      if (!cluster || value - cluster.center > minGap) {
        clusters.push({ center: value, count: 1 });
        return;
      }

      cluster.center = (cluster.center * cluster.count + value) / (cluster.count + 1);
      cluster.count += 1;
    });

    return clusters;
  }

  function getStrokeFeatures() {
    return state.strokes
      .filter((stroke) => stroke.length > 1)
      .map((stroke) => {
        const xs = stroke.map((point) => point.x);
        const ys = stroke.map((point) => point.y);
        const left = Math.min(...xs);
        const right = Math.max(...xs);
        const top = Math.min(...ys);
        const bottom = Math.max(...ys);

        return {
          left,
          right,
          top,
          bottom,
          width: Math.max(1, right - left),
          height: Math.max(1, bottom - top),
          centerX: (left + right) / 2,
          centerY: (top + bottom) / 2,
          length: getStrokeLength(stroke),
          start: stroke[0],
          end: stroke[stroke.length - 1],
        };
      });
  }

  function getSegmentFeatures(bounds = getInkBounds()) {
    if (!bounds) {
      return [];
    }

    const guide = getCanvasGuide();
    const diagonal = Math.hypot(guide.width, guide.height);
    const minPointDistance = Math.max(5, diagonal * 0.008);
    const minSegmentLength = Math.max(7, diagonal * 0.012);
    const segments = [];

    state.strokes.forEach((stroke) => {
      const simplified = simplifyStroke(stroke, minPointDistance);

      for (let index = 1; index < simplified.length; index += 1) {
        const start = simplified[index - 1];
        const end = simplified[index];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);

        if (length < minSegmentLength) {
          continue;
        }

        const left = Math.min(start.x, end.x);
        const right = Math.max(start.x, end.x);
        const top = Math.min(start.y, end.y);
        const bottom = Math.max(start.y, end.y);

        segments.push({
          start,
          end,
          dx,
          dy,
          length,
          left,
          right,
          top,
          bottom,
          centerX: (start.x + end.x) / 2,
          centerY: (start.y + end.y) / 2,
          isHorizontal: Math.abs(dx) >= Math.max(Math.abs(dy) * 1.45, bounds.width * 0.035),
          isVertical: Math.abs(dy) >= Math.max(Math.abs(dx) * 1.35, bounds.height * 0.05),
        });
      }
    });

    return segments;
  }

  function hasLikelyLeftEyeComponent() {
    const bounds = getInkBounds();

    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      return false;
    }

    const leftRegionRight = bounds.left + bounds.width * 0.46;
    const leftRegionHardRight = bounds.left + bounds.width * 0.54;
    const segments = getSegmentFeatures(bounds);
    const horizontalBands = clusterNumericBands(
      segments
        .filter((segment) => {
          return (
            segment.isHorizontal &&
            segment.length >= Math.max(10, bounds.width * 0.07) &&
            segment.centerX <= leftRegionRight &&
            segment.right <= leftRegionHardRight &&
            segment.centerY >= bounds.top + bounds.height * 0.08 &&
            segment.centerY <= bounds.bottom - bounds.height * 0.05
          );
        })
        .map((segment) => segment.centerY),
      Math.max(8, bounds.height * 0.085),
    );

    const verticals = segments.filter((segment) => {
      return (
        segment.isVertical &&
        segment.centerX <= leftRegionHardRight &&
        segment.length >= Math.max(12, bounds.height * 0.18)
      );
    });

    return horizontalBands.length >= 4 && verticals.length >= 1;
  }

  function hasLikelyLeftFishComponent() {
    const bounds = getInkBounds();

    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      return false;
    }

    const leftRegionRight = bounds.left + bounds.width * 0.52;
    const lowerLimit = bounds.top + bounds.height * 0.66;
    const features = getStrokeFeatures();
    const lowerDotLikeMarks = features.filter((feature) => {
      return (
        feature.centerX <= leftRegionRight &&
        feature.centerY >= lowerLimit &&
        feature.length >= 5 &&
        feature.length <= Math.max(42, bounds.height * 0.24) &&
        feature.width <= bounds.width * 0.2 &&
        feature.height <= bounds.height * 0.22
      );
    });

    return lowerDotLikeMarks.length >= 3;
  }

  function getHorizontalBands(bounds = getInkBounds()) {
    if (!bounds) {
      return [];
    }

    const segments = getSegmentFeatures(bounds)
      .filter((segment) => segment.isHorizontal && segment.length >= bounds.width * 0.12)
      .map((segment) => ({
        y: segment.centerY,
        left: segment.left,
        right: segment.right,
        length: segment.length,
        centerX: segment.centerX,
      }))
      .sort((a, b) => a.y - b.y);

    const bands = [];
    const gap = Math.max(8, bounds.height * 0.065);

    segments.forEach((segment) => {
      const band = bands[bands.length - 1];

      if (!band || segment.y - band.y > gap) {
        bands.push({ ...segment, count: 1 });
        return;
      }

      band.y = (band.y * band.count + segment.y) / (band.count + 1);
      band.left = Math.min(band.left, segment.left);
      band.right = Math.max(band.right, segment.right);
      band.length = Math.max(band.length, segment.length);
      band.centerX = (band.left + band.right) / 2;
      band.count += 1;
    });

    return bands;
  }

  function hasLikelyCrowStructure() {
    const bounds = getInkBounds();

    if (!bounds) {
      return false;
    }

    const strokeStats = estimateInputStrokeStats();
    const bands = getHorizontalBands(bounds).filter((band) => {
      return band.y <= bounds.top + bounds.height * 0.72;
    });

    // 「烏」は「鳥」より一画少なく、中央の目に当たる横画が少ない。
    return strokeStats.rawCount <= 10 && bands.length <= 4;
  }

  function hasLikelyYouStructure() {
    const bounds = getInkBounds();

    if (!bounds) {
      return false;
    }

    const bands = getHorizontalBands(bounds).filter((band) => {
      return band.y <= bounds.top + bounds.height * 0.5;
    });

    if (bands.length < 2) {
      return false;
    }

    const upper = bands[0];
    const lower = bands[1];
    const upperStroke = getStrokeFeatures()
      .filter((feature) => feature.centerY <= bounds.top + bounds.height * 0.3)
      .sort((a, b) => b.length - a.length)[0];
    const upperSlantsDown = upperStroke
      ? Math.abs(upperStroke.end.y - upperStroke.start.y) > Math.abs(upperStroke.end.x - upperStroke.start.x) * 0.18
      : false;

    return upper.length < lower.length * 0.72 && upperSlantsDown;
  }

  function getUpperBoxAndHorizontalRelation() {
    const bounds = getInkBounds();

    if (!bounds) {
      return null;
    }

    const segments = getSegmentFeatures(bounds);
    const upperLimit = bounds.top + bounds.height * 0.7;
    const shortHorizontals = segments.filter((segment) => {
      return (
        segment.isHorizontal &&
        segment.centerY <= upperLimit &&
        segment.length >= bounds.width * 0.12 &&
        segment.length <= bounds.width * 0.48
      );
    });
    const verticals = segments.filter((segment) => {
      return (
        segment.isVertical &&
        segment.centerY <= upperLimit &&
        segment.length >= bounds.height * 0.1 &&
        segment.length <= bounds.height * 0.4
      );
    });

    let boxCenterY = null;
    for (const horizontal of shortHorizontals) {
      const leftVertical = verticals.find((vertical) => {
        return Math.abs(vertical.centerX - horizontal.left) <= bounds.width * 0.12;
      });
      const rightVertical = verticals.find((vertical) => {
        return Math.abs(vertical.centerX - horizontal.right) <= bounds.width * 0.12;
      });

      if (leftVertical || rightVertical) {
        const related = [horizontal, leftVertical, rightVertical].filter(Boolean);
        boxCenterY = related.reduce((sum, item) => sum + item.centerY, 0) / related.length;
        break;
      }
    }

    if (!Number.isFinite(boxCenterY)) {
      return null;
    }

    const longHorizontal = segments
      .filter((segment) => {
        return (
          segment.isHorizontal &&
          segment.centerY <= upperLimit &&
          segment.length >= bounds.width * 0.42
        );
      })
      .sort((a, b) => Math.abs(a.centerY - boxCenterY) - Math.abs(b.centerY - boxCenterY))[0];

    if (!longHorizontal) {
      return null;
    }

    return longHorizontal.centerY < boxCenterY ? "horizontal-above" : "horizontal-below";
  }

  function countCredibleJoinedCorners() {
    const bounds = getInkBounds();

    if (!bounds) {
      return 0;
    }

    const guide = getCanvasGuide();
    const minDistance = Math.max(8, Math.hypot(guide.width, guide.height) * 0.014);
    const minLeg = Math.max(18, Math.min(bounds.width, bounds.height) * 0.1);
    let count = 0;

    state.strokes.forEach((stroke) => {
      const points = simplifyStroke(stroke, minDistance);

      for (let index = 1; index < points.length - 1; index += 1) {
        const a = points[index - 1];
        const b = points[index];
        const c = points[index + 1];
        const lenA = getDistance(a, b);
        const lenB = getDistance(b, c);

        if (lenA < minLeg || lenB < minLeg) {
          continue;
        }

        const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
        const angle = Math.acos(Math.max(-1, Math.min(1, dot / (lenA * lenB))));

        if (angle >= Math.PI * 0.32 && angle <= Math.PI * 0.72) {
          count += 1;
        }
      }
    });

    return count;
  }

  function hasRequiredCandidateStructure(text) {
    if (text === "感") {
      return getUpperBoxAndHorizontalRelation() === "horizontal-above";
    }

    if (text === "惑") {
      return getUpperBoxAndHorizontalRelation() === "horizontal-below";
    }

    if (text === "天" && hasLikelyYouStructure()) {
      return false;
    }

    if (text === "鳥" && hasLikelyCrowStructure()) {
      return false;
    }

    return true;
  }

  function simplifyStroke(stroke, minDistance) {
    if (stroke.length <= 2) {
      return stroke.slice();
    }

    const simplified = [stroke[0]];
    let last = stroke[0];

    for (let index = 1; index < stroke.length - 1; index += 1) {
      const point = stroke[index];

      if (getDistance(last, point) >= minDistance) {
        simplified.push(point);
        last = point;
      }
    }

    simplified.push(stroke[stroke.length - 1]);
    return simplified;
  }

  function estimateSegmentsInStroke(stroke, guide) {
    if (stroke.length < 2) {
      return 0;
    }

    const diagonal = Math.hypot(guide.width, guide.height);
    const minPointDistance = Math.max(7, diagonal * 0.012);
    const minSectionLength = Math.max(24, diagonal * 0.04);
    const simplified = simplifyStroke(stroke, minPointDistance);

    if (simplified.length < 3) {
      return 1;
    }

    let segments = 1;
    let distanceSinceBreak = 0;
    let remainingLength = 0;
    const lengths = [];

    for (let index = 1; index < simplified.length; index += 1) {
      const length = getDistance(simplified[index - 1], simplified[index]);
      lengths.push(length);
      remainingLength += length;
    }

    for (let index = 1; index < simplified.length - 1; index += 1) {
      const before = simplified[index - 1];
      const current = simplified[index];
      const after = simplified[index + 1];
      const lenA = getDistance(before, current);
      const lenB = getDistance(current, after);

      distanceSinceBreak += lengths[index - 1] || 0;
      remainingLength -= lengths[index - 1] || 0;

      if (lenA < minPointDistance || lenB < minPointDistance) {
        continue;
      }

      const dot =
        (current.x - before.x) * (after.x - current.x) +
        (current.y - before.y) * (after.y - current.y);
      const ratio = Math.max(-1, Math.min(1, dot / (lenA * lenB)));
      const turn = Math.acos(ratio);

      if (
        turn > Math.PI * 0.58 &&
        distanceSinceBreak >= minSectionLength &&
        remainingLength >= minSectionLength
      ) {
        segments += 1;
        distanceSinceBreak = 0;
      }
    }

    return Math.max(1, segments);
  }

  function estimateInputStrokeStats() {
    const guide = getCanvasGuide();
    const rawCount = state.strokes.filter((stroke) => stroke.length > 1).length;
    const virtualCount = state.strokes.reduce((total, stroke) => {
      return total + estimateSegmentsInStroke(stroke, guide);
    }, 0);

    return {
      rawCount,
      virtualCount: Math.max(rawCount, virtualCount),
    };
  }

  function hasShinnyouChar(text) {
    return Array.from(text).some((char) => SHINNYOU_CHARS.has(char));
  }

  function hasCompletedShinnyouSweep() {
    const bounds = getInkBounds();

    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      return false;
    }

    const guide = getCanvasGuide();
    const diagonal = Math.hypot(guide.width, guide.height);
    const minPointDistance = Math.max(7, diagonal * 0.012);
    const bottomBandTop = bounds.top + bounds.height * 0.68;
    const minSweepDx = Math.max(bounds.width * 0.5, guide.width * 0.15);

    for (const stroke of state.strokes) {
      const simplified = simplifyStroke(stroke, minPointDistance);
      let runDx = 0;
      let runStartX = null;
      let runEndX = null;

      for (let index = 1; index < simplified.length; index += 1) {
        const before = simplified[index - 1];
        const after = simplified[index];
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        const midY = (before.y + after.y) / 2;
        const isBottom = midY >= bottomBandTop;
        const isRightward = dx > 0;
        const isMostlyHorizontal =
          Math.abs(dy) <= Math.max(Math.abs(dx) * 0.5, bounds.height * 0.08);

        if (isBottom && isRightward && isMostlyHorizontal) {
          runStartX = runStartX ?? before.x;
          runEndX = after.x;
          runDx += dx;

          if (
            runDx >= minSweepDx &&
            runStartX <= bounds.left + bounds.width * 0.38 &&
            runEndX >= bounds.left + bounds.width * 0.72
          ) {
            return true;
          }
        } else {
          runDx = 0;
          runStartX = null;
          runEndX = null;
        }
      }
    }

    return false;
  }

  const SANZUI_CHARS = new Set(
    Array.from(
      "汁汀氾池汐汎汚汝江汲決汽沃沖沈沙没沢河沼沸油治沿況泉泊泣注波泳泥沫法泌泡洋洗洞津洪洲活派流浄浅浜浦浴浮海消涙液涼淑淡深混清済渉渋渓湖湘湯湾湿満源準滞漁演漠漢漬漸潔潜潟潤澄濁濃濯瀬瀕灌",
    ),
  );

  function hasSanzuiChar(text) {
    return Array.from(text).some((char) => SANZUI_CHARS.has(char));
  }

  function hasCompletedSanzui() {
    const bounds = getInkBounds();

    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      return false;
    }

    const leftLimit = bounds.left + bounds.width * 0.42;
    const marks = state.strokes
      .filter((stroke) => stroke.length > 1)
      .map((stroke) => {
        const start = stroke[0];
        const end = stroke[stroke.length - 1];
        const xs = stroke.map((point) => point.x);
        const ys = stroke.map((point) => point.y);
        const left = Math.min(...xs);
        const right = Math.max(...xs);
        const top = Math.min(...ys);
        const bottom = Math.max(...ys);
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = getStrokeLength(stroke);

        return {
          centerX,
          centerY,
          dx,
          dy,
          length,
          isLeft: centerX <= leftLimit,
        };
      })
      .filter((mark) => mark.isLeft && mark.length >= 8);

    const topMark = marks.some(
      (mark) => mark.centerY <= bounds.top + bounds.height * 0.4 && mark.dy > 2,
    );
    const middleMark = marks.some(
      (mark) =>
        mark.centerY > bounds.top + bounds.height * 0.25 &&
        mark.centerY < bounds.top + bounds.height * 0.72 &&
        mark.dy > 2,
    );
    const lowerSweep = marks.some(
      (mark) =>
        mark.centerY >= bounds.top + bounds.height * 0.58 &&
        mark.dx > 6 &&
        Math.abs(mark.dx) >= Math.abs(mark.dy) * 0.6,
    );

    return topMark && middleMark && lowerSweep;
  }

  const KUSAKANMURI_CHARS = new Set(
    Array.from(
      "花芳芸芽苗若苦英茂茎草荒荘荷菊菌菓菜華菩萎著葬蒸蓄蔵薄薦薫薬藩藤藍蘇蘭漢范",
    ),
  );

  function hasKusakanmuriChar(text) {
    return Array.from(text).some((char) => KUSAKANMURI_CHARS.has(char));
  }

  function hasCompletedKusakanmuriTop() {
    const bounds = getInkBounds();

    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      return false;
    }

    const topLimit = bounds.top + bounds.height * 0.34;
    const topStrokes = state.strokes.filter((stroke) => {
      if (stroke.length < 2) {
        return false;
      }

      const xs = stroke.map((point) => point.x);
      const ys = stroke.map((point) => point.y);
      const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
      return centerY <= topLimit;
    });
    const horizontal = topStrokes.some((stroke) => {
      const start = stroke[0];
      const end = stroke[stroke.length - 1];
      return Math.abs(end.x - start.x) > bounds.width * 0.16;
    });
    const verticalishMarks = topStrokes.filter((stroke) => {
      const start = stroke[0];
      const end = stroke[stroke.length - 1];
      return Math.abs(end.y - start.y) > 10;
    }).length;

    return horizontal && verticalishMarks >= 2;
  }

  function getAllowedRawShortfall(expectedCount, text) {
    if (isKanaOnly(text) || isFreeMode()) {
      return isKanaOnly(text) ? expectedCount : Math.min(2, Math.floor(expectedCount * 0.18));
    }

    // 文字枠モードは学習用途なので、単なる曲線や崩れを「つなげ書き」と数えない。
    // 明確な折れが存在する場合に限り、一画までの結合を認める。
    const joinedCorners = countCredibleJoinedCorners();
    return joinedCorners >= 1 && expectedCount >= 5 ? 1 : 0;
  }

  function getAllowedRawOverage(text) {
    if (isFreeMode() || isKanaOnly(text)) {
      return 1;
    }

    return 0;
  }

  function isStrokeCompatible(text, strokeStats) {
    const expectedCount = getCandidateStrokeCount(text);

    if (!expectedCount) {
      return isFreeMode();
    }

    if (!hasRequiredCandidateStructure(text)) {
      return false;
    }

    if (hasShinnyouChar(text) && !hasCompletedShinnyouSweep()) {
      return false;
    }

    if (hasSanzuiChar(text) && !hasCompletedSanzui()) {
      return false;
    }

    if (hasKusakanmuriChar(text) && !hasCompletedKusakanmuriTop()) {
      return false;
    }

    const tolerance = getStrokeTolerance(expectedCount, text);
    const allowedRawShortfall = getAllowedRawShortfall(expectedCount, text);
    const allowedRawOverage = getAllowedRawOverage(text);

    return (
      strokeStats.virtualCount + tolerance >= expectedCount &&
      strokeStats.rawCount >= expectedCount - allowedRawShortfall &&
      strokeStats.rawCount <= expectedCount + allowedRawOverage
    );
  }

  function canUseStructuralAlternative(rule, strokeStats) {
    if (typeof rule.test !== "function" || !rule.test(strokeStats)) {
      return false;
    }

    return isStrokeCompatible(rule.target, strokeStats);
  }

  function expandStructuralAlternatives(candidates, strokeStats) {
    const expanded = [];
    const seen = new Set();

    function push(text) {
      if (!seen.has(text)) {
        seen.add(text);
        expanded.push(text);
      }
    }

    candidates.forEach((candidate) => {
      STRUCTURAL_ALTERNATIVE_RULES.forEach((rule) => {
        if (candidate === rule.source && canUseStructuralAlternative(rule, strokeStats)) {
          push(rule.target);
        }
      });

      push(candidate);
    });

    return expanded;
  }

  function getCandidateStrokeRank(text, strokeStats, originalIndex) {
    const expectedCount = getCandidateStrokeCount(text);

    if (!Number.isFinite(expectedCount)) {
      return 1000 + originalIndex * 0.01;
    }

    const virtualDistance = Math.abs(strokeStats.virtualCount - expectedCount);
    const rawDistance = Math.abs(strokeStats.rawCount - expectedCount);
    const overagePenalty = Math.max(0, strokeStats.rawCount - expectedCount) * 0.35;

    return virtualDistance * 3 + rawDistance * 0.55 + overagePenalty + originalIndex * 0.01;
  }

  function orderCandidatesByStrokeFit(candidates, strokeStats) {
    return candidates
      .map((text, index) => ({
        text,
        rank: getCandidateStrokeRank(text, strokeStats, index),
      }))
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.text);
  }

  function selectDisplayCandidate(candidates, strokeStats = estimateInputStrokeStats()) {
    const normalized = normalizeCandidates(candidates);

    if (normalized.length === 0) {
      return "";
    }

    const structurallyExpanded = expandStructuralAlternatives(normalized, strokeStats);
    const japaneseCandidates = structurallyExpanded
      .filter(isJapaneseCandidate)
      .filter(isAllowedCandidateForCurrentMode);

    if (japaneseCandidates.length === 0) {
      return "";
    }

    const compatibleCandidates = japaneseCandidates.filter((text) =>
      isStrokeCompatible(text, strokeStats),
    );

    if (compatibleCandidates.length === 0) {
      return "";
    }

    return orderCandidatesByStrokeFit(compatibleCandidates, strokeStats)[0] || "";
  }

  function isPointerInputActive() {
    return (
      state.pendingPointerId !== null ||
      state.activePointerId !== null ||
      Boolean(state.activeStrokePoints)
    );
  }

  function resetCandidateStability() {
    state.candidateStability.text = "";
    state.candidateStability.signature = "";
    state.candidateStability.firstSeenAt = 0;
    state.candidateStability.confirmations = 0;
    state.nextRecognitionDelay = RECOGNITION_RETRY_DELAY_MS;
  }

  function getInkSignature(strokeStats = estimateInputStrokeStats()) {
    const bounds = getInkBounds();

    if (!bounds) {
      return "empty";
    }

    return [
      strokeStats.rawCount,
      strokeStats.virtualCount,
      Math.round(getTotalInkLength() / 8),
      Math.round(bounds.left / 8),
      Math.round(bounds.top / 8),
      Math.round(bounds.width / 8),
      Math.round(bounds.height / 8),
    ].join(":");
  }

  function requiresCandidateStability(text, strokeStats) {
    const expectedCount = getCandidateStrokeCount(text);

    return (
      hasShinnyouChar(text) ||
      hasSanzuiChar(text) ||
      hasKusakanmuriChar(text) ||
      hasUnknownKanjiStrokeCount(text) ||
      (Number.isFinite(expectedCount) &&
        expectedCount >= COMPLEX_STROKE_STABILITY_THRESHOLD) ||
      strokeStats.rawCount >= COMPLEX_STROKE_STABILITY_THRESHOLD
    );
  }

  function getStableCandidateDecision(text, strokeStats) {
    if (!text) {
      resetCandidateStability();
      return { text: "", pending: false };
    }

    if (!requiresCandidateStability(text, strokeStats)) {
      resetCandidateStability();
      return { text, pending: false };
    }

    const signature = getInkSignature(strokeStats);
    const now = performance.now();
    const stability = state.candidateStability;

    if (stability.text !== text || stability.signature !== signature) {
      stability.text = text;
      stability.signature = signature;
      stability.firstSeenAt = now;
      stability.confirmations = 1;
    } else {
      stability.confirmations += 1;
    }

    if (
      !isPointerInputActive() &&
      stability.confirmations >= STABILITY_MIN_CONFIRMATIONS &&
      now - stability.firstSeenAt >= STABILITY_CONFIRM_DELAY_MS * 0.5
    ) {
      return { text, pending: false };
    }

    return {
      text: "",
      pending: true,
      delay: STABILITY_CONFIRM_DELAY_MS,
    };
  }

  function getDragStartDistance(pointerType) {
    return pointerType === "touch"
      ? DRAG_START_DISTANCE_TOUCH
      : DRAG_START_DISTANCE_MOUSE;
  }

  function prepareStroke(event) {
    window.clearTimeout(state.recognitionTimer);
    resetCandidateStability();
    state.pendingPointerId = event.pointerId;
    state.pendingStartPoint = getCanvasCoordinates(event);
    state.pendingStartTime = performance.now();
    state.pendingPointerType = event.pointerType || "";

    if (typeof canvas.setPointerCapture === "function") {
      canvas.setPointerCapture(event.pointerId);
    }
  }

  function startStroke(event) {
    if (!state.pendingStartPoint) {
      return;
    }

    canvas.dataset.lastPointerType = state.pendingPointerType;
    state.recognitionSerial += 1;
    state.strokeStartTime = state.pendingStartTime;
    state.activePointerId = event.pointerId;
    state.activeStrokePoints = [];
    state.lastPoint = null;
    state.strokes.push(state.activeStrokePoints);
    resetCandidateStability();
    clearActiveRecognition();
    updateActionButtons();

    addPreparedPoint(state.pendingStartPoint);
    addPoint(event);
    state.pendingPointerId = null;
    state.pendingStartPoint = null;
    state.pendingPointerType = "";
    setBusy(true);
    scheduleRecognition(RECOGNITION_DRAW_DELAY_MS);
  }

  function addPreparedPoint(point) {
    if (!state.activeStrokePoints) {
      return;
    }

    const preparedPoint = {
      ...point,
      t: 0,
    };

    state.activeStrokePoints.push(preparedPoint);
    drawPoint(preparedPoint, state.lastPoint);
    state.lastPoint = preparedPoint;
  }

  function addPoint(event) {
    if (!state.activeStrokePoints) {
      return;
    }

    const point = getCanvasPoint(event);
    state.activeStrokePoints.push(point);
    drawPoint(point, state.lastPoint);
    state.lastPoint = point;
  }

  function continueStroke(event) {
    if (
      event.pointerId === state.pendingPointerId &&
      state.pendingStartPoint &&
      !state.activeStrokePoints
    ) {
      event.preventDefault();
      const currentPoint = getCanvasCoordinates(event);
      const distance = getDistance(state.pendingStartPoint, currentPoint);

      if (distance >= getDragStartDistance(state.pendingPointerType)) {
        startStroke(event);
      }

      return;
    }

    if (event.pointerId !== state.activePointerId || !state.activeStrokePoints) {
      return;
    }

    event.preventDefault();

    const events =
      typeof event.getCoalescedEvents === "function"
        ? event.getCoalescedEvents()
        : [event];

    events.forEach(addPoint);
    scheduleRecognition(RECOGNITION_DRAW_DELAY_MS);
  }

  function finishStroke(event) {
    if (
      event.pointerId === state.pendingPointerId &&
      state.pendingStartPoint &&
      !state.activeStrokePoints
    ) {
      event.preventDefault();

      if (
        typeof canvas.hasPointerCapture === "function" &&
        canvas.hasPointerCapture(event.pointerId)
      ) {
        canvas.releasePointerCapture(event.pointerId);
      }

      state.pendingPointerId = null;
      state.pendingStartPoint = null;
      state.pendingPointerType = "";
      return;
    }

    if (event.pointerId !== state.activePointerId || !state.activeStrokePoints) {
      return;
    }

    event.preventDefault();

    if (
      typeof canvas.hasPointerCapture === "function" &&
      canvas.hasPointerCapture(event.pointerId)
    ) {
      canvas.releasePointerCapture(event.pointerId);
    }

    state.activePointerId = null;
    state.activeStrokePoints = null;
    state.lastPoint = null;
    scheduleRecognition(RECOGNITION_FINISH_DELAY_MS);
  }

  function scheduleRecognition(delay) {
    if (!hasMeaningfulInk()) {
      if (hasInk()) {
        setResult(messages.noCandidate, "message");
      }

      setBusy(false);
      return;
    }

    setBusy(true);
    window.clearTimeout(state.recognitionTimer);
    state.recognitionTimer = window.setTimeout(runRecognition, delay);
  }

  async function runRecognition() {
    if (!hasMeaningfulInk()) {
      if (hasInk()) {
        setResult(messages.noCandidate, "message");
      }

      setBusy(false);
      return;
    }

    if (state.isRecognizing) {
      state.needsRecognition = true;
      return;
    }

    state.isRecognizing = true;
    const serial = ++state.recognitionSerial;

    try {
      state.nextRecognitionDelay = RECOGNITION_RETRY_DELAY_MS;
      const strokeStats = estimateInputStrokeStats();
      const nativeCandidates = await recognizeWithNative();
      let text = selectDisplayCandidate(nativeCandidates, strokeStats);

      if (!text) {
        text = selectDisplayCandidate(await recognizeWithGoogle(), strokeStats);
      }

      if (serial !== state.recognitionSerial || !hasMeaningfulInk()) {
        return;
      }

      const decision = getStableCandidateDecision(text, strokeStats);

      if (decision.pending) {
        state.needsRecognition = true;
        state.nextRecognitionDelay = decision.delay;
        return;
      }

      if (decision.text) {
        setResult(decision.text, "result");
      } else {
        setResult(
          state.googleFailed ? messages.networkUnavailable : messages.noCandidate,
          "message",
        );
      }
    } finally {
      state.isRecognizing = false;

      if (serial !== state.recognitionSerial) {
        return;
      }

      if (state.needsRecognition) {
        const delay = state.nextRecognitionDelay || RECOGNITION_RETRY_DELAY_MS;
        state.needsRecognition = false;
        state.nextRecognitionDelay = RECOGNITION_RETRY_DELAY_MS;
        scheduleRecognition(delay);
      } else {
        setBusy(false);
      }
    }
  }

  function resetNativeDrawing() {
    if (state.nativeDrawing) {
      state.nativeDrawing.clear();
      state.nativeDrawing = null;
    }
  }

  function resetPointerState() {
    state.activePointerId = null;
    state.pendingPointerId = null;
    state.pendingStartPoint = null;
    state.pendingPointerType = "";
    state.activeStrokePoints = null;
    state.lastPoint = null;
  }

  function activateCurrentInput({ recognizeIfNeeded = true } = {}) {
    window.clearTimeout(state.recognitionTimer);
    state.recognitionSerial += 1;
    resetPointerState();
    resetNativeDrawing();
    resetCandidateStability();
    refreshActiveStrokesReference();
    drawAllStrokes();
    renderResultArea();
    updateActionButtons();
    setBusy(false);

    if (recognizeIfNeeded && hasMeaningfulInk() && !getActiveInputRecord().text) {
      setBusy(true);
      scheduleRecognition(RECOGNITION_FINISH_DELAY_MS);
    }
  }

  function moveSlot(delta) {
    const count = getVisibleSlotCount();
    const nextIndex = Math.max(0, Math.min(count - 1, state.activeSlotIndex + delta));

    if (nextIndex === state.activeSlotIndex) {
      return;
    }

    state.activeSlotIndex = nextIndex;
    const item = state.session[state.currentQuestionIndex];
    if (item) {
      item.activeSlotIndex = nextIndex;
    }
    activateCurrentInput();
  }

  function undoLastStroke() {
    if (state.strokes.length === 0) {
      return;
    }

    window.clearTimeout(state.recognitionTimer);
    state.recognitionSerial += 1;
    resetPointerState();
    resetNativeDrawing();
    resetCandidateStability();
    state.strokes.pop();
    clearActiveRecognition();
    drawAllStrokes();
    updateActionButtons();

    if (hasMeaningfulInk()) {
      setBusy(true);
      scheduleRecognition(RECOGNITION_FINISH_DELAY_MS);
    } else {
      setBusy(false);
      setResult(hasInk() ? messages.noCandidate : messages.empty, "message");
    }
  }

  function clearPad() {
    window.clearTimeout(state.recognitionTimer);
    state.recognitionSerial += 1;
    resetPointerState();
    resetNativeDrawing();
    resetCandidateStability();
    const record = getActiveInputRecord();
    record.strokes.length = 0;
    record.text = "";
    record.message = "";
    record.state = "message";
    refreshActiveStrokesReference();

    clearCanvas();
    updateActionButtons();
    setBusy(false);
    setResult(messages.empty, "message");
  }

  function updateActionButtons() {
    const count = getVisibleSlotCount();
    undoButton.disabled = state.strokes.length === 0;
    slotPosition.textContent = isFreeMode()
      ? "フリー"
      : `${state.activeSlotIndex + 1} / ${count}`;
    slotPosition.dataset.atStart = state.activeSlotIndex <= 0 ? "true" : "false";
    slotPosition.dataset.atEnd = state.activeSlotIndex >= count - 1 ? "true" : "false";
  }

  function stripDuplicatedAnswerSuffix(answer, back) {
    let normalized = String(answer || "").trim();
    const suffixTarget = String(back || "").trimStart();
    const duplicatedMarks = new Set(["。", "、", "！", "？", "!", "?"]);

    while (normalized && suffixTarget) {
      const lastChar = Array.from(normalized).at(-1);
      const firstBackChar = Array.from(suffixTarget)[0];
      if (lastChar !== firstBackChar || !duplicatedMarks.has(lastChar)) {
        break;
      }
      normalized = Array.from(normalized).slice(0, -1).join("").trimEnd();
    }

    return normalized;
  }

  function normalizeComparableText(text) {
    return String(text || "")
      .normalize("NFKC")
      .replace(/[\s\u3000]/g, "")
      .trim();
  }

  function hashString(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function createQuestion(row, sourceIndex) {
    const source = row && typeof row === "object" ? row : {};
    const front = source.front ?? source["前部"] ?? "";
    const prompt = source.prompt ?? source["問部"] ?? "";
    const back = source.back ?? source["後部"] ?? "";
    const rawAnswer = source.answer ?? source["解答"] ?? "";
    const explanation = source.explanation ?? source["解説"] ?? "";
    const cleanPrompt = String(prompt).trim();
    const cleanRawAnswer = String(rawAnswer).trim();
    const answer = stripDuplicatedAnswerSuffix(cleanRawAnswer, back);

    if (!cleanPrompt || !answer) {
      return null;
    }

    const identity = [front, cleanPrompt, back, cleanRawAnswer, explanation].join("\u241f");
    const key = `q_${hashString(identity)}`;
    const saved = state.stats[key] || {};

    return {
      key,
      sourceIndex,
      front: String(front),
      prompt: cleanPrompt,
      back: String(back),
      rawAnswer: cleanRawAnswer,
      answer,
      inputMode: isHiraganaOnlyText(answer) ? "free" : "slots",
      explanation: String(explanation).trim() || "解説は登録されていません。",
      totalAttempts: Math.max(0, Number(saved.totalAttempts) || 0),
      correctCount: Math.max(0, Number(saved.correctCount) || 0),
    };
  }

  function getQuestionPriorityWeight(question) {
    const attempts = question.totalAttempts;
    const accuracy = attempts > 0 ? question.correctCount / attempts : 0;
    const errorPriority = 1 + (1 - accuracy) * 5;
    const newQuestionPriority = attempts === 0 ? 2.25 : 0;
    const lowExposurePriority = 1.4 / Math.sqrt(attempts + 1);
    return errorPriority + newQuestionPriority + lowExposurePriority;
  }

  function selectSessionQuestions(questions) {
    return questions
      .map((question) => {
        const weight = getQuestionPriorityWeight(question);
        const random = Math.max(Number.EPSILON, Math.random());
        return { question, key: Math.pow(random, 1 / weight) };
      })
      .sort((a, b) => b.key - a.key)
      .slice(0, Math.min(MAX_SESSION_QUESTIONS, questions.length))
      .map((entry) => entry.question);
  }

  function createSessionItem(question) {
    const inputMode = question.inputMode === "free" ? "free" : "slots";
    const characters = Array.from(question.answer);
    return {
      question,
      inputMode,
      slots: inputMode === "free"
        ? [createInputRecord()]
        : characters.map(createInputRecord),
      activeSlotIndex: 0,
      answerText: "",
      isCorrect: false,
    };
  }

  function getItemAnswer(item, placeholder = false) {
    if (item.inputMode === "free") {
      return item.slots[0]?.text || (placeholder ? "□" : "");
    }
    return item.slots
      .map((record) => record.text || (placeholder ? "□" : ""))
      .join("");
  }

  function saveCurrentSessionState() {
    const item = state.session[state.currentQuestionIndex];
    if (!item) {
      return;
    }
    item.activeSlotIndex = state.activeSlotIndex;
    item.answerText = getItemAnswer(item);
  }

  function renderQuestionText(question) {
    questionText.replaceChildren();
    const front = document.createElement("span");
    front.className = "question-part question-front";
    front.textContent = question.front;
    const prompt = document.createElement("span");
    prompt.className = "question-part question-prompt";
    prompt.textContent = question.prompt;
    const back = document.createElement("span");
    back.className = "question-part question-back";
    back.textContent = question.back;
    questionText.append(front, prompt, back);
    questionText.setAttribute("aria-label", `${question.front}${question.prompt}${question.back}`);
    fitQuestionText();
  }

  function fitQuestionText() {
    questionText.style.removeProperty("font-size");
    window.requestAnimationFrame(() => {
      const maxHeight = questionText.clientHeight;
      const maxWidth = questionText.clientWidth;
      if (!maxHeight || !maxWidth) {
        return;
      }

      let size = Number.parseFloat(getComputedStyle(questionText).fontSize) || 22;
      let attempts = 0;
      while (
        attempts < 12 &&
        (questionText.scrollHeight > maxHeight + 1 || questionText.scrollWidth > maxWidth + 1) &&
        size > 12
      ) {
        size -= 1;
        questionText.style.fontSize = `${size}px`;
        attempts += 1;
      }
    });
  }

  function renderProgress() {
    const total = Math.max(1, state.session.length);
    const current = Math.min(total, state.currentQuestionIndex + 1);
    const isFinalQuestion = state.currentQuestionIndex === total - 1;
    progressText.textContent = `${current} / ${total}`;
    progressBar.style.width = `${(current / total) * 100}%`;
    advanceButton.textContent = isFinalQuestion ? "回答" : "進む";
    advanceButton.classList.toggle("is-final-answer", isFinalQuestion);
    advanceButton.setAttribute(
      "aria-label",
      isFinalQuestion ? "回答して答え合わせへ進む" : "次の問題へ進む",
    );
  }

  function updateReviewMenu() {
    reviewMenu.replaceChildren();
    reviewMenu.style.setProperty("--review-count", String(Math.max(1, state.session.length)));
    state.session.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "review-item";
      if (index === state.currentQuestionIndex) {
        button.classList.add("is-current");
      }
      button.dataset.index = String(index);

      const number = document.createElement("span");
      number.className = "review-number";
      number.textContent = index === 9 ? "10（0）" : `${index + 1}`;
      const preview = document.createElement("span");
      preview.className = "review-preview";
      preview.textContent = `${item.question.front}${item.question.prompt}${item.question.back}`;
      const status = document.createElement("span");
      status.className = "review-status";
      status.textContent = item.slots.some((record) => record.text) ? "入力済み" : "—";
      button.append(number, preview, status);
      reviewMenu.append(button);
    });
  }

  function setReviewMenuOpen(isOpen) {
    reviewMenu.hidden = !isOpen;
    reviewButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }

  function goToProblem(index, { recognizeIfNeeded = true } = {}) {
    if (!state.session[index]) {
      return;
    }

    saveCurrentSessionState();
    state.currentQuestionIndex = index;
    const item = state.session[index];
    state.slots = item.slots;
    state.slotMode = item.slots.length;
    state.activeSlotIndex = Math.max(0, Math.min(item.slots.length - 1, item.activeSlotIndex || 0));
    refreshActiveStrokesReference();
    renderQuestionText(item.question);
    renderProgress();
    updateReviewMenu();
    activateCurrentInput({ recognizeIfNeeded });
    setReviewMenuOpen(false);
  }

  function clearResultTimers() {
    state.resultTimers.forEach((timer) => window.clearTimeout(timer));
    state.resultTimers.length = 0;
  }

  function startSession() {
    clearResultTimers();
    if (state.questions.length === 0) {
      questionText.textContent = "問題データが同梱されていません。";
      return;
    }

    const selected = selectSessionQuestions(state.questions);
    state.session = selected.map(createSessionItem);
    state.currentQuestionIndex = 0;
    state.resultsCommitted = false;
    learningScreen.hidden = false;
    resultScreen.hidden = true;
    retryButton.hidden = true;
    scoreSummary.className = "score-summary";
    resultList.replaceChildren();
    goToProblem(0, { recognizeIfNeeded: false });
    setResult(state.nativeRecognizer === null ? messages.loading : messages.empty, "message");
    scheduleLayoutFit();
  }

  function handleAdvance() {
    saveCurrentSessionState();
    if (state.currentQuestionIndex < state.session.length - 1) {
      goToProblem(state.currentQuestionIndex + 1);
      return;
    }
    showResults();
  }

  function commitSessionStats() {
    if (state.resultsCommitted) {
      return;
    }

    state.session.forEach((item) => {
      item.answerText = getItemAnswer(item);
      item.isCorrect = normalizeComparableText(item.answerText) === normalizeComparableText(item.question.answer);
      item.question.totalAttempts += 1;
      if (item.isCorrect) {
        item.question.correctCount += 1;
      }
      state.stats[item.question.key] = {
        totalAttempts: item.question.totalAttempts,
        correctCount: item.question.correctCount,
      };
    });

    state.resultsCommitted = true;
    try {
      localStorage.setItem(STORAGE_KEYS.stats, JSON.stringify(state.stats));
    } catch {
      // Storage may be unavailable; the current session still works.
    }
  }

  function appendSentenceParts(container, question, answerText) {
    const front = document.createTextNode(question.front);
    const answer = document.createElement("span");
    const hasAnswer = Boolean(String(answerText || "").trim());
    answer.className = `result-answer-part${hasAnswer ? "" : " is-unanswered"}`;
    answer.textContent = hasAnswer ? answerText : " ";
    if (!hasAnswer) {
      answer.setAttribute("aria-label", "未回答");
    }
    const back = document.createTextNode(question.back);
    container.append(front, answer, back);
  }

  function createResultRow(item, index) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `result-row ${item.isCorrect ? "is-correct" : "is-incorrect"}`;
    row.dataset.index = String(index);
    row.setAttribute("aria-label", `${index + 1}問目。${item.isCorrect ? "正解" : "不正解"}。クリックで解説。`);

    const sentence = document.createElement("span");
    sentence.className = "result-sentence";
    appendSentenceParts(sentence, item.question, item.answerText);
    const judgement = document.createElement("span");
    judgement.className = "result-judgement";
    judgement.textContent = item.isCorrect ? "○" : "×";
    row.append(sentence, judgement);
    return row;
  }

  function showResults() {
    window.clearTimeout(state.recognitionTimer);
    state.recognitionSerial += 1;
    setBusy(false);
    saveCurrentSessionState();
    commitSessionStats();
    clearResultTimers();
    learningScreen.hidden = true;
    resultScreen.hidden = false;
    scheduleLayoutFit();
    resultList.replaceChildren();
    scoreSummary.replaceChildren();
    scoreSummary.className = "score-summary";
    retryButton.hidden = true;

    state.session.forEach((item, index) => {
      const row = createResultRow(item, index);
      resultList.append(row);
      const revealTimer = window.setTimeout(() => {
        row.classList.add("is-visible");
        const judgeTimer = window.setTimeout(() => row.classList.add("is-judged"), 120);
        state.resultTimers.push(judgeTimer);
      }, 100 + index * RESULT_REVEAL_INTERVAL_MS);
      state.resultTimers.push(revealTimer);
    });

    const summaryDelay = 180 + state.session.length * RESULT_REVEAL_INTERVAL_MS;
    const summaryTimer = window.setTimeout(() => {
      const correctCount = state.session.filter((item) => item.isCorrect).length;
      const lead = document.createElement("span");
      lead.textContent = `${state.session.length}問中`;
      const number = document.createElement("strong");
      number.className = "score-number";
      if (correctCount === state.session.length) {
        number.classList.add("is-perfect");
      }
      number.textContent = String(correctCount);
      const tail = document.createElement("span");
      tail.textContent = "問正解";
      scoreSummary.append(lead, number, tail);
      scoreSummary.classList.add("is-visible");
      retryButton.hidden = false;
      retryButton.focus({ preventScroll: true });
    }, summaryDelay);
    state.resultTimers.push(summaryTimer);
  }

  function openExplanation(index) {
    const item = state.session[index];
    if (!item) {
      return;
    }
    explanationTitle.textContent = `正解：${item.question.answer}`;
    explanationText.textContent = item.question.explanation;
    explanationOverlay.hidden = false;
  }

  function closeExplanation() {
    explanationOverlay.hidden = true;
  }

  function applySettings(nextSettings = state.settings) {
    state.settings = {
      layout: ["horizontal", "vertical-wide", "vertical-portable"].includes(nextSettings.layout)
        ? nextSettings.layout
        : "horizontal",
      handedness: nextSettings.handedness === "left" ? "left" : "right",
    };
    app.dataset.layout = state.settings.layout;
    app.dataset.handedness = state.settings.handedness;
    layoutSelect.value = state.settings.layout;
    document.querySelectorAll('input[name="handedness"]').forEach((radio) => {
      radio.checked = radio.value === state.settings.handedness;
    });
    try {
      localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
    } catch {
      // Keep the in-memory setting when storage is unavailable.
    }
    scheduleLayoutFit();
  }

  function setSettingsOpen(isOpen) {
    settingsOverlay.hidden = !isOpen;
    if (isOpen) {
      settingsCloseButton.focus({ preventScroll: true });
    } else {
      settingsButton.focus({ preventScroll: true });
    }
  }

  async function init() {
    const title = String(quizPackage.title || "DigiCanji").trim() || "DigiCanji";
    document.title = title;
    appTitle.textContent = title;
    state.questions = embeddedQuestionRows
      .map((row, index) => createQuestion(row, index))
      .filter(Boolean);

    applySettings(initialSettings);
    startSession();
    state.nativeRecognizer = await createNativeRecognizer();
    updateActionButtons();
    setBusy(false);
    const record = getActiveInputRecord();
    if (!record.text && record.strokes.length === 0) {
      setResult(messages.empty, "message");
    }
    scheduleLayoutFit();
  }

  function preventCanvasGesture(event) {
    event.preventDefault();
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
  }

  function handleKeyboardReviewToggle() {
    setReviewMenuOpen(reviewMenu.hidden);
    if (!reviewMenu.hidden) {
      const currentItem = reviewMenu.querySelector(`.review-item[data-index="${state.currentQuestionIndex}"]`);
      currentItem?.focus?.({ preventScroll: true });
    }
  }

  function getQuestionIndexFromNumberKey(key) {
    if (!/^[0-9]$/.test(key)) {
      return -1;
    }
    return key === "0" ? 9 : Number(key) - 1;
  }

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      if (!explanationOverlay.hidden) {
        closeExplanation();
      } else if (!settingsOverlay.hidden) {
        setSettingsOpen(false);
      } else if (!reviewMenu.hidden) {
        setReviewMenuOpen(false);
      }
      return;
    }

    if (event.isComposing || isEditableTarget(event.target)) {
      return;
    }

    if (learningScreen.hidden || !explanationOverlay.hidden || !settingsOverlay.hidden) {
      return;
    }

    const questionIndex = getQuestionIndexFromNumberKey(event.key);
    if (questionIndex >= 0 && questionIndex < state.session.length) {
      event.preventDefault();
      goToProblem(questionIndex);
      return;
    }

    if (event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoLastStroke();
      return;
    }

    if (!isVerticalLayout()) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        moveSlot(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        handleKeyboardReviewToggle();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setReviewMenuOpen(false);
        handleAdvance();
      }
      return;
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      moveSlot(event.key === "ArrowUp" ? -1 : 1);
      return;
    }

    const advanceKey = state.settings.handedness === "left" ? "ArrowRight" : "ArrowLeft";
    const reviewKey = state.settings.handedness === "left" ? "ArrowLeft" : "ArrowRight";

    if (event.key === advanceKey) {
      event.preventDefault();
      setReviewMenuOpen(false);
      handleAdvance();
      return;
    }

    if (event.key === reviewKey) {
      event.preventDefault();
      handleKeyboardReviewToggle();
    }
  }

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    prepareStroke(event);
  });
  canvas.addEventListener("pointermove", continueStroke);
  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);
  canvas.addEventListener("dblclick", preventCanvasGesture);
  canvas.addEventListener("contextmenu", preventCanvasGesture);
  canvas.addEventListener("selectstart", preventCanvasGesture);
  canvas.addEventListener("dragstart", preventCanvasGesture);
  ["touchstart", "touchmove", "touchend", "touchcancel"].forEach((type) => {
    canvas.addEventListener(type, preventCanvasGesture, { passive: false });
  });

  undoButton.addEventListener("click", undoLastStroke);
  clearButton.addEventListener("click", clearPad);
  advanceButton.addEventListener("click", handleAdvance);
  resultBox.addEventListener("click", (event) => {
    const slot = event.target.closest(".character-slot");
    if (!slot) {
      return;
    }
    const index = Number(slot.dataset.index);
    if (Number.isInteger(index)) {
      const delta = index - state.activeSlotIndex;
      moveSlot(delta);
    }
  });

  reviewButton.addEventListener("click", () => setReviewMenuOpen(reviewMenu.hidden));
  reviewMenu.addEventListener("click", (event) => {
    const item = event.target.closest(".review-item");
    if (!item) {
      return;
    }
    goToProblem(Number(item.dataset.index));
  });

  settingsButton.addEventListener("click", () => setSettingsOpen(true));
  settingsCloseButton.addEventListener("click", () => setSettingsOpen(false));
  settingsOverlay.addEventListener("click", (event) => {
    if (event.target === settingsOverlay) {
      setSettingsOpen(false);
    }
  });
  layoutSelect.addEventListener("change", () => {
    applySettings({ ...state.settings, layout: layoutSelect.value });
  });
  document.querySelectorAll('input[name="handedness"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        applySettings({ ...state.settings, handedness: radio.value });
      }
    });
  });

  clearStatsButton.addEventListener("click", () => {
    if (!window.confirm("累計出題回数と正解数を消去しますか？")) {
      return;
    }
    state.stats = {};
    state.questions.forEach((question) => {
      question.totalAttempts = 0;
      question.correctCount = 0;
    });
    try {
      localStorage.removeItem(STORAGE_KEYS.stats);
    } catch {
      // Ignore storage failures.
    }
    setSettingsOpen(false);
    startSession();
  });

  resultList.addEventListener("click", (event) => {
    const row = event.target.closest(".result-row");
    if (row) {
      openExplanation(Number(row.dataset.index));
    }
  });
  explanationOverlay.addEventListener("click", closeExplanation);
  retryButton.addEventListener("click", startSession);
  document.addEventListener("pointerdown", (event) => {
    if (!reviewMenu.hidden && !event.target.closest(".review-control")) {
      setReviewMenuOpen(false);
    }
  });
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("resize", scheduleLayoutFit);
  window.addEventListener("pagehide", () => {
    state.nativeRecognizer?.finish?.();
  });

  new ResizeObserver(scheduleLayoutFit).observe(screenShell);
  init();
})();
