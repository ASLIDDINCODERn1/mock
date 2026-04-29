import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAnalytics, isSupported as isAnalyticsSupported } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-analytics.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
  getDatabase,
  onDisconnect,
  onValue,
  ref,
  runTransaction,
  set,
  get,
  update
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-database.js";

const viewMeta = {
  dashboard: ["Mock exam", "Dashboard"],
  grammar: ["Section 1", "Grammar Test"],
  reading: ["Section 2", "Reading"],
  writing: ["Section 3", "Writing"],
  speaking: ["Section 4", "Speaking"]
};

const state = {
  auth: null,
  database: null,
  currentUser: null,
  guestMode: false,
  scores: { grammar: null, reading: null, writing: null, speaking: null },
  timers: { grammar: 900, reading: 1200, writing: 1800, speaking: 120 },
  _adminConfigWatcher: null,
  _lockWatcher: null,
  _timerInterval: null,
  _timerSection: null,
  sessionId: null,
  sessionRef: null,
  sessionWatcher: null,
  sessionHeartbeat: null,
  sessionSignOutInProgress: false,
  recording: false,
  recordStartedAt: null,
  recordInterval: null,
  antiCheat: {
    screenshotAttempts: 0,
    lastVisibilityFlagAt: 0,
    lastExitFlagAt: 0,
    exitAttempts: 0,
    lastAlertAt: 0,
    leaderboardAlertSent: false,
    blackoutTimer: null
  },
  speechRecognition: null,
  speakingTranscriptFinal: "",
  writing: {
    title: "",
    prompt: ""
  },
  reading: {
    title: "",
    passage: "",
    questions: []
  },
  grammar: [],
  speaking: {
    title: "",
    prompt: "",
    points: []
  }
};

const SESSION_TIMEOUT_MS = 90 * 1000;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

document.addEventListener("DOMContentLoaded", init);

async function init() {
  initTheme();
  bindNavigation();
  bindAuthForm();
  bindProfileDrawer();
  bindExamActions();
  bindAntiCheat();
  renderAll();
  await setupFirebaseAuth();
  $("#demoButton").addEventListener("click", enterGuestMode);
  $("#lockedSignOutButton").addEventListener("click", async () => {
    $("#examLockedScreen").hidden = true;
    if (state.auth) await signOutCurrentUser();
    else enterAuth();
  });
}

function bindNavigation() {
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-view]");
    if (!trigger) return;
    showView(trigger.dataset.view);
    closeMobileSidebar();
  });
}

function bindAuthForm() {
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.auth) return;

    const email = $("#emailInput").value.trim();
    const password = $("#passwordInput").value;
    const button = $("#loginButton");

    $("#authError").textContent = "";
    button.disabled = true;
    button.textContent = "Logging in...";

    try {
      await signInWithEmailAndPassword(state.auth, email, password);
    } catch (error) {
      $("#authError").textContent = authMessage(error);
    } finally {
      button.disabled = false;
      button.textContent = "Log in";
    }
  });

  $("#signOutButton").addEventListener("click", async () => {
    if (state.guestMode) {
      enterAuth();
      return;
    }
    if (!state.auth) return;
    await signOutCurrentUser();
  });
}

function bindProfileDrawer() {
  $("#profileButton").addEventListener("click", openProfileDrawer);
  $("#closeDrawerButton").addEventListener("click", closeProfileDrawer);
  $("#drawerBackdrop").addEventListener("click", closeProfileDrawer);
  $("#themeToggleBtn").addEventListener("click", toggleTheme);
  $("#mobileMenuButton").addEventListener("click", openMobileSidebar);
  $("#sidebarBackdrop").addEventListener("click", closeMobileSidebar);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeProfileDrawer(); closeMobileSidebar(); }
  });
}

function openMobileSidebar() {
  const sidebar = document.querySelector(".sidebar");
  const backdrop = $("#sidebarBackdrop");
  sidebar.classList.add("open");
  backdrop.hidden = false;
  requestAnimationFrame(() => backdrop.classList.add("open"));
  $("#mobileMenuButton").setAttribute("aria-expanded", "true");
}

function closeMobileSidebar() {
  const sidebar = document.querySelector(".sidebar");
  const backdrop = $("#sidebarBackdrop");
  sidebar.classList.remove("open");
  backdrop.classList.remove("open");
  $("#mobileMenuButton").setAttribute("aria-expanded", "false");
  setTimeout(() => {
    if (!backdrop.classList.contains("open")) backdrop.hidden = true;
  }, 240);
}

function bindExamActions() {
  $("#submitGrammarButton").addEventListener("click", submitGrammar);
  $("#resetGrammarButton").addEventListener("click", resetGrammar);
  $("#submitReadingButton").addEventListener("click", submitReading);
  $("#resetReadingButton").addEventListener("click", resetReading);
  $("#writingText").addEventListener("input", updateWordCount);
  $("#clearWritingButton").addEventListener("click", clearWriting);
  $("#submitWritingButton").addEventListener("click", submitWriting);
  $("#resetSpeakingButton").addEventListener("click", resetSpeaking);
  $("#submitSpeakingButton").addEventListener("click", submitSpeaking);
}

