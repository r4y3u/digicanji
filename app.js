(() => {
  "use strict";

  const canvas = document.querySelector("#handwriting-pad");
  const resultBox = document.querySelector("#recognized-text");
  const clearButton = document.querySelector("#clear-button");
  const context = canvas.getContext("2d");
  const strokeCounts = window.JP_STROKE_COUNTS || {};

  const LANGUAGE_CANDIDATES = [{ languages: ["ja"] }, { languages: ["ja-JP"] }];
  const SUPPORTED_POINTER_TYPES = new Set(["mouse", "touch", "stylus"]);
  const LINE_WIDTH = 10;
  const RECOGNITION_DRAW_DELAY_MS = 140;
  const RECOGNITION_FINISH_DELAY_MS = 70;
  const RECOGNITION_RETRY_DELAY_MS = 120;
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
      const text = String(candidate || "").trim();

      if (!text || seen.has(text)) {
        continue;
      }

      seen.add(text);
      normalized.push(text);
    }

    return normalized;
  }

  function getCandidateStrokeCount(text) {
    let total = 0;

    for (const char of Array.from(text)) {
      const count = strokeCounts[char];

      if (!Number.isFinite(count)) {
        return null;
      }

      total += count;
    }

    return total || null;
  }

  function isKanaOnly(text) {
    return /^[\u3040-\u30ffー]+$/u.test(text);
  }

  function getStrokeTolerance(expectedCount, text) {
    if (isKanaOnly(text)) {
      return 1;
    }

    if (expectedCount >= 12) {
      return 1;
    }

    return expectedCount >= 6 ? 1 : 0;
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

  function estimateInputStrokeCount() {
    const guide = getCanvasGuide();
    const rawCount = state.strokes.filter((stroke) => stroke.length > 1).length;
    const virtualCount = state.strokes.reduce((total, stroke) => {
      return total + estimateSegmentsInStroke(stroke, guide);
    }, 0);

    return Math.max(rawCount, virtualCount);
  }

  function isStrokeCompatible(text, estimatedCount) {
    const expectedCount = getCandidateStrokeCount(text);

    if (!expectedCount) {
      return true;
    }

    const tolerance = getStrokeTolerance(expectedCount, text);
    return estimatedCount + tolerance >= expectedCount;
  }

  function selectDisplayCandidate(candidates) {
    const normalized = normalizeCandidates(candidates);

    if (normalized.length === 0) {
      return "";
    }

    const japaneseCandidates = normalized.filter((text) =>
      /[\u3040-\u30ff\u3400-\u9fff]/u.test(text),
    );
    const orderedCandidates =
      japaneseCandidates.length > 0 ? japaneseCandidates : normalized;
    const estimatedCount = estimateInputStrokeCount();

    return (
      orderedCandidates.find((text) => isStrokeCompatible(text, estimatedCount)) ||
      ""
    );
  }

  function startStroke(event) {
    canvas.dataset.lastPointerType = event.pointerType || "";
    window.clearTimeout(state.recognitionTimer);
    state.recognitionSerial += 1;
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
    scheduleRecognition(RECOGNITION_DRAW_DELAY_MS);
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
    scheduleRecognition(RECOGNITION_DRAW_DELAY_MS);
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
    scheduleRecognition(RECOGNITION_FINISH_DELAY_MS);
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
      const nativeCandidates = await recognizeWithNative();
      let text = selectDisplayCandidate(nativeCandidates);

      if (!text) {
        text = selectDisplayCandidate(await recognizeWithGoogle());
      }

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

      if (serial !== state.recognitionSerial) {
        return;
      }

      if (state.needsRecognition) {
        state.needsRecognition = false;
        scheduleRecognition(RECOGNITION_RETRY_DELAY_MS);
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
