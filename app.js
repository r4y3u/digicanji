(() => {
  "use strict";

  const canvas = document.querySelector("#handwriting-pad");
  const resultBox = document.querySelector("#recognized-text");
  const clearButton = document.querySelector("#clear-button");
  const context = canvas.getContext("2d");

  const LANGUAGE_CANDIDATES = [{ languages: ["ja"] }, { languages: ["ja-JP"] }];
  const SUPPORTED_POINTER_TYPES = new Set(["mouse", "touch", "stylus"]);
  const LINE_WIDTH = 10;
  const GOOGLE_HANDWRITING_URLS = [
    "https://www.google.com/inputtools/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8",
    "https://inputtools.google.com/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8",
  ];

  const state = {
    nativeRecognizer: null,
    nativeDrawing: null,
    activePointerId: null,
    activeStrokePoints: null,
    lastPoint: null,
    strokeStartTime: 0,
    strokes: [],
    recognitionTimer: 0,
    recognitionSerial: 0,
    isRecognizing: false,
    needsRecognition: false,
    nativeFailed: false,
    googleFailed: false,
  };

  const messages = {
    loading: "準備中...",
    empty: "手書きしてください",
    noCandidate: "候補なし",
    networkUnavailable: "描画はできますが、認識に接続できません",
  };

  function setResult(text, stateName = "result") {
    resultBox.textContent = text;
    resultBox.dataset.state = stateName === "result" ? "" : "message";
  }

  function setBusy(isBusy) {
    resultBox.dataset.busy = isBusy ? "true" : "false";
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;

    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawAllStrokes();
  }

  function clearCanvas() {
    const rect = canvas.getBoundingClientRect();
    context.clearRect(0, 0, rect.width, rect.height);
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
    context.strokeStyle = "#111827";
    context.fillStyle = "#111827";
    context.lineWidth = LINE_WIDTH;

    if (!previousPoint) {
      context.beginPath();
      context.arc(point.x, point.y, LINE_WIDTH / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }

    context.beginPath();
    context.moveTo(previousPoint.x, previousPoint.y);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function getCanvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);

    return {
      x,
      y,
      t: Math.round(performance.now() - state.strokeStartTime),
    };
  }

  function hasInk() {
    return state.strokes.some((stroke) => stroke.length > 1);
  }

  function getCanvasGuide() {
    const rect = canvas.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
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
        recognitionType: "per-character",
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
      return "";
    }

    try {
      const predictions = await drawing.getPrediction();
      return predictions?.[0]?.text?.trim() || "";
    } catch {
      state.nativeFailed = true;
      state.nativeDrawing = null;
      return "";
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

  function extractCandidateFromGoogleResponse(data) {
    if (!Array.isArray(data) || data[0] !== "SUCCESS") {
      return "";
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

    return (
      candidates.find((text) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(text)) ||
      candidates[0] ||
      ""
    );
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
          const text = extractCandidateFromGoogleResponse(data);

          if (text) {
            state.googleFailed = false;
            return text;
          }
        } catch {
          // Try the next endpoint/content-type pair.
        }
      }
    }

    state.googleFailed = true;
    return "";
  }

  function startStroke(event) {
    canvas.dataset.lastPointerType = event.pointerType || "";
    state.strokeStartTime = performance.now();
    state.activePointerId = event.pointerId;
    state.activeStrokePoints = [];
    state.lastPoint = null;
    state.strokes.push(state.activeStrokePoints);

    if (typeof canvas.setPointerCapture === "function") {
      canvas.setPointerCapture(event.pointerId);
    }

    addPoint(event);
    setBusy(true);
    scheduleRecognition(420);
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
    if (event.pointerId !== state.activePointerId || !state.activeStrokePoints) {
      return;
    }

    event.preventDefault();

    const events =
      typeof event.getCoalescedEvents === "function"
        ? event.getCoalescedEvents()
        : [event];

    events.forEach(addPoint);
    scheduleRecognition(360);
  }

  function finishStroke(event) {
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
    scheduleRecognition(120);
  }

  function scheduleRecognition(delay) {
    if (!hasInk()) {
      return;
    }

    setBusy(true);
    window.clearTimeout(state.recognitionTimer);
    state.recognitionTimer = window.setTimeout(runRecognition, delay);
  }

  async function runRecognition() {
    if (!hasInk()) {
      return;
    }

    if (state.isRecognizing) {
      state.needsRecognition = true;
      return;
    }

    state.isRecognizing = true;
    const serial = ++state.recognitionSerial;

    try {
      const nativeText = await recognizeWithNative();
      const text = nativeText || (await recognizeWithGoogle());

      if (serial !== state.recognitionSerial || !hasInk()) {
        return;
      }

      if (text) {
        setResult(text, "result");
      } else {
        setResult(
          state.googleFailed ? messages.networkUnavailable : messages.noCandidate,
          "message",
        );
      }
    } finally {
      state.isRecognizing = false;

      if (state.needsRecognition) {
        state.needsRecognition = false;
        scheduleRecognition(160);
      } else {
        setBusy(false);
      }
    }
  }

  function clearPad() {
    window.clearTimeout(state.recognitionTimer);
    state.recognitionSerial += 1;
    state.activePointerId = null;
    state.activeStrokePoints = null;
    state.lastPoint = null;
    state.strokes = [];

    if (state.nativeDrawing) {
      state.nativeDrawing.clear();
      state.nativeDrawing = null;
    }

    clearCanvas();
    setBusy(false);
    setResult(messages.empty, "message");
  }

  async function init() {
    setResult(messages.loading, "message");
    resizeCanvas();
    state.nativeRecognizer = await createNativeRecognizer();
    setBusy(false);
    setResult(messages.empty, "message");
  }

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    startStroke(event);
  });
  canvas.addEventListener("pointermove", continueStroke);
  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);
  clearButton.addEventListener("click", clearPad);

  window.addEventListener("pagehide", () => {
    state.nativeRecognizer?.finish?.();
  });

  new ResizeObserver(resizeCanvas).observe(canvas);
  init();
})();