function bindAntiCheat() {
  document.addEventListener("keydown", (event) => {
    if (!isExamViewActive()) {
      return;
    }

    const key = event.key.toLowerCase();
    const blockedCombo =
      (event.ctrlKey || event.metaKey) &&
      ["c", "x", "v", "a", "p", "s", "u"].includes(key);
    const blockedFunctionKey = event.key === "PrintScreen" || event.key === "F12";

    if (blockedCombo || blockedFunctionKey) {
      event.preventDefault();
      if (blockedFunctionKey) {
        activateBlackout(2000);
      }
    }

    if (event.key === "PrintScreen") {
      void registerScreenshotAttempt("printscreen");
    }
  });

  const blockActionInExam = (event, source) => {
    if (!isExamViewActive()) return;
    event.preventDefault();
    if (source) {
      void saveAntiCheatEvent(source, state.antiCheat.screenshotAttempts);
      showCheatingAlert("Blocked action detected. This behavior is reported.");
    }
  };

  document.addEventListener("copy", (event) => blockActionInExam(event, "copy_blocked"));
  document.addEventListener("cut", (event) => blockActionInExam(event, "cut_blocked"));
  document.addEventListener("paste", (event) => blockActionInExam(event, "paste_blocked"));
  document.addEventListener("contextmenu", (event) => blockActionInExam(event, "contextmenu_blocked"));

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden || !isExamViewActive()) {
      return;
    }

    const now = Date.now();
    if (now - state.antiCheat.lastVisibilityFlagAt < 4000) {
      return;
    }

    state.antiCheat.lastVisibilityFlagAt = now;
    activateBlackout(2500);
    void registerScreenshotAttempt("visibility_hidden");
    void registerExitAttempt("tab_switch");
    showCheatingAlert("You left the exam screen. Cheating alert sent to admin.");
  });

  window.addEventListener("blur", () => {
    if (!isExamViewActive()) return;
    activateBlackout(1800);
    showCheatingAlert("Focus changed from exam screen. This is flagged.");
  });

  window.addEventListener("pagehide", () => {
    if (!isExamViewActive()) return;
    void registerExitAttempt("pagehide");
    showCheatingAlert("Exam page was hidden. Cheating alert sent.");
  });

  window.addEventListener("beforeunload", () => {
    if (!isExamViewActive() || !state.database || !state.currentUser) return;
    const uid = state.currentUser.uid;
    const now = Date.now();
    const updates = {
      [`userResults/${uid}/antiCheat/lastExitSource`]: "beforeunload",
      [`userResults/${uid}/antiCheat/lastExitAt`]: now,
      [`userResults/${uid}/antiCheat/leaderboardAlert`]: true,
      [`userResults/${uid}/antiCheat/leaderboardAlertAt`]: now
    };
    update(ref(state.database), updates).catch(() => {});
  });

  document.addEventListener("touchstart", (event) => {
    if (!isExamViewActive()) return;
    if (event.touches.length >= 3) {
      activateBlackout(2200);
      void registerScreenshotAttempt("multi_touch_gesture");
      showCheatingAlert("Suspicious touch gesture detected. Alert sent.");
    }
  }, { passive: true });

  document.addEventListener("selectionchange", () => {
    if (!isExamViewActive()) return;
    const selected = String(window.getSelection?.() || "").trim();
    if (selected.length > 18) {
      void saveAntiCheatEvent("selection_detected", state.antiCheat.screenshotAttempts);
    }
  });
}

const firebaseConfig = {
  apiKey: "AIzaSyBSg3-LBL4bQb9ilbL271Zo8Y3lRDKXg2w",
  authDomain: "shop-c1c78.firebaseapp.com",
  databaseURL: "https://shop-c1c78-default-rtdb.firebaseio.com",
  projectId: "shop-c1c78",
  storageBucket: "shop-c1c78.appspot.com",
  messagingSenderId: "343732239769",
  appId: "1:343732239769:web:dd829d3bec92d598552708",
  measurementId: "G-BF67MVZEN7"
};

async function setupFirebaseAuth() {
  try {
    const app = initializeApp(firebaseConfig);
    isAnalyticsSupported()
      .then((supported) => { if (supported) getAnalytics(app); })
      .catch(() => {});

    state.auth = getAuth(app);
    state.database = firebaseConfig.databaseURL ? getDatabase(app) : null;

    onAuthStateChanged(state.auth, async (user) => {
      if (!user) {
        await releaseSessionLock(true);
        enterAuth();
        return;
      }

      try {
        const acquired = await acquireSessionLock(user);
        if (!acquired) {
          await releaseSessionLock(false);
          await signOut(state.auth);
          enterAuth();
          $("#authError").textContent = "This account is already active in another browser.";
          return;
        }

        await enterApp(user);
      } catch (error) {
        await releaseSessionLock(false);
        await signOut(state.auth);
        enterAuth();
        $("#authError").textContent =
          "Could not verify single-session access. Check Firebase Realtime Database rules.";
      }
    });
  } catch (error) {
    enterAuth();
    $("#loginButton").disabled = true;
    $("#configNotice").hidden = false;
    $("#configNotice").textContent = "Firebase failed to initialize. Check your config and try again.";
  }
}

function enterAuth() {
  state.currentUser = null;
  state.guestMode = false;
  closeProfileDrawer();
  $("#authScreen").hidden = false;
  $("#appShell").hidden = true;
}

async function enterApp(user) {
  state.currentUser = user;
  state.antiCheat.screenshotAttempts = 0;
  state.antiCheat.leaderboardAlertSent = false;
  $("#authScreen").hidden = true;
  $("#appShell").hidden = false;
  $("#userInitials").textContent = initials(user.email || "User");
  $("#drawerInitials").textContent = initials(user.email || "User");
  $("#drawerEmail").textContent = user.email || "Firebase user";
  $("#sessionStatus").textContent = "Active on this device only";
  await saveUserProfileForLeaderboard();
  await loadAdminConfig();
  await loadRemoteScores();
  showView("dashboard");
}

async function saveUserProfileForLeaderboard() {
  if (!state.database || !state.currentUser) return;
  const uid = state.currentUser.uid;
  try {
    await update(ref(state.database), {
      [`userResults/${uid}/email`]: state.currentUser.email || "",
      [`userResults/${uid}/lastActive`]: Date.now()
    });
  } catch (error) {
    console.warn("Could not save user profile for leaderboard:", error);
  }
}

async function loadAdminConfig() {
  if (!state.database) return;
  startAdminConfigWatcher();
}

function startAdminConfigWatcher() {
  if (!state.database || state._adminConfigWatcher) return;
  state._adminConfigWatcher = onValue(ref(state.database, "adminConfig"), (snap) => {
    applyAdminConfig(snap.val() || {});
  }, (error) => {
    console.warn("Could not watch admin config:", error);
  });
}

function applyAdminConfig(cfg) {
  const toArray = (v) => v ? (Array.isArray(v) ? v : Object.values(v)) : [];

  state.grammar = toArray(cfg.grammar?.questions);
  state.reading = {
    title: cfg.reading?.title || "",
    passage: cfg.reading?.passage || "",
    questions: toArray(cfg.reading?.questions)
  };
  state.writing = {
    title: cfg.writing?.title || "",
    prompt: cfg.writing?.prompt || ""
  };
  state.speaking = {
    title: cfg.speaking?.title || "",
    prompt: cfg.speaking?.prompt || "",
    points: toArray(cfg.speaking?.points)
  };

  const sharedTimer = Number(cfg.examTimer);
  state.timers.grammar = Number.isFinite(sharedTimer) && sharedTimer > 0 ? sharedTimer : 900;
  state.timers.reading = Number.isFinite(sharedTimer) && sharedTimer > 0 ? sharedTimer : 1200;
  state.timers.writing = Number.isFinite(sharedTimer) && sharedTimer > 0 ? sharedTimer : 1800;

  const speakingTimer = Number(cfg.speakingTimer);
  state.timers.speaking = Number.isFinite(speakingTimer) && speakingTimer > 0 ? speakingTimer : 0;

  if (cfg.examLocked === true) {
    showExamLocked();
  } else {
    hideExamLocked();
  }

  renderAll();
  if (state._timerSection) {
    startSectionTimer(state._timerSection);
  }
}

function startExamLockWatcher() {
  if (!state.database || state._lockWatcher) return;
  state._lockWatcher = onValue(ref(state.database, "adminConfig/examLocked"), (snap) => {
    if (state.guestMode) return;
    if (snap.val() === true) {
      showExamLocked();
    } else {
      hideExamLocked();
    }
  });
}

function showExamLocked() {
  $("#appShell").hidden = true;
  $("#examLockedScreen").hidden = false;
  stopSectionTimer();
}

function hideExamLocked() {
  if ($("#examLockedScreen").hidden) return;
  $("#examLockedScreen").hidden = true;
  $("#appShell").hidden = false;
}

function bindOptionButtons() {
  document.querySelectorAll(".opt-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const group = btn.dataset.group;
      document.querySelectorAll(`.opt-btn[data-group="${group}"]`).forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
    });
  });
}

function startSectionTimer(section) {
  stopSectionTimer();
  const pill = $(`#${section}View .timer-pill`);
  if (!pill) return;

  let remaining = state.timers[section] || 0;
  // Speaking with 0 timer = unlimited
  if (!remaining) {
    pill.textContent = "No limit";
    pill.classList.add("timer-unlimited");
    return;
  }
  pill.classList.remove("timer-unlimited");

  state._timerSection = section;
  pill.textContent = formatTime(remaining);
  pill.classList.remove("timer-warning", "timer-expired");

  state._timerInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      remaining = 0;
      pill.textContent = "00:00";
      pill.classList.add("timer-expired");
      stopSectionTimer();
      autoSubmit(section);
      return;
    }
    pill.textContent = formatTime(remaining);
    if (remaining <= 60) pill.classList.add("timer-warning");
  }, 1000);
}

function stopSectionTimer() {
  if (state._timerInterval) {
    clearInterval(state._timerInterval);
    state._timerInterval = null;
  }
  state._timerSection = null;
}

function formatTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function autoSubmit(section) {
  toast(`Time's up for ${section}! Submitting automatically.`, "error");
  if (section === "grammar")  submitGrammar();
  if (section === "reading")  submitReading();
  if (section === "writing")  submitWriting();
  if (section === "speaking") submitSpeaking();
}

async function saveUserResult(section, score, answers) {
  if (!state.database || !state.currentUser) return;
  const uid = state.currentUser.uid;
  const updates = {};
  updates[`userResults/${uid}/email`] = state.currentUser.email || "";
  updates[`userResults/${uid}/lastActive`] = Date.now();
  updates[`userResults/${uid}/scores/${section}`] = score;
  if (answers) updates[`userResults/${uid}/${section}Answers`] = answers;
  try {
    await update(ref(state.database), updates);
  } catch (err) {
    console.warn("Could not save result:", err);
  }
}

function isExamViewActive() {
  return ["grammar", "reading", "writing", "speaking"].some((section) =>
    $(`#${section}View`)?.classList.contains("active")
  );
}

async function registerScreenshotAttempt(source) {
  if (!isExamViewActive()) {
    return;
  }

  state.antiCheat.screenshotAttempts += 1;
  const attempt = state.antiCheat.screenshotAttempts;

  if (attempt >= 3) {
    showAntiCheatOverlay();
  }

  activateBlackout(1800);
  toast(`Screenshot attempt detected (${attempt}/3).`, "error");
  showCheatingAlert(`Screenshot/capture attempt detected (${attempt}/3).`);
  await saveAntiCheatEvent(source, attempt);
}

async function registerExitAttempt(source) {
  if (!isExamViewActive()) return;
  const now = Date.now();
  if (now - state.antiCheat.lastExitFlagAt < 3000) return;
  state.antiCheat.lastExitFlagAt = now;
  state.antiCheat.exitAttempts += 1;
  await saveAntiCheatEvent(source, state.antiCheat.screenshotAttempts, {
    exitAttempts: state.antiCheat.exitAttempts,
    leaderboardAlert: true
  });
}

async function saveAntiCheatEvent(source, attempt, extras = {}) {
  if (!state.database || !state.currentUser) return;

  const uid = state.currentUser.uid;
  const now = Date.now();
  const updates = {
    [`userResults/${uid}/antiCheat/screenshotAttempts`]: attempt,
    [`userResults/${uid}/antiCheat/lastSource`]: source,
    [`userResults/${uid}/antiCheat/lastDetectedAt`]: now
  };

  if (attempt >= 3 && !state.antiCheat.leaderboardAlertSent) {
    updates[`userResults/${uid}/antiCheat/leaderboardAlert`] = true;
    updates[`userResults/${uid}/antiCheat/leaderboardAlertAt`] = now;
    state.antiCheat.leaderboardAlertSent = true;
  }

  if (extras.exitAttempts) {
    updates[`userResults/${uid}/antiCheat/exitAttempts`] = extras.exitAttempts;
    updates[`userResults/${uid}/antiCheat/lastExitSource`] = source;
    updates[`userResults/${uid}/antiCheat/lastExitAt`] = now;
  }

  if (extras.leaderboardAlert) {
    updates[`userResults/${uid}/antiCheat/leaderboardAlert`] = true;
    updates[`userResults/${uid}/antiCheat/leaderboardAlertAt`] = now;
    state.antiCheat.leaderboardAlertSent = true;
  }

  try {
    await update(ref(state.database), updates);
  } catch (error) {
    console.warn("Could not save anti-cheat event:", error);
  }
}

function activateBlackout(durationMs = 1500) {
  const overlay = $("#antiCheatOverlay");
  if (!overlay) return;
  overlay.hidden = false;
  overlay.classList.add("show", "blackout");
  clearTimeout(state.antiCheat.blackoutTimer);
  state.antiCheat.blackoutTimer = setTimeout(() => {
    overlay.classList.remove("blackout");
    if (!overlay.classList.contains("show")) {
      overlay.hidden = true;
    }
  }, durationMs);
}

function showCheatingAlert(message) {
  const now = Date.now();
  if (now - state.antiCheat.lastAlertAt < 2000) return;
  state.antiCheat.lastAlertAt = now;
  toast(message, "error");
  // Explicit popup requested by admin for mobile users.
  window.alert(message);
}

function showAntiCheatOverlay() {
  const overlay = $("#antiCheatOverlay");
  if (!overlay) return;
  overlay.hidden = false;
  overlay.classList.add("show");
}

function hideAntiCheatOverlay() {
  const overlay = $("#antiCheatOverlay");
  if (!overlay) return;
  overlay.classList.remove("show");
  overlay.hidden = true;
}

function enterGuestMode() {
  state.currentUser = null;
  state.guestMode = true;
  state.antiCheat.screenshotAttempts = 0;
  state.antiCheat.leaderboardAlertSent = false;
  $("#authScreen").hidden = true;
  $("#appShell").hidden = false;
  $("#userInitials").textContent = "G";
  $("#drawerInitials").textContent = "G";
  $("#drawerEmail").textContent = "Guest (demo mode)";
  $("#sessionStatus").textContent = "Demo — not saved";
  showView("dashboard");
}

async function acquireSessionLock(user) {
  if (!state.database) {
    throw new Error("Realtime Database is required for single-session auth.");
  }

  if (state.currentUser?.uid === user.uid && state.sessionId && state.sessionRef) {
    return true;
  }

  await releaseSessionLock(false);

  const sessionId = getOrCreateSessionId();
  const sessionRef = ref(state.database, `activeSessions/${user.uid}`);
  const now = Date.now();
  const payload = {
    sessionId,
    email: user.email || "",
    startedAt: now,
    lastSeenAt: now
  };

  state.sessionId = sessionId;
  state.sessionRef = sessionRef;

  const transaction = await runTransaction(
    sessionRef,
    (current) => {
      const lastSeenAt = Number(current?.lastSeenAt || 0);
      const isStale = !lastSeenAt || now - lastSeenAt > SESSION_TIMEOUT_MS;

      if (!current || current.sessionId === sessionId || isStale) {
        return payload;
      }

      return;
    },
    { applyLocally: false }
  );

  if (!transaction.committed) {
    return false;
  }

  await onDisconnect(sessionRef).remove();

  state.sessionWatcher = onValue(sessionRef, (snapshot) => {
    const activeSession = snapshot.val();
    if (activeSession && activeSession.sessionId !== state.sessionId && state.currentUser) {
      forceSingleSessionSignOut();
    }
  });

  state.sessionHeartbeat = setInterval(() => {
    if (!state.sessionRef || !state.currentUser || !state.sessionId) return;
    set(state.sessionRef, {
      ...payload,
      sessionId: state.sessionId,
      lastSeenAt: Date.now()
    }).catch(() => {});
  }, 30 * 1000);

  return true;
}

async function releaseSessionLock(removeOwnSession) {
  const sessionRef = state.sessionRef;
  const sessionId = state.sessionId;

  stopSessionTracking();
  state.sessionRef = null;
  state.sessionId = null;

  if (!removeOwnSession || !sessionRef || !sessionId) return;

  clearStoredSessionId();
  try {
    await runTransaction(
      sessionRef,
      (current) => (current?.sessionId === sessionId ? null : current),
      { applyLocally: false }
    );
  } catch (error) {
    // The browser may already be disconnected; Firebase onDisconnect also cleans it up.
  }
}

function stopSessionTracking() {
  if (state.sessionWatcher) {
    state.sessionWatcher();
    state.sessionWatcher = null;
  }

  if (state.sessionHeartbeat) {
    clearInterval(state.sessionHeartbeat);
    state.sessionHeartbeat = null;
  }
}

async function forceSingleSessionSignOut() {
  if (state.sessionSignOutInProgress) return;
  state.sessionSignOutInProgress = true;

  await releaseSessionLock(false);
  toast("This account was opened in another browser, so this session was signed out.", "error");

  try {
    await signOut(state.auth);
  } finally {
    state.sessionSignOutInProgress = false;
    $("#authError").textContent = "This account is already active in another browser.";
  }
}

async function signOutCurrentUser() {
  await releaseSessionLock(true);
  closeProfileDrawer();
  await signOut(state.auth);
}

function createSessionId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getOrCreateSessionId() {
  const key = "mock-exam-sid";
  let id = localStorage.getItem(key);
  if (!id) {
    id = createSessionId();
    localStorage.setItem(key, id);
  }
  return id;
}

function clearStoredSessionId() {
  localStorage.removeItem("mock-exam-sid");
}

function initTheme() {
  const savedTheme = localStorage.getItem("mock-theme") || "light";
  setTheme(savedTheme);
}

function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(nextTheme);
}

function setTheme(theme) {
  if (theme === "dark") {
    document.documentElement.dataset.theme = "dark";
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  localStorage.setItem("mock-theme", theme);
}

function openProfileDrawer() {
  $("#drawerBackdrop").hidden = false;
  $("#profileDrawer").hidden = false;
  $("#drawerBackdrop").classList.add("open");
  $("#profileDrawer").classList.add("open");
  $("#profileDrawer").setAttribute("aria-hidden", "false");
  $("#profileButton").setAttribute("aria-expanded", "true");
}

function closeProfileDrawer() {
  const backdrop = $("#drawerBackdrop");
  const drawer = $("#profileDrawer");
  if (!backdrop || !drawer) return;

  backdrop.classList.remove("open");
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  $("#profileButton")?.setAttribute("aria-expanded", "false");
  setTimeout(() => {
    if (!backdrop.classList.contains("open")) backdrop.hidden = true;
    if (!drawer.classList.contains("open")) drawer.hidden = true;
  }, 220);
}

function showView(name) {
  const meta = viewMeta[name] || viewMeta.dashboard;

  $$(".view").forEach((view) => view.classList.remove("active"));
  $(`#${name}View`)?.classList.add("active");

  $$(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === name);
  });

  $("#pageEyebrow").textContent = meta[0];
  const titleEl = $("#pageTitle");
  titleEl.textContent = meta[1];
  if (state.guestMode) {
    titleEl.insertAdjacentHTML("beforeend", '<span class="guest-badge">Demo</span>');
  }

  // Start countdown timer for exam sections (not dashboard)
  const examSections = ["grammar", "reading", "writing", "speaking"];
  if (examSections.includes(name)) {
    startSectionTimer(name);
  } else {
    stopSectionTimer();
    hideAntiCheatOverlay();
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function loadScores() {
  try {
    const saved = localStorage.getItem("mock-exam-scores");
    if (saved) Object.assign(state.scores, JSON.parse(saved));
  } catch {}
}

function saveScore(section, score) {
  state.scores[section] = score;
  try { localStorage.setItem("mock-exam-scores", JSON.stringify(state.scores)); } catch {}
  renderDashboardStatus();
}

async function loadRemoteScores() {
  if (!state.database || !state.currentUser) {
    renderDashboardStatus();
    return;
  }

  try {
    const snap = await get(ref(state.database, `userResults/${state.currentUser.uid}/scores`));
    const savedScores = snap.val() || {};
    const sections = ["grammar", "reading", "writing", "speaking"];

    for (const section of sections) {
      const raw = savedScores[section];
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        state.scores[section] = Math.max(0, Math.min(100, Math.round(parsed)));
      }
    }

    try { localStorage.setItem("mock-exam-scores", JSON.stringify(state.scores)); } catch {}
  } catch (error) {
    console.warn("Could not load saved dashboard scores:", error);
  } finally {
    renderDashboardStatus();
  }
}

function renderDashboardStatus() {
  const el = $("#scoreList");
  if (!el) return;

  const sections = [
    { key: "grammar",  label: "Grammar",  icon: "G" },
    { key: "reading",  label: "Reading",  icon: "R" },
    { key: "writing",  label: "Writing",  icon: "W" },
    { key: "speaking", label: "Speaking", icon: "S" }
  ];

  const done = sections.filter(s => state.scores[s.key] !== null);
  const overall = done.length
    ? Math.round(done.reduce((sum, s) => sum + state.scores[s.key], 0) / done.length)
    : null;

  el.innerHTML = `
    ${overall !== null ? `
      <div class="overall-score-row">
        <span class="eyebrow">Overall score</span>
        <strong class="overall-num">${overall}%</strong>
      </div>` : ""}
    <div class="score-rows">
      ${sections.map(s => {
        const score = state.scores[s.key];
        const started = score !== null;
        return `
          <button class="score-row" data-view="${s.key}">
            <span class="section-dot-sm ${started ? "done" : "idle"}">${s.icon}</span>
            <span class="score-label">${s.label}</span>
            <span class="score-val ${started ? "scored" : "pending"}">${started ? score + "%" : "Not started"}</span>
            <svg class="score-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
          </button>`;
      }).join("")}
    </div>
  `;
}

function renderAll() {
  loadScores();
  renderGrammar();
  renderReading();
  renderWriting();
  renderSpeaking();
  renderDashboardStatus();
}

function renderEmptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function hasGrammarContent() {
  return Array.isArray(state.grammar) && state.grammar.length > 0;
}

function hasReadingContent() {
  return Boolean(state.reading.passage.trim()) && Array.isArray(state.reading.questions) && state.reading.questions.length > 0;
}

function hasWritingContent() {
  return Boolean(state.writing.prompt.trim());
}

function hasSpeakingContent() {
  return Boolean(state.speaking.prompt.trim());
}

function renderGrammar() {
  const submitButton = $("#submitGrammarButton");
  const resetButton = $("#resetGrammarButton");
  $("#grammarResult").hidden = true;

  if (!hasGrammarContent()) {
    $("#grammarQuestions").innerHTML = renderEmptyState("Admin hali grammar savollarini kiritmagan.");
    submitButton.disabled = true;
    resetButton.disabled = true;
    return;
  }

  submitButton.disabled = false;
  resetButton.disabled = false;
  const letters = ["A", "B", "C", "D"];
  $("#grammarQuestions").innerHTML = state.grammar.map((item, index) => {
    const options = item.options.map((option, oi) => `
      <button class="opt-btn" type="button" data-group="g${index}" data-value="${escapeAttr(option)}">
        <span class="opt-letter">${letters[oi] || oi + 1}</span>
        <span class="opt-text">${escapeHtml(option)}</span>
      </button>`).join("");
    return `
      <article class="question-card">
        <div class="q-number">Q${index + 1}</div>
        <p class="q-text">${escapeHtml(item.question)}</p>
        <div class="opt-group">${options}</div>
      </article>`;
  }).join("");

  bindOptionButtons();
}

function submitGrammar() {
  if (!hasGrammarContent()) {
    toast("Grammar bo'limi hali admin tomonidan kiritilmagan.", "error");
    return;
  }
  stopSectionTimer();
  const answers = state.grammar.map((_, i) => {
    const sel = $(`.opt-btn.selected[data-group="g${i}"]`);
    return sel ? sel.dataset.value : "";
  });
  const correct = answers.filter((a, i) => a === state.grammar[i].answer).length;
  const score = Math.round((correct / state.grammar.length) * 100);
  saveScore("grammar", score);
  saveUserResult("grammar", score, answers);

  $("#grammarResult").hidden = false;
  $("#grammarResult").innerHTML = `
    <span class="eyebrow">Grammar result</span>
    <h3>${score}% — ${correct} of ${state.grammar.length} correct</h3>
    <div class="result-grid">
      ${state.grammar.map((item, i) => {
        const ok = answers[i] === item.answer;
        return metricCard(`Q${i + 1}`, ok ? "Correct ✓" : "Wrong ✗", ok ? item.explanation : `Correct: ${item.answer}`);
      }).join("")}
    </div>`;
  $("#grammarResult").scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetGrammar() {
  if (!hasGrammarContent()) return;
  $$(".opt-btn[data-group^='g']").forEach(b => b.classList.remove("selected"));
  $("#grammarResult").hidden = true;
  startSectionTimer("grammar");
}

function renderReading() {
  const submitButton = $("#submitReadingButton");
  const resetButton = $("#resetReadingButton");
  $("#readingResult").hidden = true;

  $("#readingTitle").textContent = state.reading.title || "Reading Passage";
  if (!hasReadingContent()) {
    $("#readingPassage").innerHTML = renderEmptyState("Admin hali reading matni va savollarini kiritmagan.");
    $("#readingQuestions").innerHTML = "";
    submitButton.disabled = true;
    resetButton.disabled = true;
    return;
  }

  submitButton.disabled = false;
  resetButton.disabled = false;
  $("#readingPassage").innerHTML = state.reading.passage
    .split("\n")
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");

  const letters = ["A", "B", "C", "D"];
  $("#readingQuestions").innerHTML = state.reading.questions.map((item, index) => {
    const options = item.options.map((option, oi) => `
      <button class="opt-btn" type="button" data-group="r${index}" data-value="${escapeAttr(option)}">
        <span class="opt-letter">${letters[oi] || oi + 1}</span>
        <span class="opt-text">${escapeHtml(option)}</span>
      </button>`).join("");
    return `
      <article class="question-card">
        <div class="q-number">Q${index + 1}</div>
        <p class="q-text">${escapeHtml(item.question)}</p>
        <div class="opt-group">${options}</div>
      </article>`;
  }).join("");

  bindOptionButtons();
}

function submitReading() {
  if (!hasReadingContent()) {
    toast("Reading bo'limi hali admin tomonidan kiritilmagan.", "error");
    return;
  }
  stopSectionTimer();
  const answers = state.reading.questions.map((_, i) => {
    const sel = $(`.opt-btn.selected[data-group="r${i}"]`);
    return sel ? sel.dataset.value : "";
  });
  const correct = answers.filter((a, i) => a === state.reading.questions[i].answer).length;
  const score = Math.round((correct / state.reading.questions.length) * 100);
  saveScore("reading", score);
  saveUserResult("reading", score, answers);

  $("#readingResult").hidden = false;
  $("#readingResult").innerHTML = `
    <span class="eyebrow">Reading result</span>
    <h3>${score}% — ${correct} of ${state.reading.questions.length} correct</h3>
    <div class="result-grid">
      ${state.reading.questions.map((item, i) => {
        const ok = answers[i] === item.answer;
        return metricCard(`Q${i + 1}`, ok ? "Correct ✓" : "Wrong ✗", `Answer: ${item.answer}`);
      }).join("")}
    </div>`;
  $("#readingResult").scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetReading() {
  if (!hasReadingContent()) return;
  $$(".opt-btn[data-group^='r']").forEach(b => b.classList.remove("selected"));
  $("#readingResult").hidden = true;
  startSectionTimer("reading");
}

function renderWriting() {
  $("#writingTaskTitle").textContent = state.writing.title || "Writing Task";
  $("#writingPrompt").textContent = state.writing.prompt || "Admin hali writing mavzusini kiritmagan.";
  $("#submitWritingButton").disabled = !hasWritingContent();
}

function updateWordCount() {
  const count = wordCount($("#writingText").value);
  $("#wordCounter").textContent = `${count} ${count === 1 ? "word" : "words"}`;
}

function clearWriting() {
  $("#writingText").value = "";
  $("#writingResult").hidden = true;
  updateWordCount();
}

async function submitWriting() {
  if (!hasWritingContent()) {
    toast("Writing mavzusi hali admin tomonidan kiritilmagan.", "error");
    return;
  }
  const text = $("#writingText").value.trim();
  if (wordCount(text) < 100) {
    toast("Write at least 100 words before evaluation.", "error");
    return;
  }

  const button = $("#submitWritingButton");
  button.disabled = true;
  button.textContent = "Evaluating...";

  try {
    const result = await apiPost("/api/writing-check", {
      text,
      taskType: state.writing.title,
      prompt: state.writing.prompt
    });
    renderWritingResult(result, false);
  } catch (error) {
    renderWritingResult(localWritingPreview(text), true);
    toast("AI endpoint is unavailable, so the UI is showing preview feedback.", "error");
  } finally {
    button.disabled = false;
    button.textContent = "Evaluate writing";
  }
}

function renderWritingResult(data, preview) {
  saveScore("writing", data.overallScore);
  saveUserResult("writing", data.overallScore, null);
  $("#writingResult").hidden = false;
  $("#writingResult").innerHTML = `
    <span class="eyebrow">${preview ? "Preview feedback" : "AI feedback"}</span>
    <h3>${data.overallScore}% overall ${data.band ? `- ${escapeHtml(data.band)}` : ""}</h3>
    <p>${escapeHtml(data.summary || "")}</p>
    <div class="result-grid">
      ${metricCard("Task", data.taskAchievement?.score ?? 0, data.taskAchievement?.feedback ?? "")}
      ${metricCard("Coherence", data.coherence?.score ?? 0, data.coherence?.feedback ?? "")}
      ${metricCard("Vocabulary", data.lexicalResource?.score ?? 0, data.lexicalResource?.feedback ?? "")}
      ${metricCard("Grammar", data.grammaticalRange?.score ?? 0, data.grammaticalRange?.feedback ?? "")}
    </div>
    <ul class="feedback-list">
      ${(data.improvements || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
    </ul>
  `;
  $("#writingResult").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderSpeaking() {
  $("#speakingPromptTitle").textContent = state.speaking.title || "Speaking Prompt";
  $("#speakingPrompt").textContent = state.speaking.prompt || "Admin hali speaking mavzusini kiritmagan.";
  $("#speakingPoints").innerHTML = state.speaking.points
    .map((point) => `<div class="point-item">${escapeHtml(point)}</div>`)
    .join("");
  $("#resetSpeakingButton").disabled = !hasSpeakingContent();
  $("#submitSpeakingButton").disabled = !hasSpeakingContent();
}

function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  const recognition = new SR();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let interimText = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0]?.transcript || "";
      if (event.results[i].isFinal) {
        state.speakingTranscriptFinal = `${state.speakingTranscriptFinal} ${transcript}`.trim();
      } else {
        interimText += transcript;
      }
    }

    const nextText = `${state.speakingTranscriptFinal} ${interimText}`.trim();
    $("#speakingTranscript").value = nextText;
    $("#speakingStatus").textContent = nextText ? "Recording in progress. Review the transcript after you stop." : "Listening...";
  };

  recognition.onerror = (event) => {
    toast(`Microphone error: ${event.error || "unknown error"}`, "error");
    stopRecordingUi(true);
  };

  recognition.onend = () => {
    if (!state.recording) return;
    try {
      recognition.start();
    } catch (_) {
      stopRecordingUi(true);
    }
  };

  state.speechRecognition = recognition;
}

function toggleRecordingUi() {
  if (state.recording) {
    stopRecordingUi();
    return;
  }

  state.recording = true;
  state.speakingTranscriptFinal = $("#speakingTranscript").value.trim();
  $(".recorder-panel").classList.add("recording");
  $("#recordButton").textContent = "Stop recording";
  $("#speakingStatus").textContent = "Listening...";
  state.recordStartedAt = Date.now();
  clearInterval(state.recordInterval);
  state.recordInterval = setInterval(updateRecordingTime, 500);

  if (!state.speechRecognition) {
    $("#speakingStatus").textContent = "Speech recognition is not available. Type your answer below.";
    return;
  }

  try {
    state.speechRecognition.start();
  } catch (_) {
    stopRecordingUi(true);
    toast("Could not start microphone capture.", "error");
  }
}

function stopRecordingUi(fromError = false) {
  state.recording = false;
  $(".recorder-panel").classList.remove("recording");
  $("#recordButton").textContent = "Start recording";
  clearInterval(state.recordInterval);
  state.recordInterval = null;

  if (state.speechRecognition) {
    try {
      state.speechRecognition.stop();
    } catch (_) {
      // No-op
    }
  }

  if (fromError) return;

  $("#speakingStatus").textContent = $("#speakingTranscript").value.trim()
    ? "Recording stopped. You can review and submit."
    : "No transcript captured. You can try again or type your answer.";
}

function updateRecordingTime() {
  const seconds = Math.floor((Date.now() - state.recordStartedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  $("#recordingTime").textContent = `${minutes}:${rest}`;
}

function resetSpeaking() {
  if (!hasSpeakingContent()) return;
  $("#speakingTranscript").value = "";
  $("#speakingResult").hidden = true;
}

async function submitSpeaking() {
  if (!hasSpeakingContent()) {
    toast("Speaking mavzusi hali admin tomonidan kiritilmagan.", "error");
    return;
  }
  const transcript = $("#speakingTranscript").value.trim();
  if (wordCount(transcript) < 20) {
    toast("Speak or type at least 20 words before evaluation.", "error");
    return;
  }

  const button = $("#submitSpeakingButton");
  button.disabled = true;
  button.textContent = "Evaluating...";

  try {
    const aiStatus = await fetchAiStatus();
    if (!aiStatus.ok) {
      throw new Error(aiStatus.message || "Speaking AI is not configured.");
    }

    const duration = wordCount(transcript);
    const result = await apiPost("/api/speaking-evaluate", {
      transcript,
      prompt: state.speaking.prompt,
      duration
    });
    renderSpeakingResult(result);
  } catch (error) {
    toast(error.message || "Speaking evaluation failed.", "error");
  } finally {
    button.disabled = false;
    button.textContent = "Evaluate speaking";
  }
}

function renderSpeakingResult(data) {
  saveScore("speaking", data.overallScore);
  saveUserResult("speaking", data.overallScore, null);

  $("#speakingResult").hidden = false;
  $("#speakingResult").innerHTML = `
    <span class="eyebrow">Speaking result</span>
    <h3>${data.overallScore}% ${data.band ? `- ${escapeHtml(data.band)}` : ""}</h3>
    <p>Your speaking section has been rated. Detailed rubric is hidden in student mode.</p>
  `;
  $("#speakingResult").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function fetchAiStatus() {
  const response = await fetch("/api/ai-status");
  if (!response.ok) {
    throw new Error("Could not check AI status.");
  }
  return response.json();
}

async function apiPost(endpoint, body) {
  const headers = { "Content-Type": "application/json" };
  if (state.auth?.currentUser) {
    headers.Authorization = `Bearer ${await state.auth.currentUser.getIdToken()}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || error.error || "Request failed");
  }

  return response.json();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Request failed");
  return response.json();
}

function localWritingPreview(text) {
  const words = wordCount(text);
  const score = Math.max(45, Math.min(88, 52 + Math.round(words / 12)));
  return {
    overallScore: score,
    band: score >= 80 ? "Band 7.5" : score >= 65 ? "Band 6.5" : "Band 5.5",
    summary: "The response has enough structure for review. Connect the AI endpoint for full examiner feedback.",
    taskAchievement: { score, feedback: "Addresses the topic with a visible opinion." },
    coherence: { score: Math.max(45, score - 4), feedback: "Paragraphing and linking can be developed further." },
    lexicalResource: { score: Math.min(90, score + 2), feedback: "Vocabulary range is suitable for a draft answer." },
    grammaticalRange: { score: Math.max(42, score - 6), feedback: "Check sentence control and punctuation." },
    improvements: ["Add clearer examples.", "Use topic-specific vocabulary.", "Check verb forms before submission."]
  };
}

function metricCard(label, value, note) {
  return `
    <div class="metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
      <span>${escapeHtml(note || "")}</span>
    </div>
  `;
}

function authMessage(error) {
  const code = error?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "Email or password is incorrect.";
  }
  if (code.includes("too-many-requests")) {
    return "Too many attempts. Try again later.";
  }
  return "Login failed. Check Firebase Auth settings and try again.";
}

function wordCount(value) {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

function initials(value) {
  return value
    .split("@")[0]
    .split(/[.\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "U";
}

function toast(message, type = "info") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  $("#toastHost").appendChild(item);
  setTimeout(() => item.remove(), 3800);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
